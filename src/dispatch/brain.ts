import { type Cell, distance, type Grid } from "../shared/grid.ts";
import type {
	ClockTicked,
	DriverId,
	DriverMoved,
	DriverWentOnline,
	Offer,
	RequestTrip,
	RequestTripAccepted,
	RequestTripRejected,
	RiderId,
	Tick,
	TripId,
	TripOffered,
	TripRequested,
} from "../shared/messages.ts";
import type { Random } from "../shared/random.ts";

type Trip = {
	state: "requested";
	id: TripId;
	riderId: RiderId;
	pickup: Cell;
	dropoff: Cell;
	requestedAt: Tick;
	// Driver asked to take the trip, awaiting a reply; null while queued.
	pendingOffer: DriverId | null;
};

// Every known trip by ID; queue = IDs awaiting an offer, FIFO.
// Driver cells as last reported in events; may be stale (ADR 0018).
export type DispatchState = {
	grid: Grid;
	trips: ReadonlyMap<TripId, Trip>;
	queue: readonly TripId[];
	driverCells: ReadonlyMap<DriverId, Cell>;
};

export type DispatchInput =
	| ClockTicked
	| RequestTrip
	| DriverWentOnline
	| DriverMoved;

type DispatchOutput =
	| RequestTripAccepted
	| RequestTripRejected
	| TripRequested
	| Offer
	| TripOffered;

type Decision = { state: DispatchState; outputs: DispatchOutput[] };

export function startDispatch(config: { grid: Grid }): DispatchState {
	return {
		grid: config.grid,
		trips: new Map(),
		queue: [],
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
		case "driver.went_online":
		case "driver.moved":
			return onDriverReported(state, input);
		default: {
			const unhandled: never = input;
			throw new Error(`unhandled dispatch input: ${unhandled}`);
		}
	}
}

function onTick(state: DispatchState, ticked: ClockTicked): Decision {
	const outputs: DispatchOutput[] = [];
	const trips = new Map(state.trips);
	const queue: TripId[] = [];
	const offered = new Set<DriverId>();
	for (const trip of state.trips.values()) {
		if (trip.pendingOffer !== null) offered.add(trip.pendingOffer);
	}
	for (const tripId of state.queue) {
		const trip = trips.get(tripId);
		if (trip === undefined) throw new Error(`queued trip ${tripId} unknown`);
		const driverId = nearestDriver(state, trip.pickup, offered);
		if (driverId === undefined) {
			queue.push(tripId);
			continue;
		}
		offered.add(driverId);
		trips.set(tripId, { ...trip, pendingOffer: driverId });
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
	return { state: { ...state, trips, queue }, outputs };
}

function nearestDriver(
	state: DispatchState,
	pickup: Cell,
	busy: ReadonlySet<DriverId>,
): DriverId | undefined {
	let nearest: { driverId: DriverId; distance: number } | undefined;
	// Ordered by ID so the strict < below leaves ties to the lowest ID.
	for (const driverId of [...state.driverCells.keys()].toSorted()) {
		if (busy.has(driverId)) continue;
		const cell = state.driverCells.get(driverId);
		if (cell === undefined) throw new Error(`no cell for ${driverId}`);
		const toPickup = distance(cell, pickup);
		if (nearest !== undefined && toPickup >= nearest.distance) continue;
		nearest = { driverId, distance: toPickup };
	}
	return nearest?.driverId;
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
	const trip: Trip = {
		state: "requested",
		id: request.tripId,
		riderId: request.riderId,
		pickup: request.pickup,
		dropoff: request.dropoff,
		requestedAt: request.tick,
		pendingOffer: null,
	};
	return {
		state: {
			...state,
			trips: new Map(state.trips).set(trip.id, trip),
			queue: [...state.queue, trip.id],
		},
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
