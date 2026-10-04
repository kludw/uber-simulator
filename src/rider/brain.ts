import { distance, type Grid, randomCell } from "../shared/grid.ts";
import type {
	CancelTrip,
	CancelTripRejected,
	ClockTicked,
	InputRejected,
	RequestTrip,
	RequestTripRejected,
	RiderId,
	Tick,
	TripCancelled,
	TripCompleted,
	TripId,
	TripPickedUp,
} from "../shared/messages.ts";
import type { Random } from "../shared/random.ts";
import { assertValidDemand, type Demand, pickupsForTick } from "./demand.ts";

type Rider =
	| {
			state: "waiting";
			id: RiderId;
			tripId: TripId;
			requestedAt: Tick;
			patience: number;
	  }
	// Sent cancel_trip, waiting for dispatch's outcome.
	| { state: "cancelling"; id: RiderId; tripId: TripId }
	| { state: "riding"; id: RiderId; tripId: TripId };

// spawned: riders spawned so far; numbers both rider and trip IDs.
// riders: by trip ID (how inputs address them), updated in place (ADR 0033,
// 0036). Kept in spawn order, so patience cancels sort by rider ID themselves.
export type RidersState = {
	grid: Grid;
	requestsPerMinute: number;
	demand: Demand;
	spawned: number;
	riders: Map<TripId, Rider>;
};

export type RidersInput =
	| ClockTicked
	| TripPickedUp
	| TripCompleted
	| TripCancelled
	| CancelTripRejected
	| RequestTripRejected;

type RidersOutput = RequestTrip | CancelTrip | Rejected;

type Rejected = InputRejected<
	| TripPickedUp
	| TripCompleted
	| TripCancelled
	| CancelTripRejected
	| RequestTripRejected,
	"rider_already_riding" | "rider_not_riding" | "cancel_not_requested"
>;

type Decision = { state: RidersState; outputs: RidersOutput[] };

// Missing demand = uniform.
export function startRiders(config: {
	grid: Grid;
	requestsPerMinute: number;
	demand?: Demand;
}): RidersState {
	const demand = config.demand ?? { type: "uniform" };
	assertValidDemand(demand, config.grid);
	return {
		grid: config.grid,
		requestsPerMinute: config.requestsPerMinute,
		demand,
		spawned: 0,
		riders: new Map(),
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
			return onCompleted(state, input);
		case "trip.cancelled":
			return onCancelled(state, input);
		case "cancel_trip_rejected":
			return onCancelRejected(state, input);
		case "request_trip_rejected":
			return onRequestRejected(state, input);
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

function onCompleted(state: RidersState, completed: TripCompleted): Decision {
	const addressed = state.riders.get(completed.tripId);
	if (addressed === undefined) return { state, outputs: [] };
	if (addressed.state !== "riding") {
		return reject(state, completed, "rider_not_riding");
	}
	return removeRider(state, addressed.tripId);
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
	const spawnCount = poisson(state.requestsPerMinute / 60, demand);
	const nextPickup = pickupsForTick(state.demand, state.grid, input.tick, {
		root: random,
		demand,
	});
	const outOfPatience: Rider[] = [];
	for (const rider of state.riders.values()) {
		if (rider.state !== "waiting") continue;
		if (input.tick < rider.requestedAt + rider.patience) continue;
		outOfPatience.push(rider);
	}
	outOfPatience.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const outputs: RidersOutput[] = [];
	for (const rider of outOfPatience) {
		outputs.push({ type: "cancel_trip", tripId: rider.tripId });
		state.riders.set(rider.tripId, {
			state: "cancelling",
			id: rider.id,
			tripId: rider.tripId,
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
			requestedAt: input.tick,
			// Max stays below the driver's pickup wait timeout (ADR 0040).
			patience: patience.int(120, 300),
		};
		state.riders.set(rider.tripId, rider);
		outputs.push({
			type: "request_trip",
			tick: input.tick,
			tripId: rider.tripId,
			riderId: rider.id,
			pickup,
			dropoff,
		});
	}
	return { state, outputs };
}

// Knuth's method: fine for the small per-tick means used here.
function poisson(mean: number, random: Random): number {
	const limit = Math.exp(-mean);
	let count = 0;
	let product = random.float();
	while (product > limit) {
		count++;
		product *= random.float();
	}
	return count;
}
