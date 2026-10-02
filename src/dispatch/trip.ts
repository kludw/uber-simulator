import type { Cell } from "../shared/grid.ts";
import type {
	DriverId,
	RequestTrip,
	RiderId,
	Tick,
	TripId,
} from "../shared/messages.ts";
import type { Result } from "../shared/result.ts";

type TripDetails = {
	id: TripId;
	riderId: RiderId;
	pickup: Cell;
	dropoff: Cell;
	requestedAt: Tick;
	// Drivers whose offer for this trip was declined or expired: never offered
	// it again, and their late replies are stale.
	excludedDrivers: ReadonlySet<DriverId>;
};

export type PendingOffer = { driverId: DriverId; offeredAt: Tick };

// A requested trip without an offer is queued for matching.
type QueuedTrip = TripDetails & { state: "requested"; offer: null };

export type Trip =
	| QueuedTrip
	| (TripDetails & { state: "requested"; offer: PendingOffer })
	| (TripDetails & { state: "matched"; driverId: DriverId });

export type NoPendingOffer = {
	type: "no_pending_offer";
	tripId: TripId;
	driverId: DriverId;
};

export function requestedTrip(request: RequestTrip): Trip {
	return {
		state: "requested",
		id: request.tripId,
		riderId: request.riderId,
		pickup: request.pickup,
		dropoff: request.dropoff,
		requestedAt: request.tick,
		excludedDrivers: new Set(),
		offer: null,
	};
}

// Only queued trips can be offered: the type, not a Result, enforces it.
export function offerTo(
	trip: QueuedTrip,
	driverId: DriverId,
	offeredAt: Tick,
): Trip {
	return { ...trip, offer: { driverId, offeredAt } };
}

export function acceptOffer(
	trip: Trip,
	driverId: DriverId,
): Result<Trip, NoPendingOffer> {
	const offered = offeredTo(trip, driverId);
	if (!offered.ok) return offered;
	const { offer: _offer, ...details } = offered.value;
	return { ok: true, value: { ...details, state: "matched", driverId } };
}

// Declined or expired: the trip is queued again, never offered to driverId.
export function withdrawOffer(
	trip: Trip,
	driverId: DriverId,
): Result<Trip, NoPendingOffer> {
	const offered = offeredTo(trip, driverId);
	if (!offered.ok) return offered;
	return {
		ok: true,
		value: {
			...offered.value,
			offer: null,
			excludedDrivers: new Set(trip.excludedDrivers).add(driverId),
		},
	};
}

function offeredTo(
	trip: Trip,
	driverId: DriverId,
): Result<Extract<Trip, { offer: PendingOffer }>, NoPendingOffer> {
	if (
		trip.state !== "requested" ||
		trip.offer === null ||
		trip.offer.driverId !== driverId
	) {
		return {
			ok: false,
			error: { type: "no_pending_offer", tripId: trip.id, driverId },
		};
	}
	return { ok: true, value: trip };
}
