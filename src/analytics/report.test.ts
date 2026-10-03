import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	type ClickHouse,
	connectClickHouse,
	type EventRow,
	migrate,
} from "../persistence/clickhouse.ts";
import { toRow } from "../persister/rows.ts";
import { isSimEvent, RunId, Tick } from "../shared/messages.ts";
import { parseClickHouseConfig } from "../sim/config.ts";
import { runInProcess } from "../sim/run.ts";
import { summarize } from "../sim/summary.ts";
import { listRuns, runReport } from "./report.ts";

// Needs ClickHouse (CLICKHOUSE_* from .env or the environment); skipped
// otherwise. Works in a throwaway database, one run id per test.
const config = Bun.env.CLICKHOUSE_URL ? parseClickHouseConfig(Bun.env) : null;
if (!config) {
	console.warn("CLICKHOUSE_URL unset: skipping run report tests");
}

describe.skipIf(!config)("run report", () => {
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

	test("listRuns lists each run's tick span and event count", async () => {
		await succeeded(
			clickhouse.insertEvents([
				row("list-a", "driver.moved", 0, 1),
				row("list-a", "driver.moved", 9, 2),
				row("list-b", "clock.ticked", 3, 3),
				// Redelivery of the same stream message: counted once.
				row("list-b", "clock.ticked", 3, 3),
			]),
		);

		const runs = await succeeded(listRuns(clickhouse));

		// Other tests' runs share the database.
		expect(runs.filter((run) => run.runId.startsWith("list-"))).toEqual([
			{
				runId: RunId.parse("list-a"),
				firstTick: Tick.parse(0),
				lastTick: Tick.parse(9),
				events: 2,
			},
			{
				runId: RunId.parse("list-b"),
				firstTick: Tick.parse(3),
				lastTick: Tick.parse(3),
				events: 1,
			},
		]);
	});

	// Oracle: summarize over the same event log. Three drivers, more requests
	// than they serve: trips get completed and cancelled.
	test("runReport agrees with the in-memory summary of the same run", async () => {
		const runConfig = {
			seed: 1,
			ticks: 1200,
			grid: { width: 20, height: 20 },
			driverShards: { count: 1, driversPerShard: 3 },
			requestsPerMinute: 30,
		};
		const result = runInProcess(runConfig);
		const runId = RunId.parse("cross-check");
		const ingestedAt = new Date("2026-10-03T12:00:00Z");
		await succeeded(
			clickhouse.insertEvents(
				result.eventLog
					.filter(isSimEvent)
					.map((event, index) =>
						toRow(event, { runId, streamSeq: index + 1, ingestedAt }),
					),
			),
		);
		const summary = summarize(runConfig, result);

		const report = await succeeded(runReport(clickhouse, runId));

		expect({
			trips: report.trips,
			meanTicksToPickup: report.meanTicksToPickup,
		}).toEqual({
			trips: summary.trips,
			meanTicksToPickup: summary.meanTicksToPickup,
		});
	});

	// Two trips take 30 and 50 ticks from pickup to completion; one is
	// cancelled. Events span ticks 0-120, 2 simulated minutes.
	test("runReport gives mean trip ticks and completed trips per simulated minute", async () => {
		const run = "duration";
		await succeeded(
			clickhouse.insertEvents([
				row(run, "driver.went_online", 0, 1),
				row(run, "trip.requested", 0, 2, "t-1"),
				row(run, "trip.requested", 5, 3, "t-2"),
				row(run, "trip.requested", 6, 4, "t-3"),
				row(run, "trip.cancelled", 8, 5, "t-3"),
				row(run, "trip.picked_up", 10, 6, "t-1"),
				row(run, "trip.picked_up", 20, 7, "t-2"),
				row(run, "trip.completed", 40, 8, "t-1"),
				row(run, "trip.completed", 70, 9, "t-2"),
				row(run, "driver.moved", 120, 10),
			]),
		);

		const report = await succeeded(runReport(clickhouse, RunId.parse(run)));

		expect({
			meanTripTicks: report.meanTripTicks,
			completedPerMinute: report.completedPerMinute,
		}).toEqual({ meanTripTicks: 40, completedPerMinute: 1 });
	});

	test("runReport of a run with no events is an unknown run", async () => {
		const runId = RunId.parse("no-such-run");

		expect(await runReport(clickhouse, runId)).toEqual({
			ok: false,
			error: { type: "unknown_run", runId },
		});
	});
});

function row(
	runId: string,
	type: string,
	tick: number,
	streamSeq: number,
	tripId = "",
): EventRow {
	return {
		runId: RunId.parse(runId),
		type,
		tick: Tick.parse(tick),
		streamSeq,
		tripId,
		driverId: "",
		riderId: "",
		payload: "{}",
		ingestedAt: new Date("2026-10-03T12:00:00Z"),
	};
}

async function succeeded<T>(
	pending: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>,
): Promise<T> {
	const result = await pending;
	if (!result.ok) throw new Error("ClickHouse call failed", { cause: result });
	return result.value;
}
