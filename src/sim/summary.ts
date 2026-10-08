import type { Message, Tick, TripId } from "../shared/messages.ts";
import { fareOf } from "../shared/surge.ts";
import { createInvariantChecker, type Violation } from "./invariants.ts";
import type { RunConfig, RunResult } from "./run.ts";

export type Summary = {
	seed: number;
	ticks: number;
	drivers: number;
	trips: { requested: number; completed: number; cancelled: number };
	spike: { declined: number; revenue: number; surgedRequests: number; meanQuoted: number; zoneUpdates: number; surgingZoneEntries: number };
	// null when no trip was picked up.
	meanTicksToPickup: number | null;
	rejectedInputs: number;
	violations: Violation[];
};

export function summarize(
	config: RunConfig,
	result: { eventLog: readonly Message[]; rejected: RunResult["rejected"] },
): Summary {
	const summary = createSummary(config);
	for (const message of result.eventLog) summary.observe(message);
	return summary.result(result.rejected.length);
}

export type RunSummary = {
	observe(message: Message): void;
	// The summary of the messages observed so far.
	result(rejectedInputs: number): Summary;
};

// Summarizes a run as it happens (ADR 0033): memory grows with trips, not
// with messages.
export function createSummary(config: RunConfig): RunSummary {
	const tripSummary = createTripSummary();
	const checker = createInvariantChecker(config.grid);
	const { count, driversPerShard } = config.driverShards;
	return {
		observe: (message) => {
			checker.observe(message);
			tripSummary.observe(message);
		},
		result: (rejectedInputs) => ({
			seed: config.seed,
			ticks: config.ticks,
			drivers: count * driversPerShard,
			...tripSummary.result(),
			rejectedInputs,
			violations: checker.violations(),
		}),
	};
}

export type TripSummary = Pick<Summary, "trips" | "meanTicksToPickup" | "spike">;

// The summary's trip numbers alone, for event logs without a RunConfig
// (stored runs, ADR 0034). Memory grows with trips, not with messages.
export function createTripSummary(): {
	observe(message: Message): void;
	result(): TripSummary;
} {
	const trips = { requested: 0, completed: 0, cancelled: 0 };
	const requestedAt = new Map<TripId, Tick>();
	const fares = new Map<TripId, number>();
	const spike = { declined: 0, revenue: 0, surgedRequests: 0, meanQuoted: 0, zoneUpdates: 0, surgingZoneEntries: 0 };
	let quotedSum = 0;
	let pickups = 0;
	let ticksToPickup = 0;
	return {
		observe: (message) => {
			switch (message.type) {
				case "trip.requested":
					trips.requested++;
					requestedAt.set(message.tripId, message.tick);
					fares.set(message.tripId, fareOf(message.pickup, message.dropoff, message.surge ?? 1));
					quotedSum += message.surge ?? 1;
					if ((message.surge ?? 1) > 1) spike.surgedRequests++;
					break;
				case "rider.declined_surge":
					spike.declined++;
					break;
				case "zones.priced":
					spike.zoneUpdates++;
					spike.surgingZoneEntries += message.zones.length;
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
					spike.revenue += fares.get(message.tripId) ?? 0;
					break;
				case "trip.cancelled":
					trips.cancelled++;
					break;
			}
		},
		result: () => ({
			trips: { ...trips },
			spike: { ...spike, meanQuoted: trips.requested === 0 ? 0 : quotedSum / trips.requested },
			meanTicksToPickup: pickups === 0 ? null : ticksToPickup / pickups,
		}),
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
