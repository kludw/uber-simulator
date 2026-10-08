import type { Message, Tick, TripId } from "../shared/messages.ts";
import { type Fare, fareOf, Surge } from "../shared/surge.ts";
import { createInvariantChecker, type Violation } from "./invariants.ts";
import type { RunConfig, RunResult } from "./run.ts";

export type Summary = {
	seed: number;
	ticks: number;
	drivers: number;
	trips: { requested: number; completed: number; cancelled: number };
	// null when no trip was picked up.
	meanTicksToPickup: number | null;
	// Riders who declined surge (ADR 0054); 0 with surge off.
	declined: number;
	// Cents: the fares of completed trips, base fare for a trip without one
	// (surge off), so surge off and on compare on the same trips.
	revenue: number;
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
	const surgeSummary = createSurgeSummary();
	const checker = createInvariantChecker(config.grid);
	const { count, driversPerShard } = config.driverShards;
	return {
		observe: (message) => {
			checker.observe(message);
			tripSummary.observe(message);
			surgeSummary.observe(message);
		},
		result: (rejectedInputs) => ({
			seed: config.seed,
			ticks: config.ticks,
			drivers: count * driversPerShard,
			...tripSummary.result(),
			...surgeSummary.result(),
			rejectedInputs,
			violations: checker.violations(),
		}),
	};
}

export type TripSummary = Pick<Summary, "trips" | "meanTicksToPickup">;

// The summary's trip numbers alone, for event logs without a RunConfig
// (stored runs, ADR 0034). Memory grows with trips, not with messages.
export function createTripSummary(): {
	observe(message: Message): void;
	result(): TripSummary;
} {
	const trips = { requested: 0, completed: 0, cancelled: 0 };
	const requestedAt = new Map<TripId, Tick>();
	let pickups = 0;
	let ticksToPickup = 0;
	return {
		observe: (message) => {
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
		},
		result: () => ({
			trips: { ...trips },
			meanTicksToPickup: pickups === 0 ? null : ticksToPickup / pickups,
		}),
	};
}

const baseSurge = Surge.parse(1);

// The summary's riders declined and revenue (ADR 0054). Memory grows with
// trips, not with messages.
function createSurgeSummary(): {
	observe(message: Message): void;
	result(): Pick<Summary, "declined" | "revenue">;
} {
	const fares = new Map<TripId, Fare>();
	let declined = 0;
	let revenue = 0;
	return {
		observe: (message) => {
			switch (message.type) {
				case "rider.declined_surge":
					declined++;
					break;
				case "trip.requested":
					fares.set(
						message.tripId,
						message.fare ?? fareOf(message.pickup, message.dropoff, baseSurge),
					);
					break;
				case "trip.completed":
					revenue += fares.get(message.tripId) ?? 0;
					fares.delete(message.tripId);
					break;
				case "trip.cancelled":
					fares.delete(message.tripId);
					break;
			}
		},
		result: () => ({ declined, revenue }),
	};
}

// Cents as dollars, e.g. $4,321.50.
export function dollars(cents: number): string {
	return `$${(cents / 100).toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

// One headline number of two runs on the same seed, formatted: greedy and
// batched (ADR 0030), or surge off and on (ADR 0054).
export type ComparisonRow = { metric: string; first: string; second: string };

// surge: add riders declined and revenue.
export function compareSummaries(
	first: Summary,
	second: Summary,
	{ surge }: { surge: boolean },
): ComparisonRow[] {
	type Metric = [string, (summary: Summary) => string];
	const metrics: Metric[] = [
		["trips requested", (summary) => String(summary.trips.requested)],
		...(surge
			? [["riders declined", (summary) => String(summary.declined)] as Metric]
			: []),
		["trips completed", (summary) => String(summary.trips.completed)],
		["trips cancelled", (summary) => String(summary.trips.cancelled)],
		[
			"mean ticks from request to pickup",
			(summary) => summary.meanTicksToPickup?.toFixed(1) ?? "n/a",
		],
		...(surge
			? [["revenue", (summary) => dollars(summary.revenue)] as Metric]
			: []),
		["invariant violations", (summary) => String(summary.violations.length)],
	];
	return metrics.map(([metric, format]) => ({
		metric,
		first: format(first),
		second: format(second),
	}));
}
