import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect, headers, type NatsConnection } from "@nats-io/transport-node";
import {
	type ClickHouse,
	connectClickHouse,
	type EventRow,
	migrate,
} from "../persistence/clickhouse.ts";
import { parseClickHouseConfig } from "../sim/config.ts";
import { type EventSource, startPersister } from "./persister.ts";

// Needs both servers (NATS with JetStream, ClickHouse); skipped otherwise.
// Each test reads its own stream on its own subjects and writes into one
// throwaway database, so the configured stream and database stay untouched.
const natsUrl = Bun.env.NATS_URL;
const clickhouseConfig = Bun.env.CLICKHOUSE_URL
	? parseClickHouseConfig(Bun.env)
	: null;
if (!natsUrl || !clickhouseConfig) {
	console.warn(
		"NATS_URL or CLICKHOUSE_URL unset: skipping persister integration tests",
	);
}

describe.skipIf(!natsUrl || !clickhouseConfig)("persister", () => {
	const testDatabase = `test_${crypto.randomUUID().replaceAll("-", "")}`;
	let admin: ClickHouse;
	let clickhouse: ClickHouse;
	const connections: NatsConnection[] = [];
	const streams: string[] = [];

	beforeAll(async () => {
		if (!clickhouseConfig?.ok) throw new Error("invalid ClickHouse config");
		admin = await succeeded(connectClickHouse(clickhouseConfig.value));
		await succeeded(admin.command(`CREATE DATABASE ${testDatabase}`));
		clickhouse = await succeeded(
			connectClickHouse({ ...clickhouseConfig.value, database: testDatabase }),
		);
		await succeeded(migrate(clickhouse));
	});

	afterAll(async () => {
		const jsm = await jetstreamManager(await natsConnection());
		for (const stream of streams) await jsm.streams.delete(stream);
		await Promise.all(connections.map((nc) => nc.close()));
		await clickhouse?.close();
		await admin?.command(`DROP DATABASE IF EXISTS ${testDatabase}`);
		await admin?.close();
	});

	// A fresh stream per test; deleted with its consumer afterwards.
	function testSource(ackWaitMs = 60_000): EventSource {
		const id = crypto.randomUUID().replaceAll("-", "");
		const source = {
			stream: `TEST_${id}`,
			subjects: `test-${id}.events.>`,
			consumer: "persister",
			ackWaitMs,
		};
		streams.push(source.stream);
		return source;
	}

	async function natsConnection(): Promise<NatsConnection> {
		const nc = await connect({ servers: natsUrl });
		connections.push(nc);
		return nc;
	}

	function publish(
		nc: NatsConnection,
		source: EventSource,
		payload: unknown,
		runId?: string,
	): void {
		const subject = source.subjects.replace(">", "event");
		const body =
			typeof payload === "string" ? payload : JSON.stringify(payload);
		const runHeaders = headers();
		if (runId !== undefined) runHeaders.set("Run-Id", runId);
		nc.publish(subject, body, { headers: runHeaders });
	}

	// The consumer has acked (or terminated) everything in the stream.
	async function drained(nc: NatsConnection, source: EventSource) {
		const jsm = await jetstreamManager(nc);
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const info = await jsm.consumers.info(source.stream, source.consumer);
			if (info.num_pending === 0 && info.num_ack_pending === 0) return;
			await Bun.sleep(50);
		}
		throw new Error("consumer not drained");
	}

	async function storedSeqs(runId: string): Promise<unknown[]> {
		return succeeded(
			clickhouse.query(
				`SELECT stream_seq FROM events FINAL
				WHERE run_id = {runId:String} ORDER BY stream_seq`,
				{ runId },
			),
		);
	}

	test("stores every event with its run id, header or not", async () => {
		const source = testSource();
		const nc = await natsConnection();
		const persister = await succeeded(
			startPersister({ nats: nc, clickhouse, source, log: () => {} }),
		);

		publish(nc, source, { type: "clock.ticked", tick: 1 }, "run-a");
		publish(
			nc,
			source,
			{
				type: "trip.requested",
				tick: 2,
				tripId: "t-1",
				riderId: "r-1",
				pickup: { x: 0, y: 0 },
				dropoff: { x: 1, y: 1 },
			},
			"run-a",
		);
		publish(nc, source, {
			type: "driver.moved",
			tick: 3,
			driverId: "d-1",
			cell: { x: 0, y: 1 },
		});
		publish(nc, source, "not json", "run-a");
		publish(nc, source, { type: "cancel_trip", tripId: "t-1" }, "run-a");
		await drained(nc, source);
		persister.stop();
		await persister.stopped;

		const rows = await clickhouse.query(
			`SELECT run_id, type, tick, stream_seq, trip_id, driver_id, rider_id
			FROM events FINAL WHERE run_id IN ('run-a', 'unknown')
			ORDER BY stream_seq`,
		);

		expect(rows).toEqual({
			ok: true,
			value: [
				{
					run_id: "run-a",
					type: "clock.ticked",
					tick: 1,
					stream_seq: 1,
					trip_id: "",
					driver_id: "",
					rider_id: "",
				},
				{
					run_id: "run-a",
					type: "trip.requested",
					tick: 2,
					stream_seq: 2,
					trip_id: "t-1",
					driver_id: "",
					rider_id: "r-1",
				},
				{
					run_id: "unknown",
					type: "driver.moved",
					tick: 3,
					stream_seq: 3,
					trip_id: "",
					driver_id: "d-1",
					rider_id: "",
				},
			],
		});
	}, 20_000);

	test("restarting after a crash between insert and ack loses and duplicates nothing", async () => {
		// Short ack wait, so the crashed batch is redelivered within the test,
		// but above the 1 s batch wait, so no message is redelivered while its
		// batch is still being fetched.
		const source = testSource(2000);
		const crashing = await natsConnection();
		let inserts = 0;
		const { promise: crashed, resolve: crash } = Promise.withResolvers<void>();
		const crashAfterPartialInsert: Pick<
			ClickHouse,
			"insertEvents" | "command"
		> = {
			command: clickhouse.command,
			async insertEvents(rows: EventRow[]) {
				inserts += 1;
				if (inserts === 1) return clickhouse.insertEvents(rows);
				// Second batch: half of it reaches ClickHouse, then the process
				// "dies": the insert never returns, so nothing is acked.
				await clickhouse.insertEvents(rows.slice(0, rows.length / 2));
				crash();
				return new Promise(() => {});
			},
		};
		await succeeded(
			startPersister({
				nats: crashing,
				clickhouse: crashAfterPartialInsert,
				source,
				log: () => {},
			}),
		);
		const tick = { type: "clock.ticked", tick: 1 };
		for (let i = 0; i < 4; i++) publish(crashing, source, tick, "run-b");
		await drained(crashing, source);
		for (let i = 0; i < 4; i++) publish(crashing, source, tick, "run-b");
		await crashed;
		await crashing.close();

		const nc = await natsConnection();
		const restarted = await succeeded(
			startPersister({ nats: nc, clickhouse, source, log: () => {} }),
		);
		await drained(nc, source);
		restarted.stop();
		await restarted.stopped;

		expect(await storedSeqs("run-b")).toEqual(
			[1, 2, 3, 4, 5, 6, 7, 8].map((seq) => ({ stream_seq: seq })),
		);
	}, 20_000);

	test("creates the events table on start", async () => {
		if (!clickhouseConfig?.ok) throw new Error("invalid ClickHouse config");
		const freshDatabase = `${testDatabase}_fresh`;
		await succeeded(admin.command(`CREATE DATABASE ${freshDatabase}`));
		const fresh = await succeeded(
			connectClickHouse({ ...clickhouseConfig.value, database: freshDatabase }),
		);
		const persister = await succeeded(
			startPersister({
				nats: await natsConnection(),
				clickhouse: fresh,
				source: testSource(),
				log: () => {},
			}),
		);
		persister.stop();
		await persister.stopped;

		const exists = await fresh.query("EXISTS TABLE events");
		await fresh.close();
		await admin.command(`DROP DATABASE ${freshDatabase}`);

		expect(exists).toEqual({ ok: true, value: [{ result: 1 }] });
	}, 20_000);

	test("a failed insert is logged and retried", async () => {
		const source = testSource();
		const nc = await natsConnection();
		let inserts = 0;
		const failingOnce: Pick<ClickHouse, "insertEvents" | "command"> = {
			command: clickhouse.command,
			insertEvents(rows: EventRow[]) {
				inserts += 1;
				if (inserts > 1) return clickhouse.insertEvents(rows);
				return Promise.resolve({
					ok: false,
					error: { type: "clickhouse_request_failed", cause: "down" },
				});
			},
		};
		const logged: string[] = [];
		const persister = await succeeded(
			startPersister({
				nats: nc,
				clickhouse: failingOnce,
				source,
				log: (entry) => {
					if (entry.type !== "rounds_timed") logged.push(entry.type);
				},
			}),
		);

		publish(nc, source, { type: "clock.ticked", tick: 1 }, "run-c");
		publish(nc, source, { type: "clock.ticked", tick: 2 }, "run-c");
		await drained(nc, source);
		persister.stop();
		await persister.stopped;

		expect({ seqs: await storedSeqs("run-c"), logged }).toEqual({
			seqs: [{ stream_seq: 1 }, { stream_seq: 2 }],
			logged: ["insert_failed"],
		});
	}, 20_000);

	test("a batch failing every retry is logged and left unacked", async () => {
		const source = testSource();
		const nc = await natsConnection();
		const alwaysFailing: Pick<ClickHouse, "insertEvents" | "command"> = {
			command: clickhouse.command,
			insertEvents: () =>
				Promise.resolve({
					ok: false,
					error: { type: "clickhouse_request_failed", cause: "down" },
				}),
		};
		const logged: string[] = [];
		const { promise: gaveUp, resolve: giveUp } = Promise.withResolvers<void>();
		const persister = await succeeded(
			startPersister({
				nats: nc,
				clickhouse: alwaysFailing,
				source,
				log: (entry) => {
					if (entry.type !== "rounds_timed") logged.push(entry.type);
					if (entry.type === "batch_not_persisted") giveUp();
				},
				retryDelaysMs: [0, 0],
			}),
		);

		publish(nc, source, { type: "clock.ticked", tick: 1 }, "run-d");
		await gaveUp;
		persister.stop();
		await persister.stopped;
		const jsm = await jetstreamManager(nc);
		const consumer = await jsm.consumers.info(source.stream, source.consumer);

		expect({ logged, unacked: consumer.num_ack_pending }).toEqual({
			logged: [
				"insert_failed",
				"insert_failed",
				"insert_failed",
				"batch_not_persisted",
			],
			unacked: 1,
		});
	}, 20_000);

	test("logs rounds, events, and per-phase ms every 10 s and on stop", async () => {
		const source = testSource();
		const nc = await natsConnection();
		// Controlled time: only inserts take any, 6 s each.
		let nowMs = 0;
		const slowInsert: Pick<ClickHouse, "insertEvents" | "command"> = {
			command: clickhouse.command,
			insertEvents() {
				nowMs += 6000;
				return Promise.resolve({ ok: true, value: undefined });
			},
		};
		const timed: unknown[] = [];
		const persister = await succeeded(
			startPersister({
				nats: nc,
				clickhouse: slowInsert,
				source,
				log: (entry) => {
					if (entry.type === "rounds_timed") timed.push(entry);
				},
				now: () => nowMs,
			}),
		);

		// One event per round: each is persisted before the next is published.
		for (let tick = 1; tick <= 3; tick++) {
			publish(nc, source, { type: "clock.ticked", tick }, "run-e");
			await drained(nc, source);
		}
		persister.stop();
		await persister.stopped;

		expect(timed).toEqual([
			{
				type: "rounds_timed",
				intervalMs: 12_000,
				rounds: 2,
				events: 2,
				fetchMs: 0,
				decodeMs: 0,
				insertMs: 12_000,
				ackMs: 0,
			},
			{
				type: "rounds_timed",
				intervalMs: 6000,
				rounds: 1,
				events: 1,
				fetchMs: 0,
				decodeMs: 0,
				insertMs: 6000,
				ackMs: 0,
			},
		]);
	}, 20_000);
});

async function succeeded<T>(
	pending: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>,
): Promise<T> {
	const result = await pending;
	if (!result.ok) throw new Error("call failed", { cause: result });
	return result.value;
}
