import { type Cell, cellIn, distance, type Grid } from "../shared/grid.ts";
import type {
	DriverId,
	DriverMoved,
	Message,
	Tick,
	TripCancelled,
	TripCompleted,
	TripId,
	TripPickedUp,
} from "../shared/messages.ts";

// The checker's own trip model, rebuilt from trip.* events alone: importing
// dispatch's Trip would make the check agree with the code it checks.
type TripView = { pickup: Cell; dropoff: Cell } & (
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
	| { type: "driver_left_grid"; tick: Tick; driverId: DriverId; cell: Cell };

// What the log has shown so far, rebuilt only from events.
type LogState = {
	trips: Map<TripId, TripView>;
	offeredDrivers: Map<TripId, Set<DriverId>>;
	// Driver -> its matched or picked-up trip.
	activeTrips: Map<DriverId, TripId>;
	// Last reported position and the tick it was reported at.
	driverPositions: Map<DriverId, { cell: Cell; tick: Tick }>;
};

export function checkInvariants(
	eventLog: readonly Message[],
	grid: Grid,
): Violation[] {
	const violations: Violation[] = [];
	const log: LogState = {
		trips: new Map(),
		offeredDrivers: new Map(),
		activeTrips: new Map(),
		driverPositions: new Map(),
	};
	for (const message of eventLog) {
		switch (message.type) {
			case "driver.went_online":
				log.driverPositions.set(message.driverId, message);
				break;
			case "driver.moved":
				violations.push(...checkMove(log, message));
				if (!cellIn(grid, message.cell.x, message.cell.y).ok) {
					violations.push({
						type: "driver_left_grid",
						tick: message.tick,
						driverId: message.driverId,
						cell: message.cell,
					});
				}
				log.driverPositions.set(message.driverId, message);
				break;
			case "trip.requested":
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
	return violations;
}

// At most one 4-neighbor step per tick, measured from the last report.
function checkMove(log: LogState, move: DriverMoved): Violation[] {
	const last = log.driverPositions.get(move.driverId);
	if (last === undefined) return [];
	if (move.tick > last.tick && distance(last.cell, move.cell) <= 1) return [];
	return [
		{
			type: "driver_moved_too_fast",
			tick: move.tick,
			driverId: move.driverId,
			from: last.cell,
			to: move.cell,
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
		const activeTripId = log.activeTrips.get(next.driverId);
		if (activeTripId !== undefined) {
			violations.push({
				type: "driver_has_two_active_trips",
				tick: event.tick,
				driverId: next.driverId,
				activeTripId,
				tripId: event.tripId,
			});
		}
		log.activeTrips.set(next.driverId, event.tripId);
	}
	const ended = next.state === "completed" || next.state === "cancelled";
	if (
		ended &&
		(trip?.state === "matched" || trip?.state === "picked_up") &&
		log.activeTrips.get(trip.driverId) === event.tripId
	) {
		log.activeTrips.delete(trip.driverId);
	}
	return violations;
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
		return { pickup, dropoff, state: "requested", offeredTo: null };
	}
	if (trip === undefined) return null;
	const { pickup, dropoff } = trip;
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
			return { pickup, dropoff, state: "matched", driverId: event.driverId };
		case "trip.picked_up":
			if (trip.state !== "matched" || trip.driverId !== event.driverId) {
				return null;
			}
			return { ...trip, state: "picked_up" };
		case "trip.completed":
			if (trip.state !== "picked_up" || trip.driverId !== event.driverId) {
				return null;
			}
			return { pickup, dropoff, state: "completed" };
		case "trip.cancelled":
			if (trip.state !== "requested" && trip.state !== "matched") return null;
			return { pickup, dropoff, state: "cancelled" };
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
