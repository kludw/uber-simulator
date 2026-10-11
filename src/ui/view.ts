import { type DriverIndex, driverIndexOf } from "../shared/fleet.ts";
import { type Cell, type Coordinate, cellAt } from "../shared/grid.ts";
import {
	type DriverArrivedAtDropoff,
	type DriverArrivedAtPickup,
	type DriverId,
	type DriversMoved,
	type DriversWentOnline,
	forEachDriverAt,
	type SimEvent,
	type Tick,
	type TripId,
	type ZonesPriced,
} from "../shared/messages.ts";
import type { Region } from "../shared/regions.ts";
import { baseSurge, type Fare, fareOf } from "../shared/surge.ts";

type DriverState = "idle" | "en_route" | "at_pickup" | "on_trip" | "at_dropoff";

// Code k + 1 in Drivers.states is driverStates[k]; 0 is a driver not shown
// (offline, or not seen yet).
const driverStates: readonly DriverState[] = [
	"idle",
	"en_route",
	"at_pickup",
	"on_trip",
	"at_dropoff",
];
const notShown = 0;

export type DriverView = {
	state: DriverState;
	cell: Cell;
	previousCell: Cell;
	movedAt: Tick;
};

// Drivers by driver index (ADR 0053), one entry per driver of the fleet:
// applying a message costs its own size, never the fleet's. Coordinates fit
// 16 bits: the grid is 500 × 500 (spec).
type Drivers = {
	xs: Uint16Array;
	ys: Uint16Array;
	previousXs: Uint16Array;
	previousYs: Uint16Array;
	movedAt: Uint32Array;
	states: Uint8Array;
	// Pooling (ADR 0056), by the trip events seen: trips the driver holds
	// (0-2), riders aboard, and 1 from a join until it holds no trip, so a
	// trip completed then shared its driver. All 0 while idle or not shown.
	trips: Uint8Array;
	aboard: Uint8Array;
	sharing: Uint8Array;
};

// One per trip from request until pickup or cancel. fare: the trip's, or its
// base fare with surge off (as the summary counts it, ADR 0054).
export type WaitingRider = {
	pickup: Cell;
	dropoff: Cell;
	requestedAt: Tick;
	fare: Fare;
	pooled?: true;
};

// One per trip from match until completion or cancel.
export type ActiveTrip = {
	driverId: DriverId;
	pickup: Cell;
	dropoff: Cell;
	fare: Fare;
};

// Owned by the page and updated in place by applyEvent (as brains own their
// state, ADR 0033): readers take a snapshot to compare before and after.
export type View = {
	// Last clock.ticked seen; null before the first.
	tick: Tick | null;
	// Sized by the fleetSize of drivers.* messages; empty until the first.
	drivers: Drivers;
	driversPerState: Record<DriverState, number>;
	waitingRiders: Map<TripId, WaitingRider>;
	activeTrips: Map<TripId, ActiveTrip>;
	tripsCompleted: number;
	tripsCancelled: number;
	// Over trips seen from request to pickup (pickups of them); null until the
	// first. Trips requested before the UI joined are left out.
	meanTicksToPickup: number | null;
	pickups: number;
	// Surge (ADR 0054): each region's latest zones.priced, its zones above
	// 1.0; empty until the first, and with surge off.
	zonesPriced: Map<Region, ZonesPriced["zones"]>;
	ridersDeclined: number;
	// Integer cents: fares of the trips seen from request to completion.
	revenue: number;
	// Pooling (ADR 0056): pooled trips seen requested; completed trips that
	// had another trip on their driver while it was shown.
	tripsPooled: number;
	tripsShared: number;
};

export function emptyView(): View {
	return {
		tick: null,
		drivers: driversOfFleet(0),
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
		zonesPriced: new Map(),
		ridersDeclined: 0,
		revenue: 0,
		tripsPooled: 0,
		tripsShared: 0,
	};
}

function driversOfFleet(fleetSize: number): Drivers {
	return {
		xs: new Uint16Array(fleetSize),
		ys: new Uint16Array(fleetSize),
		previousXs: new Uint16Array(fleetSize),
		previousYs: new Uint16Array(fleetSize),
		movedAt: new Uint32Array(fleetSize),
		states: new Uint8Array(fleetSize),
		trips: new Uint8Array(fleetSize),
		aboard: new Uint8Array(fleetSize),
		sharing: new Uint8Array(fleetSize),
	};
}

// The fleetSize of the latest drivers.* message; 0 before the first.
export function fleetSizeOf(view: View): number {
	return view.drivers.states.length;
}

// Visits the drivers shown, in index order.
export function forEachDriver(
	view: View,
	visit: (index: DriverIndex, driver: DriverView) => void,
): void {
	const { xs, ys, previousXs, previousYs, movedAt } = view.drivers;
	for (let i = 0; i < view.drivers.states.length; i++) {
		const state = stateAt(view, i);
		if (state === null) continue;
		visit(i as DriverIndex, {
			state,
			cell: cellAt((xs[i] ?? 0) as Coordinate, (ys[i] ?? 0) as Coordinate),
			previousCell: cellAt(
				(previousXs[i] ?? 0) as Coordinate,
				(previousYs[i] ?? 0) as Coordinate,
			),
			movedAt: (movedAt[i] ?? 0) as Tick,
		});
	}
}

// A pool: the shown driver holds two trips (ADR 0056).
export function holdsTwoTrips(view: View, index: DriverIndex): boolean {
	return view.drivers.trips[index] === 2;
}

export function applyEvent(view: View, event: SimEvent): void {
	startOverOnNewRun(view, event);
	switch (event.type) {
		case "clock.ticked":
			view.tick = event.tick;
			return;
		case "drivers.went_online":
			applyWentOnline(view, event);
			return;
		case "drivers.moved":
			applyMoves(view, event);
			return;
		case "trip.requested":
			view.waitingRiders.set(event.tripId, {
				pickup: event.pickup,
				dropoff: event.dropoff,
				requestedAt: event.tick,
				fare: event.fare ?? fareOf(event, baseSurge),
				pooled: event.pooled,
			});
			if (event.pooled) view.tripsPooled++;
			return;
		case "trip.matched": {
			const rider = view.waitingRiders.get(event.tripId);
			applyMatch(view, event.driverId, rider?.pooled === true);
			if (rider === undefined) return;
			view.activeTrips.set(event.tripId, {
				driverId: event.driverId,
				pickup: rider.pickup,
				dropoff: rider.dropoff,
				fare: rider.fare,
			});
			return;
		}
		case "driver.arrived_at_pickup":
			applyArrival(view, event, "at_pickup");
			return;
		case "trip.picked_up": {
			applyPickup(view, event.driverId);
			const rider = view.waitingRiders.get(event.tripId);
			if (rider === undefined) return;
			view.waitingRiders.delete(event.tripId);
			const waited = event.tick - rider.requestedAt;
			const total = (view.meanTicksToPickup ?? 0) * view.pickups + waited;
			view.pickups++;
			view.meanTicksToPickup = total / view.pickups;
			return;
		}
		case "driver.arrived_at_dropoff":
			applyArrival(view, event, "at_dropoff");
			return;
		case "trip.completed":
			view.revenue += view.activeTrips.get(event.tripId)?.fare ?? 0;
			view.activeTrips.delete(event.tripId);
			view.tripsCompleted++;
			endTrip(view, event.driverId, "completed");
			return;
		case "trip.cancelled": {
			// A pooled trip cancelled before its match names the driver of its
			// pending offer: a join's leaves the driver's trip alone.
			const offerOnly =
				view.waitingRiders.get(event.tripId)?.pooled === true &&
				!view.activeTrips.has(event.tripId);
			view.waitingRiders.delete(event.tripId);
			view.activeTrips.delete(event.tripId);
			view.tripsCancelled++;
			if (event.driverId !== null && !offerOnly) {
				endTrip(view, event.driverId, "cancelled");
			}
			return;
		}
		// Offline drivers leave the view (ADR 0032): they emit nothing until
		// back online, so a UI joining mid-run could not count them anyway.
		// Later events naming one (cancel, decline, expiry) find no driver.
		case "driver.went_offline": {
			const index = shownIndexOf(view, event.driverId);
			if (index === null) return;
			setState(view, index, null);
			return;
		}
		// Offers don't change a driver's state until trip.matched.
		case "trip.offered":
		case "trip.offer_declined":
		case "trip.offer_expired":
			return;
		case "zones.priced":
			view.zonesPriced.set(event.region, event.zones);
			return;
		case "rider.declined_surge":
			view.ridersDeclined++;
			return;
		// Shown once the panel counts ratings (ADR 0057, #333).
		case "rider.rated_driver":
			return;
		default: {
			const unhandled: never = event;
			throw new Error(`unhandled event: ${JSON.stringify(unhandled)}`);
		}
	}
}

// A new run (live, or a replay watched again) even at the same fleet size:
// nothing of the old one may linger. The clock publishes from tick 1, so a
// tick 0 message after a tick is the new run's start-up (drivers going
// online before its first clock tick); the view takes tick 0 so its own
// tick 1 doesn't start over again. A clock tick going back is a run not
// starting at 0 (a replay --from-tick); one skipping a tick means the view
// missed events (a replay --from-tick past where the last one ended, or a
// live page that lost a clock.ticked as a slow consumer). The same tick
// again or the next one keeps the view. A first tick never starts over: a
// mid-run join keeps what it has seen.
function startOverOnNewRun(view: View, event: SimEvent): void {
	if (view.tick === null) return;
	const startUp = event.tick === 0 && view.tick !== 0;
	const clockJumped =
		event.type === "clock.ticked" &&
		(event.tick < view.tick || event.tick > view.tick + 1);
	if (!startUp && !clockJumped) return;
	Object.assign(view, emptyView(), { tick: event.tick });
}

// The index of a shown driver, else null: an ID not made by driverIdAt, an
// index outside the fleet (or no fleet size yet), or a driver not shown are
// all ignored like an unknown driver (ADR 0053).
function shownIndexOf(view: View, driverId: DriverId): number | null {
	const index = driverIndexOf(driverId);
	if (index === null || stateAt(view, index) === null) return null;
	return index;
}

// A pooled trip matched to a driver holding one trip joins it (ADR 0056):
// a driver waiting at a stop stays there, one on its way heads to a pickup
// next (pickups come first in a pool's route). Any other match is the
// driver's only trip, so a lost trip end can't leave a stale one.
function applyMatch(view: View, driverId: DriverId, pooled: boolean): void {
	const index = shownIndexOf(view, driverId);
	if (index === null) return;
	const drivers = view.drivers;
	if (pooled && drivers.trips[index] === 1) {
		drivers.trips[index] = 2;
		drivers.sharing[index] = 1;
		if (stateAt(view, index) === "on_trip") setState(view, index, "en_route");
		return;
	}
	setState(view, index, "en_route");
	drivers.trips[index] = 1;
	drivers.aboard[index] = 0;
	drivers.sharing[index] = 0;
}

function applyPickup(view: View, driverId: DriverId): void {
	const index = shownIndexOf(view, driverId);
	if (index === null) return;
	view.drivers.aboard[index] = (view.drivers.aboard[index] ?? 0) + 1;
	setState(view, index, movingState(view, index));
}

// The driver of a pool goes on with its other trip; any other driver is idle
// (also when the view missed the trip's match: the UI joined mid-run).
function endTrip(
	view: View,
	driverId: DriverId,
	end: "completed" | "cancelled",
): void {
	const index = shownIndexOf(view, driverId);
	if (index === null) return;
	const drivers = view.drivers;
	if (end === "completed" && drivers.sharing[index] === 1) view.tripsShared++;
	if (drivers.trips[index] !== 2) {
		setState(view, index, "idle");
		return;
	}
	drivers.trips[index] = 1;
	// Only a picked-up trip completes; a cancelled one was never aboard, so a
	// driver waiting at a dropoff waits at the other trip's and stays.
	if (end === "cancelled") {
		if (stateAt(view, index) === "at_dropoff") return;
	} else {
		drivers.aboard[index] = Math.max(0, (drivers.aboard[index] ?? 0) - 1);
	}
	setState(view, index, movingState(view, index));
}

// A driver between stops: heading to a pickup while a trip it holds has its
// rider still waiting, else on trip to a dropoff. Without the match seen
// (the UI joined mid-run), a pickup means on trip, as before pooling.
function movingState(view: View, index: number): DriverState {
	const { trips, aboard } = view.drivers;
	return (trips[index] ?? 0) > (aboard[index] ?? 0) ? "en_route" : "on_trip";
}

// A known idle driver's arrival is late: over NATS it can follow dispatch's
// event that freed the driver (offer expired, trip cancelled; ADR 0028), so
// it is ignored. An unknown driver appears with its next move (ADR 0053).
function applyArrival(
	view: View,
	arrival: DriverArrivedAtPickup | DriverArrivedAtDropoff,
	state: DriverState,
): void {
	const index = shownIndexOf(view, arrival.driverId);
	if (index === null) return;
	if (stateAt(view, index) === "idle") return;
	setState(view, index, state);
}

function stateAt(view: View, index: number): DriverState | null {
	return driverStates[(view.drivers.states[index] ?? notShown) - 1] ?? null;
}

// The only place a driver's state changes, so driversPerState always matches
// drivers.states. null: not shown.
function setState(view: View, index: number, state: DriverState | null): void {
	const previous = stateAt(view, index);
	if (previous !== null) view.driversPerState[previous]--;
	if (state !== null) view.driversPerState[state]++;
	view.drivers.states[index] =
		state === null ? notShown : driverStates.indexOf(state) + 1;
	if (state !== null && state !== "idle") return;
	view.drivers.trips[index] = 0;
	view.drivers.aboard[index] = 0;
	view.drivers.sharing[index] = 0;
}

// A message of another fleet size is a new run (or a replay): nothing of the
// old one may linger (ADR 0053), so the view starts over, keeping the tick.
// From no fleet size yet, trip changes seen so far are kept.
function fitFleet(view: View, fleetSize: number): void {
	const current = view.drivers.states.length;
	if (fleetSize === current) return;
	if (current !== 0) Object.assign(view, emptyView(), { tick: view.tick });
	view.drivers = driversOfFleet(fleetSize);
}

// A move keeps its driver's state; an unknown driver (the UI joined mid-run)
// is idle, the most common state, until its next state event.
function applyMoves(view: View, moved: DriversMoved): void {
	fitFleet(view, moved.fleetSize);
	const drivers = view.drivers;
	forEachDriverAt(moved, (index, x, y) => {
		const shown = stateAt(view, index) !== null;
		drivers.previousXs[index] = shown ? (drivers.xs[index] ?? x) : x;
		drivers.previousYs[index] = shown ? (drivers.ys[index] ?? y) : y;
		drivers.xs[index] = x;
		drivers.ys[index] = y;
		drivers.movedAt[index] = moved.tick;
		if (!shown) setState(view, index, "idle");
	});
}

function applyWentOnline(view: View, wentOnline: DriversWentOnline): void {
	fitFleet(view, wentOnline.fleetSize);
	const drivers = view.drivers;
	forEachDriverAt(wentOnline, (index, x, y) => {
		drivers.previousXs[index] = x;
		drivers.previousYs[index] = y;
		drivers.xs[index] = x;
		drivers.ys[index] = y;
		drivers.movedAt[index] = wentOnline.tick;
		setState(view, index, "idle");
	});
}
