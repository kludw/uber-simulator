import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runReport } from "../analytics/report.ts";
import {
	type ClickHouse,
	connectClickHouse,
	type EventRow,
	migrate,
} from "../persistence/clickhouse.ts";
import { toRow } from "../persister/rows.ts";
import { Cell } from "../shared/grid.ts";
import {
	DriverId,
	isSimEvent,
	RunId,
	type SimEvent,
	Tick,
} from "../shared/messages.ts";
import { parseClickHouseConfig } from "../sim/config.ts";
import { createInvariantChecker } from "../sim/invariants.ts";
import { runInProcess } from "../sim/run.ts";
import { createTripSummary, summarize } from "../sim/summary.ts";
import {
	type ReadLogEntry,
	readRunEvents,
	type StoredEvent,
} from "./events.ts";

// Needs ClickHouse (CLICKHOUSE_* from .env or the environment); skipped
// otherwise. Works in a throwaway database, one run id per test.
const config = Bun.env.CLICKHOUSE_URL ? parseClickHouseConfig(Bun.env) : null;
if (!config) {
	console.warn("CLICKHOUSE_URL unset: skipping stored run tests");
}

describe.skipIf(!config)("readRunEvents", () => {
	const testDatabase = `test_${crypto.randomUUID().replaceAll("-", "")}`;
	let admin: ClickHouse;
	let clickhouse: ClickHouse;

	beforeAll(async () => {
		if (!config?.ok) throw new Error("invalid ClickHouse config");
		admin = await succeeded(connectClickHouse(config.value));
		await succeeded(admin.command(`CREATE DATABASE ${testDatabase}`));
		clickhouse = await succeeded(
			connectClickHouse({ ...config.value, database: testDatabase }),
		);
		await succeeded(migrate(clickhouse));
	});

	afterAll(async () => {
		await clickhouse?.close();
		await admin?.command(`DROP DATABASE IF EXISTS ${testDatabase}`);
		await admin?.close();
	});

	test("reads a run's events in tick, stream sequence order across pages", async () => {
		const runId = RunId.parse("ordered");
		await succeeded(
			clickhouse.insertEvents([
				row(runId, moved(2), 5),
				row(runId, moved(1), 2),
				row(runId, moved(1), 4),
				row(runId, moved(1), 3),
				row(runId, moved(0), 1),
				row(RunId.parse("other-run"), moved(0), 6),
			]),
		);

		// Pages of 2: the first page ends inside tick 1.
		const events = await readAll(clickhouse, runId, { pageSize: 2 });

		expect(events.map(({ tick, streamSeq }) => [tick, streamSeq])).toEqual([
			[0, 1],
			[1, 2],
			[1, 3],
			[1, 4],
			[2, 5],
		]);
	});

	test("reads a redelivered event once", async () => {
		const runId = RunId.parse("redelivered");
		// Separate inserts: duplicates within one insert collapse on write, so
		// only FINAL collapses these.
		await succeeded(clickhouse.insertEvents([row(runId, moved(0), 1)]));
		await succeeded(clickhouse.insertEvents([row(runId, moved(0), 1)]));

		const events = await readAll(clickhouse, runId, {});

		expect(events).toEqual([
			{ tick: Tick.parse(0), streamSeq: 1, message: moved(0) },
		]);
	});

	test("logs and skips an event whose payload doesn't parse", async () => {
		const runId = RunId.parse("unparseable");
		await succeeded(
			clickhouse.insertEvents([
				row(runId, moved(0), 1),
				{ ...row(runId, moved(1), 2), payload: "not json" },
				{ ...row(runId, moved(2), 3), payload: '{"type":"drivers.moved"}' },
				row(runId, moved(3), 4),
			]),
		);
		const logged: ReadLogEntry[] = [];

		const events = await readAll(clickhouse, runId, {}, (entry) =>
			logged.push(entry),
		);

		expect({
			read: events.map(({ streamSeq }) => streamSeq),
			skipped: logged.map((entry) => [entry.type, entry.streamSeq]),
		}).toEqual({
			read: [1, 4],
			skipped: [
				["stored_event_skipped", 2],
				["stored_event_skipped", 3],
			],
		});
	});

	test("reads from a tick on", async () => {
		const runId = RunId.parse("from-tick");
		await succeeded(
			clickhouse.insertEvents([
				row(runId, moved(0), 1),
				row(runId, moved(1), 2),
				row(runId, moved(2), 3),
			]),
		);

		const events = await readAll(clickhouse, runId, {
			fromTick: Tick.parse(1),
		});

		expect(events.map(({ streamSeq }) => streamSeq)).toEqual([2, 3]);
	});

	// Oracle: summarize and runReport over the same run. Three drivers, more
	// requests than they serve: trips get completed and cancelled.
	test("a stored run reads back with no violations and the same trip numbers", async () => {
		const runConfig = {
			seed: 1,
			ticks: 1200,
			grid: { width: 20, height: 20 },
			driverShards: { count: 1, driversPerShard: 3 },
			requestsPerMinute: 30,
		};
		const result = runInProcess({ ...runConfig, keepEventLog: true });
		const runId = RunId.parse("fidelity");
		await succeeded(
			clickhouse.insertEvents(
				result.eventLog
					.filter(isSimEvent)
					.map((event, index) => row(runId, event, index + 1)),
			),
		);
		const summary = summarize(runConfig, result);
		const report = await succeeded(runReport(clickhouse, runId));
		const checker = createInvariantChecker(runConfig.grid);
		const tripSummary = createTripSummary();

		for (const { message } of await readAll(clickhouse, runId, {
			pageSize: 1000,
		})) {
			checker.observe(message);
			tripSummary.observe(message);
		}

		expect({
			violations: checker.violations(),
			fromSummary: tripSummary.result(),
			fromReport: tripSummary.result(),
		}).toEqual({
			violations: [],
			fromSummary: {
				trips: summary.trips,
				meanTicksToPickup: summary.meanTicksToPickup,
			},
			fromReport: {
				trips: report.trips,
				meanTicksToPickup: report.meanTicksToPickup,
			},
		});
	});
});

const d1 = DriverId.parse("d-1");
const ingestedAt = new Date("2026-10-03T12:00:00Z");

function moved(tick: number): SimEvent {
	return {
		type: "drivers.moved",
		tick: Tick.parse(tick),
		moves: [{ driverId: d1, cell: Cell.parse({ x: tick, y: 0 }) }],
	};
}

function row(runId: RunId, event: SimEvent, streamSeq: number): EventRow {
	return toRow(event, { runId, streamSeq, ingestedAt });
}

async function readAll(
	clickhouse: ClickHouse,
	runId: RunId,
	options: Omit<Parameters<typeof readRunEvents>[2], "log">,
	log: Parameters<typeof readRunEvents>[2]["log"] = () => {},
): Promise<StoredEvent[]> {
	const events: StoredEvent[] = [];
	for await (const read of readRunEvents(clickhouse, runId, {
		...options,
		log,
	})) {
		if (!read.ok) throw new Error("read failed", { cause: read.error });
		events.push(read.value);
	}
	return events;
}

async function succeeded<T>(
	pending: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>,
): Promise<T> {
	const result = await pending;
	if (!result.ok) throw new Error("ClickHouse call failed", { cause: result });
	return result.value;
}
