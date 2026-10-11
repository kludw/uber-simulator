import { type Cell, cellIn, distance, type Grid } from "../shared/grid.ts";
import type {
	DriverId,
	Message,
	RiderId,
	Tick,
	TripCancelled,
	TripCompleted,
	TripId,
	TripPickedUp,
} from "../shared/messages.ts";
import { forEachMove, forEachWentOnline } from "../shared/messages.ts";

// The checker's own trip model, rebuilt from trip.* events alone: importing
// dispatch's Trip would make the check agree with the code it checks.
// pooled: from trip.requested (ADR 0056).
type TripView = { pickup: Cell; dropoff: Cell; pooled: boolean } & (
	| { state: "requested"; offeredTo: DriverId | null }
	| { state: "matched" | "picked_up"; driverId: DriverId }
	| { state: "completed" | "cancelled" }
);

type TripEvent = Extract<Message, { type: `trip.${string}` }>;

export type Violation =
	| {
			type: "illegal_trip_transition";
			tick: Tick;
			tripId: TripId;
			from: TripView["state"] | "unknown";
			event: TripEvent["type"];
	  }
	// The named driver would be freed of an offer it never got (stuck driver).
	| {
			type: "cancelled_before_offer";
			tick: Tick;
			tripId: TripId;
			driverId: DriverId;
	  }
	// expectedDriverId: matched driver, else pending-offer driver, else null.
	| {
			type: "cancel_names_wrong_driver";
			tick: Tick;
			tripId: TripId;
			driverId: DriverId | null;
			expectedDriverId: DriverId | null;
	  }
	| {
			type: "driver_has_two_active_trips";
			tick: Tick;
			driverId: DriverId;
			activeTripId: TripId;
			tripId: TripId;
	  }
	// ADR 0056: a third trip; activeTripIds: the driver's trips before it.
	| {
			type: "driver_over_capacity";
			tick: Tick;
			driverId: DriverId;
			activeTripIds: TripId[];
			tripId: TripId;
	  }
	// cell: the driver's last reported cell, null if it never reported one.
	| {
			type: "driver_not_at_pickup" | "driver_not_at_dropoff";
			tick: Tick;
			tripId: TripId;
			driverId: DriverId;
			cell: Cell | null;
	  }
	| {
			type: "driver_moved_too_fast";
			tick: Tick;
			driverId: DriverId;
			from: Cell;
			to: Cell;
	  }
	| { type: "driver_left_grid"; tick: Tick; driverId: DriverId; cell: Cell }
	// ADR 0032. Offers to an offline driver are not violations: dispatch's view
	// may be stale, and the driver declines.
	| { type: "offline_driver_moved"; tick: Tick; driverId: DriverId; cell: Cell }
	| {
			type: "offline_driver_matched";
			tick: Tick;
			tripId: TripId;
			driverId: DriverId;
	  }
	| {
			type: "driver_went_offline_with_active_trip";
			tick: Tick;
			driverId: DriverId;
			tripId: TripId;
	  }
	// ADR 0054: a rider that declined surge never requests a trip, and
	// declines at most once. tick: the second of the two events.
	| { type: "declined_rider_requested"; tick: Tick; riderId: RiderId };

// What the log has shown so far, rebuilt only from events.
type LogState = {
	trips: Map<TripId, TripView>;
	offeredDrivers: Map<TripId, Set<DriverId>>;
	// Driver -> its matched or picked-up trips, in match order.
	activeTrips: Map<DriverId, TripId[]>;
	// Last reported position and the tick it was reported at.
	driverPositions: Map<DriverId, { cell: Cell; tick: Tick }>;
	// From driver.went_offline until drivers.went_online; no trip event changes it.
	offlineDrivers: Set<DriverId>;
	// Riders in a trip.requested / a rider.declined_surge.
	requestingRiders: Set<RiderId>;
	decliningRiders: Set<RiderId>;
};

export function checkInvariants(
	eventLog: readonly Message[],
	grid: Grid,
): Violation[] {
	const checker = createInvariantChecker(grid);
	for (const message of eventLog) checker.observe(message);
	return checker.violations();
}

export type InvariantChecker = {
	observe(message: Message): void;
	// Violations among the messages observed so far, in the order found.
	violations(): Violation[];
};

// Checks a run as it happens (ADR 0033): memory grows with trips and
// drivers, not with messages.
export function createInvariantChecker(grid: Grid): InvariantChecker {
	const violations: Violation[] = [];
	const log: LogState = {
		trips: new Map(),
		offeredDrivers: new Map(),
		activeTrips: new Map(),
		driverPositions: new Map(),
		offlineDrivers: new Set(),
		requestingRiders: new Set(),
		decliningRiders: new Set(),
	};
	return {
		observe: (message) => observe(log, grid, violations, message),
		violations: () => [...violations],
	};
}

// Appends message's violations to violations, then records message in log.
function observe(
	log: LogState,
	grid: Grid,
	violations: Violation[],
	message: Message,
): void {
	switch (message.type) {
		case "drivers.went_online":
			forEachWentOnline(message, (driverId, cell) => {
				log.offlineDrivers.delete(driverId);
				log.driverPositions.set(driverId, { tick: message.tick, cell });
			});
			break;
		case "driver.went_offline": {
			const tripId = log.activeTrips.get(message.driverId)?.[0];
			if (tripId !== undefined) {
				violations.push({
					type: "driver_went_offline_with_active_trip",
					tick: message.tick,
					driverId: message.driverId,
					tripId,
				});
			}
			log.offlineDrivers.add(message.driverId);
			log.driverPositions.set(message.driverId, message);
			break;
		}
		case "drivers.moved":
			forEachMove(message, (driverId, cell) => {
				observeMove(log, grid, violations, message.tick, driverId, cell);
			});
			break;
		case "rider.declined_surge": {
			const { tick, riderId } = message;
			if (
				log.decliningRiders.has(riderId) ||
				log.requestingRiders.has(riderId)
			) {
				violations.push({ type: "declined_rider_requested", tick, riderId });
			}
			log.decliningRiders.add(riderId);
			break;
		}
		case "trip.requested": {
			const { tick, riderId } = message;
			if (log.decliningRiders.has(riderId)) {
				violations.push({ type: "declined_rider_requested", tick, riderId });
			}
			log.requestingRiders.add(riderId);
			violations.push(...checkTripEvent(log, message));
			break;
		}
		case "trip.offered":
		case "trip.offer_declined":
		case "trip.offer_expired":
		case "trip.matched":
		case "trip.picked_up":
		case "trip.completed":
		case "trip.cancelled":
			violations.push(...checkTripEvent(log, message));
			break;
	}
}

// One entry of drivers.moved, checked as its own move (ADR 0045).
function observeMove(
	log: LogState,
	grid: Grid,
	violations: Violation[],
	tick: Tick,
	driverId: DriverId,
	cell: Cell,
): void {
	if (log.offlineDrivers.has(driverId)) {
		violations.push({ type: "offline_driver_moved", tick, driverId, cell });
	}
	violations.push(...checkStep(log, tick, driverId, cell));
	if (!cellIn(grid, cell.x, cell.y).ok) {
		violations.push({ type: "driver_left_grid", tick, driverId, cell });
	}
	log.driverPositions.set(driverId, { tick, cell });
}

// At most one 4-neighbor step per tick, measured from the last report.
function checkStep(
	log: LogState,
	tick: Tick,
	driverId: DriverId,
	cell: Cell,
): Violation[] {
	const last = log.driverPositions.get(driverId);
	if (last === undefined) return [];
	if (tick > last.tick && distance(last.cell, cell) <= 1) return [];
	return [
		{
			type: "driver_moved_too_fast",
			tick,
			driverId,
			from: last.cell,
			to: cell,
		},
	];
}

// A cancel must name the driver to free: the matched one, else the one holding
// the pending offer, else null. A driver never offered the trip is reported as
// cancelled_before_offer alone, the more specific violation.
function checkCancel(
	log: LogState,
	trip: TripView,
	cancel: TripCancelled,
): Violation[] {
	const { tick, tripId, driverId } = cancel;
	if (driverId !== null && !log.offeredDrivers.get(tripId)?.has(driverId)) {
		return [{ type: "cancelled_before_offer", tick, tripId, driverId }];
	}
	const expectedDriverId = driverToFree(trip);
	if (driverId === expectedDriverId) return [];
	return [
		{
			type: "cancel_names_wrong_driver",
			tick,
			tripId,
			driverId,
			expectedDriverId,
		},
	];
}

function driverToFree(trip: TripView): DriverId | null {
	switch (trip.state) {
		case "requested":
			return trip.offeredTo;
		case "matched":
		case "picked_up":
			return trip.driverId;
		default:
			return null;
	}
}

function checkTripEvent(log: LogState, event: TripEvent): Violation[] {
	const violations: Violation[] = [];
	const trip = log.trips.get(event.tripId);
	if (event.type === "trip.offered") {
		log.offeredDrivers
			.getOrInsertComputed(event.tripId, () => new Set())
			.add(event.driverId);
	}
	if (event.type === "trip.cancelled" && trip !== undefined) {
		violations.push(...checkCancel(log, trip, event));
	}
	const next = transition(trip, event);
	if (next === null) {
		violations.push({
			type: "illegal_trip_transition",
			tick: event.tick,
			tripId: event.tripId,
			from: trip?.state ?? "unknown",
			event: event.type,
		});
		return violations;
	}
	log.trips.set(event.tripId, next);
	const arrival = arrivalTarget(event);
	if (arrival !== null) {
		const cell = log.driverPositions.get(arrival.driverId)?.cell ?? null;
		if (cell === null || !sameCell(cell, next[arrival.at])) {
			violations.push({
				type: `driver_not_at_${arrival.at}`,
				tick: arrival.tick,
				tripId: arrival.tripId,
				driverId: arrival.driverId,
				cell,
			});
		}
	}
	if (next.state === "matched") {
		if (log.offlineDrivers.has(next.driverId)) {
			violations.push({
				type: "offline_driver_matched",
				tick: event.tick,
				tripId: event.tripId,
				driverId: next.driverId,
			});
		}
		const activeTripIds = log.activeTrips.get(next.driverId) ?? [];
		violations.push(...checkCapacity(log, event, next, activeTripIds));
		log.activeTrips.set(next.driverId, [...activeTripIds, event.tripId]);
	}
	const ended = next.state === "completed" || next.state === "cancelled";
	if (ended && (trip?.state === "matched" || trip?.state === "picked_up")) {
		endActiveTrip(log, trip.driverId, event.tripId);
	}
	return violations;
}

// At most two trips, two only when both are pooled (ADR 0056).
function checkCapacity(
	log: LogState,
	event: TripEvent,
	next: Extract<TripView, { driverId: DriverId }>,
	activeTripIds: readonly TripId[],
): Violation[] {
	const [activeTripId] = activeTripIds;
	if (activeTripId === undefined) return [];
	if (activeTripIds.length >= 2) {
		return [
			{
				type: "driver_over_capacity",
				tick: event.tick,
				driverId: next.driverId,
				activeTripIds: [...activeTripIds],
				tripId: event.tripId,
			},
		];
	}
	const pooledPair = next.pooled && log.trips.get(activeTripId)?.pooled;
	if (pooledPair) return [];
	return [
		{
			type: "driver_has_two_active_trips",
			tick: event.tick,
			driverId: next.driverId,
			activeTripId,
			tripId: event.tripId,
		},
	];
}

function endActiveTrip(log: LogState, driverId: DriverId, tripId: TripId) {
	const left = (log.activeTrips.get(driverId) ?? []).filter(
		(activeTripId) => activeTripId !== tripId,
	);
	if (left.length === 0) log.activeTrips.delete(driverId);
	else log.activeTrips.set(driverId, left);
}

// The cell a trip event requires its driver to be at, if any.
function arrivalTarget(
	event: TripEvent,
):
	| (TripPickedUp & { at: "pickup" })
	| (TripCompleted & { at: "dropoff" })
	| null {
	switch (event.type) {
		case "trip.picked_up":
			return { ...event, at: "pickup" };
		case "trip.completed":
			return { ...event, at: "dropoff" };
		default:
			return null;
	}
}

function sameCell(a: Cell, b: Cell): boolean {
	return a.x === b.x && a.y === b.y;
}

// Legal next trip state for event, or null. Every event naming a driver must
// name the trip's driver (offered, matched, or picked up).
function transition(
	trip: TripView | undefined,
	event: TripEvent,
): TripView | null {
	if (event.type === "trip.requested") {
		if (trip !== undefined) return null;
		const { pickup, dropoff } = event;
		const pooled = event.pooled === true;
		return { pickup, dropoff, pooled, state: "requested", offeredTo: null };
	}
	if (trip === undefined) return null;
	const { pickup, dropoff, pooled } = trip;
	switch (event.type) {
		case "trip.offered":
			if (trip.state !== "requested" || trip.offeredTo !== null) return null;
			return { ...trip, offeredTo: event.driverId };
		case "trip.offer_declined":
		case "trip.offer_expired":
			if (!isOfferedTo(trip, event.driverId)) return null;
			return { ...trip, offeredTo: null };
		case "trip.matched":
			if (!isOfferedTo(trip, event.driverId)) return null;
			return {
				pickup,
				dropoff,
				pooled,
				state: "matched",
				driverId: event.driverId,
			};
		case "trip.picked_up":
			if (trip.state !== "matched" || trip.driverId !== event.driverId) {
				return null;
			}
			return { ...trip, state: "picked_up" };
		case "trip.completed":
			if (trip.state !== "picked_up" || trip.driverId !== event.driverId) {
				return null;
			}
			return { pickup, dropoff, pooled, state: "completed" };
		case "trip.cancelled":
			if (trip.state !== "requested" && trip.state !== "matched") return null;
			return { pickup, dropoff, pooled, state: "cancelled" };
		default: {
			const unhandled: never = event;
			throw new Error(`unhandled trip event: ${unhandled}`);
		}
	}
}

function isOfferedTo(
	trip: TripView,
	driverId: DriverId,
): trip is Extract<TripView, { state: "requested" }> {
	return trip.state === "requested" && trip.offeredTo === driverId;
}
