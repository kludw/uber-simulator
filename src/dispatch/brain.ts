import { type Cell, distance, type Grid } from "../shared/grid.ts";
import type {
	CancelTrip,
	CancelTripAccepted,
	CancelTripRejected,
	ClockTicked,
	DriverArrivedAtDropoff,
	DriverArrivedAtPickup,
	DriverId,
	DriverMoved,
	DriverWentOnline,
	InputRejected,
	Offer,
	OfferAccepted,
	OfferDeclined,
	RequestTrip,
	RequestTripAccepted,
	RequestTripRejected,
	Tick,
	TripCancelled,
	TripCompleted,
	TripId,
	TripMatched,
	TripOfferDeclined,
	TripOfferExpired,
	TripOffered,
	TripPickedUp,
	TripRequested,
} from "../shared/messages.ts";
import type { Random } from "../shared/random.ts";
import { minCostMatching } from "./matching.ts";
import {
	type ArrivalRejected,
	acceptOffer,
	cancel,
	complete,
	type NoPendingOffer,
	offerTo,
	pickUp,
	type QueuedTrip,
	requestedTrip,
	type Trip,
	withdrawOffer,
} from "./trip.ts";

// Every known trip by ID, in request order: the queue is the requested trips
// without an offer, in that order (FIFO).
// Driver cells as last reported in events; may be stale (ADR 0018).
// tick: last clock tick, stamped on events caused by non-tick inputs.
export type DispatchState = {
	grid: Grid;
	tick: Tick;
	matching: Matching;
	trips: ReadonlyMap<TripId, Trip>;
	driverCells: ReadonlyMap<DriverId, Cell>;
};

// ADR 0030: batched matches only on ticks that are multiples of windowTicks.
export type Matching =
	| { type: "greedy" }
	| { type: "batched"; windowTicks: number };

export type DispatchInput =
	| ClockTicked
	| RequestTrip
	| CancelTrip
	| DriverWentOnline
	| DriverMoved
	| OfferAccepted
	| OfferDeclined
	| DriverArrivedAtPickup
	| DriverArrivedAtDropoff;

type DispatchOutput =
	| RequestTripAccepted
	| RequestTripRejected
	| CancelTripAccepted
	| CancelTripRejected
	| TripRequested
	| Offer
	| TripOffered
	| TripMatched
	| TripOfferDeclined
	| TripOfferExpired
	| TripPickedUp
	| TripCompleted
	| TripCancelled
	| InputRejected<OfferAccepted | OfferDeclined, NoPendingOffer["type"]>
	| InputRejected<
			DriverArrivedAtPickup | DriverArrivedAtDropoff,
			ArrivalRejected["type"]
	  >;

type Decision = { state: DispatchState; outputs: DispatchOutput[] };

// ADR 0018.
const offerTimeoutTicks = 3;

export function startDispatch(config: {
	grid: Grid;
	tick: Tick;
	matching?: Matching | undefined;
}): DispatchState {
	const matching = config.matching ?? { type: "greedy" };
	// Parsed at the edge; a bad window here is a caller bug.
	if (
		matching.type === "batched" &&
		!(Number.isInteger(matching.windowTicks) && matching.windowTicks > 0)
	) {
		throw new Error(
			`windowTicks ${matching.windowTicks} is not a positive integer`,
		);
	}
	return {
		grid: config.grid,
		tick: config.tick,
		matching,
		trips: new Map(),
		driverCells: new Map(),
	};
}

export function decideDispatch(
	state: DispatchState,
	input: DispatchInput,
	_random: Random,
): Decision {
	switch (input.type) {
		case "clock.ticked":
			return onTick(state, input);
		case "request_trip":
			return onRequestTrip(state, input);
		case "cancel_trip":
			return onCancelTrip(state, input);
		case "driver.went_online":
		case "driver.moved":
			return onDriverReported(state, input);
		case "offer_accepted":
		case "offer_declined":
			return onOfferReply(state, input);
		case "driver.arrived_at_pickup":
		case "driver.arrived_at_dropoff":
			return onArrival(state, input);
		default: {
			const unhandled: never = input;
			throw new Error(`unhandled dispatch input: ${unhandled}`);
		}
	}
}

function onTick(state: DispatchState, ticked: ClockTicked): Decision {
	const outputs: DispatchOutput[] = [];
	const trips = new Map(state.trips);
	for (const { trip, driverId } of offerPairs(state, ticked.tick)) {
		trips.set(trip.id, offerTo(trip, driverId, ticked.tick));
		outputs.push(
			{
				type: "offer",
				tripId: trip.id,
				driverId,
				pickup: trip.pickup,
				dropoff: trip.dropoff,
			},
			{ type: "trip.offered", tick: ticked.tick, tripId: trip.id, driverId },
		);
	}
	// After offering, so an expired trip and its driver wait for the next tick
	// (ADR 0018); offers made this tick are never due.
	for (const trip of state.trips.values()) {
		if (trip.state !== "requested" || trip.offer === null) continue;
		if (ticked.tick < trip.offer.offeredAt + offerTimeoutTicks) continue;
		const queued = withdrawOffer(trip, trip.offer.driverId);
		if (!queued.ok) throw new Error(`pending offer for ${trip.id} not found`);
		trips.set(trip.id, queued.value);
		outputs.push({
			type: "trip.offer_expired",
			tick: ticked.tick,
			tripId: trip.id,
			driverId: trip.offer.driverId,
		});
	}
	return { state: { ...state, tick: ticked.tick, trips }, outputs };
}

type OfferPair = { trip: QueuedTrip; driverId: DriverId };

// Pairs in trip FIFO order. Eligible: queued trips; known drivers without a
// pending offer or active trip, never one excluded for the trip.
function offerPairs(state: DispatchState, tick: Tick): OfferPair[] {
	const queued: QueuedTrip[] = [];
	const busy = new Set<DriverId>();
	for (const trip of state.trips.values()) {
		if (trip.state === "matched" || trip.state === "picked_up") {
			busy.add(trip.driverId);
		}
		if (trip.state !== "requested") continue;
		if (trip.offer === null) queued.push(trip);
		else busy.add(trip.offer.driverId);
	}
	const idle = [...state.driverCells.keys()]
		.toSorted()
		.filter((id) => !busy.has(id));
	switch (state.matching.type) {
		case "greedy":
			return greedyPairs(state, queued, idle);
		case "batched":
			if (tick % state.matching.windowTicks !== 0) return [];
			return batchedPairs(state, queued, idle);
		default: {
			const unhandled: never = state.matching;
			throw new Error(`unhandled matching: ${unhandled}`);
		}
	}
}

// Each trip in turn takes the nearest remaining driver; ties to the lowest ID
// because idle is ordered by ID and the strict < keeps the first.
function greedyPairs(
	state: DispatchState,
	queued: readonly QueuedTrip[],
	idle: readonly DriverId[],
): OfferPair[] {
	const pairs: OfferPair[] = [];
	const taken = new Set<DriverId>();
	for (const trip of queued) {
		let nearest: { driverId: DriverId; distance: number } | undefined;
		for (const driverId of idle) {
			if (taken.has(driverId) || trip.excludedDrivers.has(driverId)) continue;
			const toPickup = distance(cellOf(state, driverId), trip.pickup);
			if (nearest !== undefined && toPickup >= nearest.distance) continue;
			nearest = { driverId, distance: toPickup };
		}
		if (nearest === undefined) continue;
		taken.add(nearest.driverId);
		pairs.push({ trip, driverId: nearest.driverId });
	}
	return pairs;
}

// ADR 0030: as many pairs as possible, least total pickup distance among those.
function batchedPairs(
	state: DispatchState,
	queued: readonly QueuedTrip[],
	idle: readonly DriverId[],
): OfferPair[] {
	const costs = queued.map((trip) =>
		idle.map((driverId) =>
			trip.excludedDrivers.has(driverId)
				? null
				: distance(cellOf(state, driverId), trip.pickup),
		),
	);
	return minCostMatching(costs).map(({ row, column }) => {
		const trip = queued[row];
		const driverId = idle[column];
		if (trip === undefined || driverId === undefined) {
			throw new Error(`matching pair (${row}, ${column}) out of range`);
		}
		return { trip, driverId };
	});
}

function cellOf(state: DispatchState, driverId: DriverId): Cell {
	const cell = state.driverCells.get(driverId);
	if (cell === undefined) throw new Error(`no cell for ${driverId}`);
	return cell;
}

function onRequestTrip(state: DispatchState, request: RequestTrip): Decision {
	if (state.trips.has(request.tripId)) {
		return {
			state,
			outputs: [
				{
					type: "request_trip_rejected",
					tripId: request.tripId,
					error: { type: "duplicate_trip_id" },
				},
			],
		};
	}
	const trip = requestedTrip(request);
	return {
		state: { ...state, trips: new Map(state.trips).set(trip.id, trip) },
		outputs: [
			{ type: "request_trip_accepted", tripId: request.tripId },
			{
				type: "trip.requested",
				tick: request.tick,
				tripId: request.tripId,
				riderId: request.riderId,
				pickup: request.pickup,
				dropoff: request.dropoff,
			},
		],
	};
}

function onCancelTrip(state: DispatchState, command: CancelTrip): Decision {
	const trip = state.trips.get(command.tripId);
	if (trip === undefined) {
		return {
			state,
			outputs: [
				{
					type: "cancel_trip_rejected",
					tripId: command.tripId,
					error: { type: "unknown_trip" },
				},
			],
		};
	}
	const cancelled = cancel(trip);
	if (!cancelled.ok) {
		return {
			state,
			outputs: [
				{
					type: "cancel_trip_rejected",
					tripId: trip.id,
					error: { type: cancelled.error.type, from: cancelled.error.from },
				},
			],
		};
	}
	return {
		state: {
			...state,
			trips: new Map(state.trips).set(trip.id, cancelled.value),
		},
		outputs: [
			{ type: "cancel_trip_accepted", tripId: trip.id },
			{
				type: "trip.cancelled",
				tick: state.tick,
				tripId: trip.id,
				driverId: cancelled.value.driverId,
			},
		],
	};
}

function onDriverReported(
	state: DispatchState,
	report: DriverWentOnline | DriverMoved,
): Decision {
	const driverCells = new Map(state.driverCells).set(
		report.driverId,
		report.cell,
	);
	return { state: { ...state, driverCells }, outputs: [] };
}

// Replies to offers already declined, expired, or cancelled with their trip
// are stale (ADR 0022): ignored.
function onOfferReply(
	state: DispatchState,
	reply: OfferAccepted | OfferDeclined,
): Decision {
	const trip = state.trips.get(reply.tripId);
	if (trip === undefined) return { state, outputs: [] };
	if (trip.state === "cancelled") return { state, outputs: [] };
	if (trip.excludedDrivers.has(reply.driverId)) return { state, outputs: [] };
	const accepted = reply.type === "offer_accepted";
	const next = accepted
		? acceptOffer(trip, reply.driverId)
		: withdrawOffer(trip, reply.driverId);
	if (!next.ok) {
		return {
			state,
			outputs: [
				{ type: "input_rejected", reason: next.error.type, input: reply },
			],
		};
	}
	return {
		state: { ...state, trips: new Map(state.trips).set(trip.id, next.value) },
		outputs: [
			{
				type: accepted ? "trip.matched" : "trip.offer_declined",
				tick: state.tick,
				tripId: trip.id,
				driverId: reply.driverId,
			},
		],
	};
}

function onArrival(
	state: DispatchState,
	arrival: DriverArrivedAtPickup | DriverArrivedAtDropoff,
): Decision {
	const trip = state.trips.get(arrival.tripId);
	if (trip === undefined) return { state, outputs: [] };
	// The rider's cancel reached dispatch first: a legitimate race, not an error.
	if (trip.state === "cancelled") return { state, outputs: [] };
	const atPickup = arrival.type === "driver.arrived_at_pickup";
	const next = atPickup
		? pickUp(trip, arrival.driverId, arrival.cell)
		: complete(trip, arrival.driverId, arrival.cell);
	if (!next.ok) {
		return {
			state,
			outputs: [
				{ type: "input_rejected", reason: next.error.type, input: arrival },
			],
		};
	}
	return {
		state: { ...state, trips: new Map(state.trips).set(trip.id, next.value) },
		outputs: [
			{
				type: atPickup ? "trip.picked_up" : "trip.completed",
				tick: state.tick,
				tripId: trip.id,
				driverId: arrival.driverId,
			},
		],
	};
}
