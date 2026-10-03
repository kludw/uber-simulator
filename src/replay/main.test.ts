import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import * as z from "zod";
import {
	type ClickHouse,
	connectClickHouse,
	migrate,
} from "../persistence/clickhouse.ts";
import { toRow } from "../persister/rows.ts";
import { Cell } from "../shared/grid.ts";
import {
	DriverId,
	RiderId,
	RunId,
	type SimEvent,
	Tick,
	TripId,
} from "../shared/messages.ts";
import { parseClickHouseConfig } from "../sim/config.ts";

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
				[`replay.${runId}.sim.events.driver.moved`, run[1]],
				[`replay.${runId}.sim.events.trip.requested`, run[2]],
				[`replay.${runId}.sim.events.clock.ticked`, run[3]],
				[`replay.${runId}.sim.events.driver.moved`, run[4]],
				[`replay.${runId}.sim.events.clock.ticked`, run[5]],
			],
			live: [],
		});
	});

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

const d1 = DriverId.parse("d-1");

function moved(tick: number, x: number): SimEvent {
	return {
		type: "driver.moved",
		tick: Tick.parse(tick),
		driverId: d1,
		cell: Cell.parse({ x, y: 0 }),
	};
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
