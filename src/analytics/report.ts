// Per-run analytics over the events table (ADR 0029). Queries use FINAL so
// redelivered events count once.
import * as z from "zod";
import type { ClickHouse, ClickHouseError } from "../persistence/clickhouse.ts";
import { RunId, Tick } from "../shared/messages.ts";
import type { Result } from "../shared/result.ts";

const PersistedRun = z.object({
	runId: RunId,
	firstTick: Tick,
	lastTick: Tick,
	events: z.int().positive(),
});
export type PersistedRun = z.infer<typeof PersistedRun>;

const count = z.int().nonnegative();
const ReportRow = z.object({
	events: count,
	firstTick: count,
	lastTick: count,
	requested: count,
	completed: count,
	cancelled: count,
	pickedUpTrips: count,
	ticksToPickup: count,
	finishedTrips: count,
	tripTicks: count,
	pricings: count,
	declined: count,
	revenue: count,
	pooled: count,
});

export type RunReport = {
	trips: { requested: number; completed: number; cancelled: number };
	// null when no trip was picked up.
	meanTicksToPickup: number | null;
	// Pickup to completion; null when no trip was completed.
	meanTripTicks: number | null;
	// Over the run's tick span (first to last event); null when it spans no
	// tick.
	completedPerMinute: number | null;
	// Surge runs only (any zones.priced, ADR 0054): riders declined, and
	// revenue in cents, the fares of completed trips; null with surge off.
	surge: { declined: number; revenue: number } | null;
	// Trips whose rider opted in to pooling (ADR 0056); 0 with pooling off.
	pooled: number;
};

export type RunReportError =
	| ClickHouseError
	| { type: "unknown_run"; runId: RunId };

// `bun run report`'s exit code for a failure: 1 not found, 3 infra
// unreachable or failed, like `bun run replay` and `bun run sim`.
export function reportExitCode(error: RunReportError): 1 | 3 {
	switch (error.type) {
		case "unknown_run":
			return 1;
		case "clickhouse_connect_failed":
		case "clickhouse_request_failed":
			return 3;
		default: {
			const unhandled: never = error;
			throw new Error(`unhandled report error: ${unhandled}`);
		}
	}
}

export async function runReport(
	clickhouse: Pick<ClickHouse, "query">,
	runId: RunId,
): Promise<Result<RunReport, RunReportError>> {
	// Inner query: one row per trip (plus one for events without a trip:
	// prices, declines). Revenue sums the events' fares (surge runs only).
	// Durations count trips with both ends, like summarize.
	const rows = await clickhouse.query(
		`SELECT
			toUInt32(sum(events)) AS events,
			min(firstTickOfTrip) AS firstTick,
			max(lastTickOfTrip) AS lastTick,
			toUInt32(sum(requests)) AS requested,
			toUInt32(sum(completions)) AS completed,
			toUInt32(sum(cancellations)) AS cancelled,
			toUInt32(countIf(requests > 0 AND pickups > 0)) AS pickedUpTrips,
			toFloat64(sumIf(pickedUpAt - requestedAt, requests > 0 AND pickups > 0))
				AS ticksToPickup,
			toUInt32(countIf(pickups > 0 AND completions > 0)) AS finishedTrips,
			toFloat64(sumIf(completedAt - pickedUpAt, pickups > 0 AND completions > 0))
				AS tripTicks,
			toUInt32(sum(pricings)) AS pricings,
			toUInt32(sum(declines)) AS declined,
			toFloat64(sumIf(fare, requests > 0 AND completions > 0)) AS revenue,
			toUInt32(sum(pooledRequests)) AS pooled
		FROM (
			SELECT
				count() AS events,
				min(tick) AS firstTickOfTrip,
				max(tick) AS lastTickOfTrip,
				countIf(type = 'trip.requested') AS requests,
				countIf(type = 'trip.picked_up') AS pickups,
				countIf(type = 'trip.completed') AS completions,
				countIf(type = 'trip.cancelled') AS cancellations,
				toInt64(minIf(tick, type = 'trip.requested')) AS requestedAt,
				toInt64(minIf(tick, type = 'trip.picked_up')) AS pickedUpAt,
				toInt64(minIf(tick, type = 'trip.completed')) AS completedAt,
				countIf(type = 'zones.priced') AS pricings,
				countIf(type = 'rider.declined_surge') AS declines,
				sumIf(JSONExtractUInt(payload, 'fare'), type = 'trip.requested')
					AS fare,
				countIf(type = 'trip.requested' AND JSONExtractBool(payload, 'pooled'))
					AS pooledRequests
			FROM events FINAL
			WHERE run_id = {runId:String}
			GROUP BY trip_id
		)`,
		{ runId },
	);
	if (!rows.ok) return rows;
	// Aggregates without GROUP BY: one row, all zero for an unknown run.
	const [row] = z.tuple([ReportRow]).parse(rows.value);
	if (row.events === 0) {
		return { ok: false, error: { type: "unknown_run", runId } };
	}
	// 1 tick = 1 simulated second.
	const minutes = (row.lastTick - row.firstTick) / 60;
	return {
		ok: true,
		value: {
			trips: {
				requested: row.requested,
				completed: row.completed,
				cancelled: row.cancelled,
			},
			meanTicksToPickup: ratio(row.ticksToPickup, row.pickedUpTrips),
			meanTripTicks: ratio(row.tripTicks, row.finishedTrips),
			completedPerMinute: ratio(row.completed, minutes),
			surge:
				row.pricings === 0
					? null
					: { declined: row.declined, revenue: row.revenue },
			pooled: row.pooled,
		},
	};
}

function ratio(total: number, over: number): number | null {
	return over === 0 ? null : total / over;
}

// Oldest run first, so the newest ends up next to the prompt.
export async function listRuns(
	clickhouse: Pick<ClickHouse, "query">,
): Promise<Result<PersistedRun[], ClickHouseError>> {
	const rows = await clickhouse.query(
		`SELECT run_id AS runId, min(tick) AS firstTick, max(tick) AS lastTick,
			toUInt32(count()) AS events
		FROM events FINAL
		GROUP BY run_id
		ORDER BY min(ingested_at), run_id`,
	);
	if (!rows.ok) return rows;
	// Our own query: a row that doesn't parse is a bug.
	return { ok: true, value: z.array(PersistedRun).parse(rows.value) };
}
