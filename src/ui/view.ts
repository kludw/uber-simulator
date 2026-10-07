import type { Cell } from "../shared/grid.ts";
import type {
	DriverArrivedAtDropoff,
	DriverArrivedAtPickup,
	DriverId,
	DriversMoved,
	DriversWentOnline,
	SimEvent,
	Tick,
	TripId,
} from "../shared/messages.ts";
import { forEachMove, forEachWentOnline } from "../shared/messages.ts";

type DriverState = "idle" | "en_route" | "at_pickup" | "on_trip" | "at_dropoff";

export type DriverView = {
	state: DriverState;
	cell: Cell;
	previousCell: Cell;
	movedAt: Tick;
};

// One per trip from request until pickup or cancel.
export type WaitingRider = { pickup: Cell; dropoff: Cell; requestedAt: Tick };

// One per trip from match until completion or cancel.
export type ActiveTrip = { driverId: DriverId; pickup: Cell; dropoff: Cell };

export type View = {
	// Last clock.ticked seen; null before the first.
	tick: Tick | null;
	drivers: ReadonlyMap<DriverId, DriverView>;
	driversPerState: Readonly<Record<DriverState, number>>;
	waitingRiders: ReadonlyMap<TripId, WaitingRider>;
	activeTrips: ReadonlyMap<TripId, ActiveTrip>;
	tripsCompleted: number;
	tripsCancelled: number;
	// Over trips seen from request to pickup (pickups of them); null until the
	// first. Trips requested before the UI joined are left out.
	meanTicksToPickup: number | null;
	pickups: number;
};

export function emptyView(): View {
	return {
		tick: null,
		drivers: new Map(),
		driversPerState: {
			idle: 0,
			en_route: 0,
			at_pickup: 0,
			on_trip: 0,
			at_dropoff: 0,
		},
		waitingRiders: new Map(),
		activeTrips: new Map(),
		tripsCompleted: 0,
		tripsCancelled: 0,
		meanTicksToPickup: null,
		pickups: 0,
	};
}

export function applyEvent(view: View, event: SimEvent): View {
	switch (event.type) {
		case "clock.ticked":
			return { ...view, tick: event.tick };
		case "drivers.went_online":
			return withWentOnline(view, event);
		case "drivers.moved":
			return withMoves(view, event);
		case "trip.requested": {
			const waitingRiders = view.waitingRiders as Map<TripId, WaitingRider>;
			waitingRiders.set(event.tripId, {
				pickup: event.pickup,
				dropoff: event.dropoff,
				requestedAt: event.tick,
			});
			return { ...view, waitingRiders };
		}
		case "trip.matched": {
			const next = withDriverState(view, event.driverId, "en_route");
			const rider = view.waitingRiders.get(event.tripId);
			if (rider === undefined) return next;
			const activeTrips = view.activeTrips as Map<TripId, ActiveTrip>;
			activeTrips.set(event.tripId, {
				driverId: event.driverId,
				pickup: rider.pickup,
				dropoff: rider.dropoff,
			});
			return { ...next, activeTrips };
		}
		case "driver.arrived_at_pickup":
			return withArrival(view, event, "at_pickup");
		case "trip.picked_up": {
			const next = withDriverState(
				withoutWaitingRider(view, event.tripId),
				event.driverId,
				"on_trip",
			);
			const rider = view.waitingRiders.get(event.tripId);
			if (rider === undefined) return next;
			const waited = event.tick - rider.requestedAt;
			const pickups = next.pickups + 1;
			const total = (next.meanTicksToPickup ?? 0) * next.pickups + waited;
			return { ...next, pickups, meanTicksToPickup: total / pickups };
		}
		case "driver.arrived_at_dropoff":
			return withArrival(view, event, "at_dropoff");
		case "trip.completed": {
			const next = withoutActiveTrip(view, event.tripId);
			return withDriverState(
				{ ...next, tripsCompleted: next.tripsCompleted + 1 },
				event.driverId,
				"idle",
			);
		}
		case "trip.cancelled": {
			const ended = withoutActiveTrip(
				withoutWaitingRider(view, event.tripId),
				event.tripId,
			);
			const next = { ...ended, tripsCancelled: ended.tripsCancelled + 1 };
			if (event.driverId === null) return next;
			return withDriverState(next, event.driverId, "idle");
		}
		// Offline drivers leave the view (ADR 0032): they emit nothing until
		// back online, so a UI joining mid-run could not count them anyway.
		// Later events naming one (cancel, decline, expiry) find no driver.
		case "driver.went_offline":
			return withoutDriver(view, event.driverId);
		// Offers don't change a driver's state until trip.matched.
		case "trip.offered":
		case "trip.offer_declined":
		case "trip.offer_expired":
			return view;
		default: {
			const unhandled: never = event;
			throw new Error(`unhandled event: ${JSON.stringify(unhandled)}`);
		}
	}
}

function withDriverState(
	view: View,
	driverId: DriverId,
	state: DriverState,
): View {
	const driver = view.drivers.get(driverId);
	if (driver === undefined) return view;
	return withDriver(view, driverId, { ...driver, state });
}

// An unknown driver (UI joined mid-run) appears at the arrival cell; a known
// one is already there, its drivers.moved comes first. A known idle driver's
// arrival is late: over NATS it can follow dispatch's event that freed the
// driver (offer expired, trip cancelled; ADR 0028), so it is ignored.
function withArrival(
	view: View,
	arrival: DriverArrivedAtPickup | DriverArrivedAtDropoff,
	state: DriverState,
): View {
	const driver = view.drivers.get(arrival.driverId);
	if (driver?.state === "idle") return view;
	if (driver !== undefined) {
		return withDriverState(view, arrival.driverId, state);
	}
	return withDriver(view, arrival.driverId, {
		state,
		cell: arrival.cell,
		previousCell: arrival.cell,
		movedAt: arrival.tick,
	});
}

// withDriver, withWentOnline, withMoves and withoutDriver are the only places
// drivers change, so driversPerState always matches drivers.
function withDriver(view: View, driverId: DriverId, driver: DriverView): View {
	const drivers = view.drivers as Map<DriverId, DriverView>; // spike #272: in place
	const driversPerState = { ...view.driversPerState };
	const previous = drivers.get(driverId);
	if (previous !== undefined) driversPerState[previous.state]--;
	driversPerState[driver.state]++;
	drivers.set(driverId, driver);
	return { ...view, drivers, driversPerState };
}

// One copy of drivers per message, not per move: a message carries up to
// 5,000 moves (ADR 0045). A move keeps its driver's state; an unknown driver
// (the UI joined mid-run) is idle, the most common state, until its next
// state event.
function withMoves(view: View, moved: DriversMoved): View {
	const drivers = view.drivers as Map<DriverId, DriverView>; // spike #272: in place
	const driversPerState = { ...view.driversPerState };
	forEachMove(moved, (driverId, cell) => {
		const previous = drivers.get(driverId);
		if (previous === undefined) driversPerState.idle++;
		drivers.set(driverId, {
			state: previous?.state ?? "idle",
			cell,
			previousCell: previous?.cell ?? cell,
			movedAt: moved.tick,
		});
	});
	return { ...view, drivers, driversPerState };
}

// One copy of drivers per message, as for moves: at start a message carries
// up to 5,000 drivers (ADR 0049).
function withWentOnline(view: View, wentOnline: DriversWentOnline): View {
	const drivers = view.drivers as Map<DriverId, DriverView>; // spike #272: in place
	const driversPerState = { ...view.driversPerState };
	forEachWentOnline(wentOnline, (driverId, cell) => {
		const previous = drivers.get(driverId);
		if (previous !== undefined) driversPerState[previous.state]--;
		driversPerState.idle++;
		drivers.set(driverId, {
			state: "idle",
			cell,
			previousCell: cell,
			movedAt: wentOnline.tick,
		});
	});
	return { ...view, drivers, driversPerState };
}

function withoutDriver(view: View, driverId: DriverId): View {
	const previous = view.drivers.get(driverId);
	if (previous === undefined) return view;
	const drivers = view.drivers as Map<DriverId, DriverView>; // spike #272: in place
	const driversPerState = { ...view.driversPerState };
	driversPerState[previous.state]--;
	drivers.delete(driverId);
	return { ...view, drivers, driversPerState };
}

function withoutWaitingRider(view: View, tripId: TripId): View {
	if (!view.waitingRiders.has(tripId)) return view;
	const waitingRiders = view.waitingRiders as Map<TripId, WaitingRider>;
	waitingRiders.delete(tripId);
	return { ...view, waitingRiders };
}

function withoutActiveTrip(view: View, tripId: TripId): View {
	if (!view.activeTrips.has(tripId)) return view;
	const activeTrips = view.activeTrips as Map<TripId, ActiveTrip>;
	activeTrips.delete(tripId);
	return { ...view, activeTrips };
}
