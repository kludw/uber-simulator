import type { Cell } from "../shared/grid.ts";
import type {
	DriverArrivedAtDropoff,
	DriverArrivedAtPickup,
	DriverId,
	SimEvent,
	Tick,
	TripId,
} from "../shared/messages.ts";

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
		case "driver.went_online":
			return withDriver(view, event.driverId, {
				state: "idle",
				cell: event.cell,
				previousCell: event.cell,
				movedAt: event.tick,
			});
		case "driver.moved": {
			// Unknown driver: the UI joined mid-run. Its state is unknown until
			// its next state event; idle is the most common.
			const driver = view.drivers.get(event.driverId);
			return withDriver(view, event.driverId, {
				state: driver?.state ?? "idle",
				cell: event.cell,
				previousCell: driver?.cell ?? event.cell,
				movedAt: event.tick,
			});
		}
		case "trip.requested": {
			const waitingRiders = new Map(view.waitingRiders);
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
			const activeTrips = new Map(view.activeTrips);
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
// one is already there, its driver.moved comes first. A known idle driver's
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

// The only place drivers change, so driversPerState always matches drivers.
function withDriver(view: View, driverId: DriverId, driver: DriverView): View {
	const drivers = new Map(view.drivers);
	const driversPerState = { ...view.driversPerState };
	const previous = drivers.get(driverId);
	if (previous !== undefined) driversPerState[previous.state]--;
	driversPerState[driver.state]++;
	drivers.set(driverId, driver);
	return { ...view, drivers, driversPerState };
}

function withoutWaitingRider(view: View, tripId: TripId): View {
	if (!view.waitingRiders.has(tripId)) return view;
	const waitingRiders = new Map(view.waitingRiders);
	waitingRiders.delete(tripId);
	return { ...view, waitingRiders };
}

function withoutActiveTrip(view: View, tripId: TripId): View {
	if (!view.activeTrips.has(tripId)) return view;
	const activeTrips = new Map(view.activeTrips);
	activeTrips.delete(tripId);
	return { ...view, activeTrips };
}
