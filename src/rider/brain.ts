import { distance, type Grid, randomCell } from "../shared/grid.ts";
import type {
	CancelTrip,
	CancelTripRejected,
	ClockTicked,
	InputRejected,
	RequestTrip,
	RequestTripRejected,
	RiderDeclinedSurge,
	RiderId,
	RiderRatedDriver,
	Tick,
	TripCancelled,
	TripCompleted,
	TripId,
	TripPickedUp,
	ZonesPriced,
} from "../shared/messages.ts";
import type { Random } from "../shared/random.ts";
import {
	oneRegion,
	type Region,
	type RegionLayout,
	regionOf,
} from "../shared/regions.ts";
import { baseSurge, type Surge, type Zone, zoneOf } from "../shared/surge.ts";
import { driverQuality, spikeRatings, starsOf } from "../shared/rating.ts";
import { assertValidDemand, type Demand, pickupsForTick } from "./demand.ts";

// region: the trip's, where its cancel goes (ADR 0050).
type Rider =
	| {
			state: "waiting";
			id: RiderId;
			tripId: TripId;
			region: Region;
			requestedAt: Tick;
			patience: number;
			direct: number;
	  }
	// Sent cancel_trip, waiting for dispatch's outcome.
	| {
			state: "cancelling";
			id: RiderId;
			tripId: TripId;
			requestedAt: Tick;
			direct: number;
	  }
	| {
			state: "riding";
			id: RiderId;
			tripId: TripId;
			requestedAt: Tick;
			pickedUpAt: Tick;
			direct: number;
	  };

// spawned: riders spawned so far; numbers both rider and trip IDs.
// riders: by trip ID (how inputs address them), updated in place (ADR 0033,
// 0036). Kept in spawn order, so patience cancels sort by rider ID themselves.
export type RidersState = {
	grid: Grid;
	regions: RegionLayout;
	requestsPerMinute: number;
	demand: Demand;
	spawned: number;
	riders: Map<TripId, Rider>;
	// Whether riders quote and decide on surge (ADR 0054).
	surge: boolean;
	// The last zones.priced per region, by zone: zones not listed are 1.0.
	prices: Map<Region, Map<Zone, Surge>>;
	// Whether riders opt in to pooling (ADR 0056).
	pooling: boolean;
};

export type RidersInput =
	| ClockTicked
	| TripPickedUp
	| TripCompleted
	| TripCancelled
	| CancelTripRejected
	| RequestTripRejected
	| ZonesPriced;

type RidersOutput =
	| RequestTrip
	| CancelTrip
	| RiderDeclinedSurge
	| RiderRatedDriver
	| Rejected;

type Rejected = InputRejected<
	| TripPickedUp
	| TripCompleted
	| TripCancelled
	| CancelTripRejected
	| RequestTripRejected,
	"rider_already_riding" | "rider_not_riding" | "cancel_not_requested"
>;

type Decision = { state: RidersState; outputs: RidersOutput[] };

// Missing demand = uniform; missing regions = one region; missing surge or
// pooling = off.
export function startRiders(config: {
	grid: Grid;
	requestsPerMinute: number;
	demand?: Demand;
	regions?: RegionLayout;
	surge?: boolean;
	pooling?: boolean;
}): RidersState {
	const demand = config.demand ?? { type: "uniform" };
	assertValidDemand(demand, config.grid);
	return {
		grid: config.grid,
		regions: config.regions ?? oneRegion,
		requestsPerMinute: config.requestsPerMinute,
		demand,
		spawned: 0,
		riders: new Map(),
		surge: config.surge ?? false,
		prices: new Map(),
		pooling: config.pooling ?? false,
	};
}

export function decideRiders(
	state: RidersState,
	input: RidersInput,
	random: Random,
): Decision {
	switch (input.type) {
		case "clock.ticked":
			return onTick(state, input, random);
		case "trip.picked_up":
			return onPickedUp(state, input);
		case "trip.completed":
			return onCompleted(state, input, random);
		case "trip.cancelled":
			return onCancelled(state, input);
		case "cancel_trip_rejected":
			return onCancelRejected(state, input);
		case "request_trip_rejected":
			return onRequestRejected(state, input);
		case "zones.priced":
			return onPriced(state, input);
		default: {
			const unhandled: never = input;
			throw new Error(`unhandled riders input: ${unhandled}`);
		}
	}
}

function onPickedUp(state: RidersState, pickedUp: TripPickedUp): Decision {
	const addressed = state.riders.get(pickedUp.tripId);
	if (addressed === undefined) return { state, outputs: [] };
	if (addressed.state === "riding") {
		return reject(state, pickedUp, "rider_already_riding");
	}
	// A cancelling rider rides too: pickup reached dispatch before the cancel.
	state.riders.set(addressed.tripId, {
		state: "riding",
		id: addressed.id,
		tripId: addressed.tripId,
		requestedAt: addressed.requestedAt,
		pickedUpAt: pickedUp.tick,
		direct: addressed.direct,
	});
	return { state, outputs: [] };
}

function reject(
	state: RidersState,
	input: Rejected["input"],
	reason: Rejected["reason"],
): Decision {
	return { state, outputs: [{ type: "input_rejected", reason, input }] };
}

function onCompleted(
	state: RidersState,
	completed: TripCompleted,
	random: Random,
): Decision {
	const addressed = state.riders.get(completed.tripId);
	if (addressed === undefined) return { state, outputs: [] };
	if (addressed.state !== "riding") {
		return reject(state, completed, "rider_not_riding");
	}
	state.riders.delete(addressed.tripId);
	if (!spikeRatings.on) return { state, outputs: [] };
	const rated: RiderRatedDriver = {
		type: "rider.rated_driver",
		tick: completed.tick,
		riderId: addressed.id,
		tripId: addressed.tripId,
		driverId: completed.driverId,
		stars: starsOf(
			driverQuality(random, completed.driverId),
			{
				waitTicks: addressed.pickedUpAt - addressed.requestedAt,
				rideTicks: completed.tick - addressed.pickedUpAt,
				direct: addressed.direct,
			},
			random.child(`rating:${addressed.tripId}`),
		),
	};
	return { state, outputs: [rated] };
}

function onCancelled(state: RidersState, cancelled: TripCancelled): Decision {
	const addressed = state.riders.get(cancelled.tripId);
	if (addressed === undefined) return { state, outputs: [] };
	if (addressed.state === "riding") {
		return reject(state, cancelled, "rider_already_riding");
	}
	return removeRider(state, addressed.tripId);
}

function onCancelRejected(
	state: RidersState,
	rejected: CancelTripRejected,
): Decision {
	const addressed = state.riders.get(rejected.tripId);
	if (addressed === undefined) return { state, outputs: [] };
	if (addressed.state === "waiting") {
		return reject(state, rejected, "cancel_not_requested");
	}
	// Trip already over (its trip.* event lost), whatever the rider saw.
	if (
		rejected.error.type === "invalid_transition" &&
		rejected.error.from !== "picked_up"
	) {
		return removeRider(state, addressed.tripId);
	}
	// Dispatch never knew the trip (e.g. request_trip lost): no trip event
	// will ever end it.
	if (
		addressed.state === "cancelling" &&
		rejected.error.type === "unknown_trip"
	) {
		return removeRider(state, addressed.tripId);
	}
	// Otherwise dispatch's trip event (picked_up, completed) decides what's next.
	return { state, outputs: [] };
}

function onRequestRejected(
	state: RidersState,
	rejected: RequestTripRejected,
): Decision {
	const addressed = state.riders.get(rejected.tripId);
	if (addressed === undefined) return { state, outputs: [] };
	if (addressed.state === "riding") {
		return reject(state, rejected, "rider_already_riding");
	}
	return removeRider(state, addressed.tripId);
}

function onPriced(state: RidersState, priced: ZonesPriced): Decision {
	state.prices.set(
		priced.region,
		new Map(priced.zones.map(({ zone, surge }) => [zone, surge])),
	);
	return { state, outputs: [] };
}

function removeRider(state: RidersState, tripId: TripId): Decision {
	state.riders.delete(tripId);
	return { state, outputs: [] };
}

function onTick(
	state: RidersState,
	input: ClockTicked,
	random: Random,
): Decision {
	// Children keyed by tick: the same label would replay the same draws every tick.
	const demand = random.child(`demand:${input.tick}`);
	const patience = random.child(`patience:${input.tick}`);
	// Surge off draws nothing from it (ADR 0054).
	const willingness = state.surge
		? random.child(`willingness:${input.tick}`)
		: null;
	// Pooling off draws nothing from it (ADR 0056).
	const optIn = state.pooling ? random.child(`pool:${input.tick}`) : null;
	const spawnCount = poisson(state.requestsPerMinute / 60, demand);
	const nextPickup = pickupsForTick(state.demand, state.grid, input.tick, {
		root: random,
		demand,
	});
	const outOfPatience: Extract<Rider, { state: "waiting" }>[] = [];
	for (const rider of state.riders.values()) {
		if (rider.state !== "waiting") continue;
		if (input.tick < rider.requestedAt + rider.patience) continue;
		outOfPatience.push(rider);
	}
	outOfPatience.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const outputs: RidersOutput[] = [];
	for (const rider of outOfPatience) {
		outputs.push({
			type: "cancel_trip",
			tripId: rider.tripId,
			region: rider.region,
		});
		state.riders.set(rider.tripId, {
			state: "cancelling",
			id: rider.id,
			tripId: rider.tripId,
			requestedAt: rider.requestedAt,
			direct: rider.direct,
		});
	}
	for (let i = 0; i < spawnCount; i++) {
		state.spawned++;
		const pickup = nextPickup();
		let dropoff = randomCell(state.grid, demand);
		while (distance(pickup, dropoff) === 0) {
			dropoff = randomCell(state.grid, demand);
		}
		const rider: Rider = {
			state: "waiting",
			id: `r-${state.spawned}` as RiderId,
			tripId: `t-${state.spawned}` as TripId,
			region: regionOf(state.regions, state.grid, pickup),
			requestedAt: input.tick,
			patience: patience.int(120, 300),
			direct: distance(pickup, dropoff),
		};
		// One draw per spawned rider, declined or not, so a decline never
		// shifts later draws.
		const pooled = optIn !== null && optIn.float() < poolShare;
		let quote: Surge | undefined;
		if (willingness !== null) {
			quote =
				state.prices.get(rider.region)?.get(zoneOf(state.grid, pickup)) ??
				baseSurge;
			// Max surge: uniform in [1.0, 3.0), one draw per spawned rider so a
			// decline never shifts later draws.
			const maxSurge = 1 + 2 * willingness.float();
			if (quote > maxSurge) {
				outputs.push({
					type: "rider.declined_surge",
					tick: input.tick,
					riderId: rider.id,
					pickup,
					surge: quote,
				});
				continue;
			}
		}
		state.riders.set(rider.tripId, rider);
		outputs.push({
			type: "request_trip",
			tick: input.tick,
			tripId: rider.tripId,
			riderId: rider.id,
			pickup,
			dropoff,
			region: rider.region,
			...(quote === undefined ? {} : { surge: quote }),
			...(pooled ? { pooled: true as const } : {}),
		});
	}
	return { state, outputs };
}

// The probability a spawned rider opts in to pooling (ADR 0056).
const poolShare = 0.5;

// Largest mean Knuth's method draws exactly: Math.exp(-mean) stays a normal
// double up to ~708 and underflows to 0 at ~745, capping the draw there.
const KNUTH_MAX_MEAN = 700;

// Poisson is additive: a larger mean is the sum of draws over equal chunks
// Knuth handles. Means up to KNUTH_MAX_MEAN draw exactly as before (#246).
function poisson(mean: number, random: Random): number {
	const chunks = Math.max(1, Math.ceil(mean / KNUTH_MAX_MEAN));
	let count = 0;
	for (let chunk = 0; chunk < chunks; chunk++) {
		count += knuthPoisson(mean / chunks, random);
	}
	return count;
}

function knuthPoisson(mean: number, random: Random): number {
	const limit = Math.exp(-mean);
	let count = 0;
	let product = random.float();
	while (product > limit) {
		count++;
		product *= random.float();
	}
	return count;
}
