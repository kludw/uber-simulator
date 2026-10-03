import type { Tick, TripId } from "../shared/messages.ts";
import { checkInvariants, type Violation } from "./invariants.ts";
import type { RunConfig, RunResult } from "./run.ts";

export type Summary = {
	seed: number;
	ticks: number;
	drivers: number;
	trips: { requested: number; completed: number; cancelled: number };
	// null when no trip was picked up.
	meanTicksToPickup: number | null;
	rejectedInputs: number;
	violations: Violation[];
};

export function summarize(config: RunConfig, result: RunResult): Summary {
	const trips = { requested: 0, completed: 0, cancelled: 0 };
	const requestedAt = new Map<TripId, Tick>();
	let pickups = 0;
	let ticksToPickup = 0;
	for (const message of result.eventLog) {
		switch (message.type) {
			case "trip.requested":
				trips.requested++;
				requestedAt.set(message.tripId, message.tick);
				break;
			case "trip.picked_up": {
				const at = requestedAt.get(message.tripId);
				if (at === undefined) break;
				pickups++;
				ticksToPickup += message.tick - at;
				break;
			}
			case "trip.completed":
				trips.completed++;
				break;
			case "trip.cancelled":
				trips.cancelled++;
				break;
		}
	}
	const { count, driversPerShard } = config.driverShards;
	return {
		seed: config.seed,
		ticks: config.ticks,
		drivers: count * driversPerShard,
		trips,
		meanTicksToPickup: pickups === 0 ? null : ticksToPickup / pickups,
		rejectedInputs: result.rejected.length,
		violations: checkInvariants(result.eventLog, config.grid),
	};
}

// One headline number of two runs on the same seed (ADR 0030), formatted.
export type ComparisonRow = { metric: string; greedy: string; batched: string };

export function compareSummaries(
	greedy: Summary,
	batched: Summary,
): ComparisonRow[] {
	const metrics: [string, (summary: Summary) => string][] = [
		["trips requested", (summary) => String(summary.trips.requested)],
		["trips completed", (summary) => String(summary.trips.completed)],
		["trips cancelled", (summary) => String(summary.trips.cancelled)],
		[
			"mean ticks from request to pickup",
			(summary) => summary.meanTicksToPickup?.toFixed(1) ?? "n/a",
		],
		["invariant violations", (summary) => String(summary.violations.length)],
	];
	return metrics.map(([metric, format]) => ({
		metric,
		greedy: format(greedy),
		batched: format(batched),
	}));
}
