import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { jetstreamManager } from "@nats-io/jetstream";
import {
	connect,
	type Msg,
	type NatsConnection,
} from "@nats-io/transport-node";
import * as z from "zod";
import {
	type ClickHouse,
	connectClickHouse,
	migrate,
} from "../persistence/clickhouse.ts";
import { startPersister } from "../persister/persister.ts";
import { toRow } from "../persister/rows.ts";
import { DriverIndex } from "../shared/fleet.ts";
import { Cell } from "../shared/grid.ts";
import {
	driversMoved,
	isSimEvent,
	parseMessage,
	RiderId,
	RunId,
	type SimEvent,
	Tick,
	TripId,
} from "../shared/messages.ts";
import { Region } from "../shared/regions.ts";
import { parseClickHouseConfig } from "../sim/config.ts";
import { runOverNats } from "../sim/run.ts";
import { subscriptionFor } from "../ui/subscription.ts";
import { applyEvent, emptyView, type View } from "../ui/view.ts";

// Runs `bun run replay`'s entrypoint against the local NATS and ClickHouse
// (URLs from .env or the environment); skipped without them. Stored events
// live in a throwaway database, one run id per test.
const natsUrl = z.url().optional().parse(Bun.env.NATS_URL);
const config = Bun.env.CLICKHOUSE_URL ? parseClickHouseConfig(Bun.env) : null;
if (!natsUrl || !config) {
	console.warn("NATS_URL or CLICKHOUSE_URL unset: skipping replay tests");
}

describe.skipIf(!natsUrl || !config)("bun run replay", () => {
	const testDatabase = `test_${crypto.randomUUID().replaceAll("-", "")}`;
	let admin: ClickHouse;
	let clickhouse: ClickHouse;
	let nats: NatsConnection;

	beforeAll(async () => {
		if (!config?.ok) throw new Error("invalid ClickHouse config");
		admin = await succeeded(connectClickHouse(config.value));
		await succeeded(admin.command(`CREATE DATABASE ${testDatabase}`));
		clickhouse = await succeeded(
			connectClickHouse({ ...config.value, database: testDatabase }),
		);
		await succeeded(migrate(clickhouse));
		nats = await connect({ servers: natsUrl });
	});

	afterAll(async () => {
		await nats?.close();
		await clickhouse?.close();
		await admin?.command(`DROP DATABASE IF EXISTS ${testDatabase}`);
		await admin?.close();
	});

	test("republishes a stored run in order on its replay subjects, never on sim.>", async () => {
		const runId = RunId.parse(`replay-${crypto.randomUUID()}`);
		const run: SimEvent[] = [
			{ type: "clock.ticked", tick: Tick.parse(1) },
			moved(1, 0),
			requested(1),
			{ type: "clock.ticked", tick: Tick.parse(2) },
			moved(2, 1),
			{ type: "clock.ticked", tick: Tick.parse(4) },
		];
		await succeeded(
			clickhouse.insertEvents(
				run.map((event, index) =>
					toRow(event, {
						runId,
						streamSeq: index + 1,
						ingestedAt: new Date("2026-10-04T12:00:00Z"),
					}),
				),
			),
		);
		const replayed = collect(nats, `replay.${runId}.>`);
		const live = collect(nats, "sim.>");
		await nats.flush();

		const exitCode = await replay(["--run", runId, "--speed", "1000"]);
		// Replay drained its connection on exit: everything it published has
		// reached the server, so a round trip delivers it here.
		await nats.flush();

		expect({
			exitCode,
			replayed: replayed.messages,
			live: live.messages,
		}).toEqual({
			exitCode: 0,
			replayed: [
				[`replay.${runId}.sim.events.clock.ticked`, run[0]],
				[`replay.${runId}.sim.events.drivers.moved.region-0`, run[1]],
				[`replay.${runId}.sim.events.trip.requested`, run[2]],
				[`replay.${runId}.sim.events.clock.ticked`, run[3]],
				[`replay.${runId}.sim.events.drivers.moved.region-0`, run[4]],
				[`replay.${runId}.sim.events.clock.ticked`, run[5]],
			],
			live: [],
		});
	});

	// Issue #274: current event shapes (drivers.* batches by driver index,
	// regions) stored by the persister and replayed into the UI's view. Live
	// is what the page sees without ?replay. The persister reads a test
	// stream (SIM_EVENTS may belong to `bun run dev`), fed live's messages in
	// the order they arrived, as JetStream numbers SIM_EVENTS.
	test("a fresh run stored and replayed gives the UI the same view as live at chosen ticks", async () => {
		const config = {
			seed: 1,
			ticks: 300,
			grid: { width: 50, height: 50 },
			driverShards: { count: 2, driversPerShard: 10 },
			requestsPerMinute: 30,
			regions: { columns: 2, rows: 1 },
			// Short periods, so drivers go online mid-run too.
			shifts: {
				type: "shifts" as const,
				onlineTicks: { min: 40, max: 80 },
				offlineTicks: { min: 20, max: 40 },
				startOnlineShare: 0.5,
			},
		};
		const chosenTicks = [1, 100, 200, 300];
		const id = crypto.randomUUID().replaceAll("-", "");
		const source = {
			stream: `TEST_${id}`,
			subjects: `test-${id}.>`,
			consumer: "persister",
			ackWaitMs: 60_000,
		};
		const persister = await succeeded(
			startPersister({ nats, clickhouse, source, log: () => {} }),
		);
		try {
			const live = viewsAt(chosenTicks);
			const liveSubject = subscriptionFor("");
			if (!liveSubject.ok) throw new Error("no live subscription");
			const liveSubscription = nats.subscribe(liveSubject.value.subject, {
				callback: (error, message) => {
					if (error) throw error;
					live.apply(message);
					nats.publish(`test-${id}.${message.subject}`, message.data, {
						headers: message.headers,
					});
				},
			});
			await nats.flush();
			const run = await runOverNats({ ...config, url: natsUrl ?? "" });
			await nats.flush();
			liveSubscription.unsubscribe();
			if (!run.ok) throw new Error("NATS unavailable", { cause: run });
			await persisted(nats, source);

			const replaySubject = subscriptionFor(`?replay=${run.value.runId}`);
			if (!replaySubject.ok) throw new Error("no replay subscription");
			const replayed = viewsAt(chosenTicks);
			nats.subscribe(replaySubject.value.subject, {
				callback: (error, message) => {
					if (error) throw error;
					replayed.apply(message);
				},
			});
			await nats.flush();
			const exitCode = await replay([
				"--run",
				run.value.runId,
				"--speed",
				"1000",
			]);
			await nats.flush();

			expect({ exitCode, views: replayed.views() }).toEqual({
				exitCode: 0,
				views: live.views(),
			});
		} finally {
			persister.stop();
			await persister.stopped;
			await (await jetstreamManager(nats)).streams.delete(source.stream);
		}
	}, 60_000);

	test("an unknown run exits 1", async () => {
		expect(await replay(["--run", "no-such-run"])).toBe(1);
	});

	test("invalid args exit 2", async () => {
		expect(await replay(["--run", "r", "--speed", "0"])).toBe(2);
	});

	test("an unreachable NATS exits 3", async () => {
		expect(
			await replay(["--run", "r"], { NATS_URL: "nats://127.0.0.1:1" }),
		).toBe(3);
	});

	function replay(
		argv: string[],
		env: Record<string, string> = {},
	): Promise<number> {
		return Bun.spawn(["bun", "src/replay/main.ts", ...argv], {
			env: { ...Bun.env, CLICKHOUSE_DB: testDatabase, ...env },
			stdout: "ignore",
			stderr: "ignore",
		}).exited;
	}
});

// Driver 1 of a fleet of 10 (ADR 0052).
const fleetSize = 10;
const i1 = DriverIndex.parse(1);

function moved(tick: number, x: number): SimEvent {
	return driversMoved(Tick.parse(tick), Region.parse(0), fleetSize, [
		{ driverIndex: i1, cell: Cell.parse({ x, y: 0 }) },
	]);
}

function requested(tick: number): SimEvent {
	return {
		type: "trip.requested",
		tick: Tick.parse(tick),
		tripId: TripId.parse("t-1"),
		riderId: RiderId.parse("r-1"),
		pickup: Cell.parse({ x: 1, y: 1 }),
		dropoff: Cell.parse({ x: 2, y: 2 }),
	};
}

// The UI's view, fed each message as the page decodes it (src/ui/main.ts),
// copied at the end of each chosen tick (just before the next clock.ticked)
// and once everything is fed.
function viewsAt(ticks: number[]): {
	apply(message: Msg): void;
	views(): Map<number | "end", View>;
} {
	const view = emptyView();
	const taken = new Map<number | "end", View>();
	return {
		apply(message) {
			const parsed = parseMessage(message.json());
			if (!parsed.ok || !isSimEvent(parsed.value)) {
				throw new Error(`not an event on ${message.subject}`);
			}
			const event = parsed.value;
			if (event.type === "clock.ticked" && ticks.includes(event.tick - 1)) {
				taken.set(event.tick - 1, structuredClone(view));
			}
			applyEvent(view, event);
		},
		views() {
			return new Map([...taken, ["end", structuredClone(view)]]);
		},
	};
}

// The persister has stored and acked everything in its stream.
async function persisted(
	nats: NatsConnection,
	source: { stream: string; consumer: string },
): Promise<void> {
	const jsm = await jetstreamManager(nats);
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const info = await jsm.consumers.info(source.stream, source.consumer);
		if (info.num_pending === 0 && info.num_ack_pending === 0) return;
		await Bun.sleep(50);
	}
	throw new Error("persister not drained");
}

// Subjects and payloads received on `subject`, in arrival order.
function collect(
	nats: NatsConnection,
	subject: string,
): { messages: [string, unknown][] } {
	const messages: [string, unknown][] = [];
	nats.subscribe(subject, {
		callback: (error, message) => {
			if (error) throw error;
			messages.push([message.subject, message.json()]);
		},
	});
	return { messages };
}

async function succeeded<T>(
	pending: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>,
): Promise<T> {
	const result = await pending;
	if (!result.ok) throw new Error("ClickHouse call failed", { cause: result });
	return result.value;
}
