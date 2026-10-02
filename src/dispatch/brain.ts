import type { Cell, Grid } from "../shared/grid.ts";
import type {
	DriverId,
	DriverMoved,
	DriverWentOnline,
	RequestTrip,
	RequestTripAccepted,
	RequestTripRejected,
	RiderId,
	Tick,
	TripId,
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
};

// Trips kept in request order: the FIFO queue matching will consume.
// Driver cells as last reported in events; may be stale (ADR 0018).
export type DispatchState = {
	grid: Grid;
	trips: Trip[];
	driverCells: ReadonlyMap<DriverId, Cell>;
};

export type DispatchInput = RequestTrip | DriverWentOnline | DriverMoved;

type DispatchOutput = RequestTripAccepted | RequestTripRejected | TripRequested;

type Decision = { state: DispatchState; outputs: DispatchOutput[] };

export function startDispatch(config: { grid: Grid }): DispatchState {
	return { grid: config.grid, trips: [], driverCells: new Map() };
}

export function decideDispatch(
	state: DispatchState,
	input: DispatchInput,
	_random: Random,
): Decision {
	switch (input.type) {
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

function onRequestTrip(state: DispatchState, request: RequestTrip): Decision {
	if (state.trips.some((trip) => trip.id === request.tripId)) {
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
	};
	return {
		state: { ...state, trips: [...state.trips, trip] },
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

export function knownDriverCell(
	state: DispatchState,
	driverId: DriverId,
): Cell | undefined {
	return state.driverCells.get(driverId);
}
