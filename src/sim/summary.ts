import type { DriverId, Message, Tick, TripId } from "../shared/messages.ts";
import { baseSurge, dollars, type Fare, fareOf } from "../shared/surge.ts";
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
	// Trips whose rider opted in to pooling (ADR 0056); 0 with pooling off.
	pooled: number;
	// Completed trips that had another trip on their driver while active.
	shared: number;
	// Over completed trips seen picked up; null when none.
	meanTicksToComplete: number | null;
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
	const poolingSummary = createPoolingSummary();
	const checker = createInvariantChecker(config.grid);
	const { count, driversPerShard } = config.driverShards;
	return {
		observe: (message) => {
			checker.observe(message);
			tripSummary.observe(message);
			surgeSummary.observe(message);
			poolingSummary.observe(message);
		},
		result: (rejectedInputs) => ({
			seed: config.seed,
			ticks: config.ticks,
			drivers: count * driversPerShard,
			...tripSummary.result(),
			...surgeSummary.result(),
			...poolingSummary.result(),
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
					fares.set(message.tripId, message.fare ?? fareOf(message, baseSurge));
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

// The summary's trips pooled, trips shared and ticks from pickup to
// completion (ADR 0056). Memory grows with active trips, not with messages.
function createPoolingSummary(): {
	observe(message: Message): void;
	result(): Pick<Summary, "pooled" | "shared" | "meanTicksToComplete">;
} {
	// Active trips (matched, not ended) by driver, and whether each has had
	// another trip on its driver.
	const onDriver = new Map<DriverId, TripId[]>();
	const sharedTrips = new Set<TripId>();
	const pickedUpAt = new Map<TripId, Tick>();
	let pooled = 0;
	let shared = 0;
	let rides = 0;
	let rideTicks = 0;
	const end = (driverId: DriverId | null, tripId: TripId) => {
		sharedTrips.delete(tripId);
		pickedUpAt.delete(tripId);
		if (driverId === null) return;
		const left = (onDriver.get(driverId) ?? []).filter((id) => id !== tripId);
		if (left.length === 0) onDriver.delete(driverId);
		else onDriver.set(driverId, left);
	};
	return {
		observe: (message) => {
			switch (message.type) {
				case "trip.requested":
					if (message.pooled) pooled++;
					break;
				case "trip.matched": {
					const others = onDriver.get(message.driverId) ?? [];
					for (const other of others) sharedTrips.add(other);
					if (others.length > 0) sharedTrips.add(message.tripId);
					onDriver.set(message.driverId, [...others, message.tripId]);
					break;
				}
				case "trip.picked_up":
					pickedUpAt.set(message.tripId, message.tick);
					break;
				case "trip.completed": {
					if (sharedTrips.has(message.tripId)) shared++;
					const at = pickedUpAt.get(message.tripId);
					if (at !== undefined) {
						rides++;
						rideTicks += message.tick - at;
					}
					end(message.driverId, message.tripId);
					break;
				}
				case "trip.cancelled":
					end(message.driverId, message.tripId);
					break;
			}
		},
		result: () => ({
			pooled,
			shared,
			meanTicksToComplete: rides === 0 ? null : rideTicks / rides,
		}),
	};
}

// One headline number of two runs on the same seed, formatted: greedy and
// batched (ADR 0030), surge off and on (ADR 0054), or pooling off and on
// (ADR 0056).
export type ComparisonRow = { metric: string; first: string; second: string };

// surge: add riders declined and revenue. pooling: add trips pooled and
// shared, ticks from pickup to completion, and revenue.
export function compareSummaries(
	first: Summary,
	second: Summary,
	{ surge, pooling }: { surge: boolean; pooling: boolean },
): ComparisonRow[] {
	type Metric = [string, (summary: Summary) => string];
	const metrics: Metric[] = [
		["trips requested", (summary) => String(summary.trips.requested)],
		...(surge
			? [["riders declined", (summary) => String(summary.declined)] as Metric]
			: []),
		...(pooling
			? [["trips pooled", (summary) => String(summary.pooled)] as Metric]
			: []),
		["trips completed", (summary) => String(summary.trips.completed)],
		...(pooling
			? [["trips shared", (summary) => String(summary.shared)] as Metric]
			: []),
		["trips cancelled", (summary) => String(summary.trips.cancelled)],
		[
			"mean ticks from request to pickup",
			(summary) => summary.meanTicksToPickup?.toFixed(1) ?? "n/a",
		],
		...(pooling
			? [
					[
						"mean ticks from pickup to completion",
						(summary) => summary.meanTicksToComplete?.toFixed(1) ?? "n/a",
					] as Metric,
				]
			: []),
		...(surge || pooling
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
