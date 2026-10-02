import { distance, type Grid, randomCell } from "../shared/grid.ts";
import type {
	CancelTrip,
	CancelTripRejected,
	ClockTicked,
	InputRejected,
	RequestTrip,
	RiderId,
	Tick,
	TripCancelled,
	TripCompleted,
	TripId,
	TripPickedUp,
} from "../shared/messages.ts";
import type { Random } from "../shared/random.ts";

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
// Riders kept ordered by ID: patience cancels follow that order.
export type RidersState = {
	grid: Grid;
	requestsPerMinute: number;
	spawned: number;
	riders: Rider[];
};

export type RidersInput =
	| ClockTicked
	| TripPickedUp
	| TripCompleted
	| TripCancelled
	| CancelTripRejected;

type RidersOutput = RequestTrip | CancelTrip | Rejected;

type Rejected = InputRejected<
	TripPickedUp | TripCompleted | TripCancelled | CancelTripRejected,
	"rider_already_riding" | "rider_not_riding" | "cancel_not_requested"
>;

type Decision = { state: RidersState; outputs: RidersOutput[] };

export function startRiders(config: {
	grid: Grid;
	requestsPerMinute: number;
}): RidersState {
	return {
		grid: config.grid,
		requestsPerMinute: config.requestsPerMinute,
		spawned: 0,
		riders: [],
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
		default: {
			const unhandled: never = input;
			throw new Error(`unhandled riders input: ${unhandled}`);
		}
	}
}

function onPickedUp(state: RidersState, pickedUp: TripPickedUp): Decision {
	const addressed = state.riders.find(
		(rider) => rider.tripId === pickedUp.tripId,
	);
	if (addressed === undefined) return { state, outputs: [] };
	if (addressed.state === "riding") {
		return reject(state, pickedUp, "rider_already_riding");
	}
	// A cancelling rider rides too: pickup reached dispatch before the cancel.
	const riders = state.riders.map(
		(rider): Rider =>
			rider.id === addressed.id
				? { state: "riding", id: rider.id, tripId: rider.tripId }
				: rider,
	);
	return { state: { ...state, riders }, outputs: [] };
}

function reject(
	state: RidersState,
	input: Rejected["input"],
	reason: Rejected["reason"],
): Decision {
	return { state, outputs: [{ type: "input_rejected", reason, input }] };
}

function onCompleted(state: RidersState, completed: TripCompleted): Decision {
	const addressed = state.riders.find(
		(rider) => rider.tripId === completed.tripId,
	);
	if (addressed === undefined) return { state, outputs: [] };
	if (addressed.state !== "riding") {
		return reject(state, completed, "rider_not_riding");
	}
	return removeRider(state, addressed.id);
}

function onCancelled(state: RidersState, cancelled: TripCancelled): Decision {
	const addressed = state.riders.find(
		(rider) => rider.tripId === cancelled.tripId,
	);
	if (addressed === undefined) return { state, outputs: [] };
	if (addressed.state === "riding") {
		return reject(state, cancelled, "rider_already_riding");
	}
	return removeRider(state, addressed.id);
}

function onCancelRejected(
	state: RidersState,
	rejected: CancelTripRejected,
): Decision {
	const addressed = state.riders.find(
		(rider) => rider.tripId === rejected.tripId,
	);
	if (addressed === undefined) return { state, outputs: [] };
	if (addressed.state === "waiting") {
		return reject(state, rejected, "cancel_not_requested");
	}
	// Dispatch never knew the trip (e.g. request_trip lost): no trip event
	// will ever end it.
	if (
		addressed.state === "cancelling" &&
		rejected.error.type === "unknown_trip"
	) {
		return removeRider(state, addressed.id);
	}
	// Otherwise dispatch's trip event (picked_up, completed) decides what's next.
	return { state, outputs: [] };
}

function removeRider(state: RidersState, id: RiderId): Decision {
	const riders = state.riders.filter((rider) => rider.id !== id);
	return { state: { ...state, riders }, outputs: [] };
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
	let spawned = state.spawned;
	const riders: Rider[] = [];
	const outputs: RidersOutput[] = [];
	for (const rider of state.riders) {
		if (
			rider.state !== "waiting" ||
			input.tick < rider.requestedAt + rider.patience
		) {
			riders.push(rider);
			continue;
		}
		outputs.push({ type: "cancel_trip", tripId: rider.tripId });
		riders.push({ state: "cancelling", id: rider.id, tripId: rider.tripId });
	}
	for (let i = 0; i < spawnCount; i++) {
		spawned++;
		const pickup = randomCell(state.grid, demand);
		let dropoff = randomCell(state.grid, demand);
		while (distance(pickup, dropoff) === 0) {
			dropoff = randomCell(state.grid, demand);
		}
		const rider: Rider = {
			state: "waiting",
			id: `r-${spawned}` as RiderId,
			tripId: `t-${spawned}` as TripId,
			requestedAt: input.tick,
			patience: patience.int(120, 300),
		};
		riders.push(rider);
		outputs.push({
			type: "request_trip",
			tick: input.tick,
			tripId: rider.tripId,
			riderId: rider.id,
			pickup,
			dropoff,
		});
	}
	riders.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return { state: { ...state, spawned, riders }, outputs };
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
