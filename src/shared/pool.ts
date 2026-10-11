// Ride pooling (ADR 0056): whether a pooled trip can join a partner's driver,
// and the order of their dropoffs. Pure, shared by dispatch and drivers.
import { type Cell, distance } from "./grid.ts";

export type PooledTrip = { pickup: Cell; dropoff: Cell };

// rideSoFar: ticks since the partner's trip.picked_up, null before pickup.
export type Partner = PooledTrip & { rideSoFar: number | null };

// The join ETA of a pooled trip joining its partner's driver, at driverAt in
// dispatch's view; null if the join breaks the join ETA or either rider's
// detour limit.
export function joinEtaOf(
	driverAt: Cell,
	partner: Partner,
	joining: PooledTrip,
	reach: number = maxJoinEta,
): number | null {
	const eta =
		partner.rideSoFar === null
			? distance(driverAt, partner.pickup) +
				distance(partner.pickup, joining.pickup)
			: distance(driverAt, joining.pickup);
	if (eta > reach) return null;
	const rides = ridesOf(driverAt, partner, joining);
	if (!withinDetourLimit(rides.partner, partner)) return null;
	if (!withinDetourLimit(rides.joining, joining)) return null;
	return eta;
}

// Each rider's whole ride along the pooled route, in ticks.
function ridesOf(
	driverAt: Cell,
	partner: Partner,
	joining: PooledTrip,
): { partner: number; joining: number } {
	const joiningDirect = distance(joining.pickup, joining.dropoff);
	// A driver waiting at an aboard partner's dropoff drops it there first.
	if (partner.rideSoFar !== null && distance(driverAt, partner.dropoff) === 0) {
		return { partner: partner.rideSoFar, joining: joiningDirect };
	}
	const toJoiningPickup =
		partner.rideSoFar === null
			? distance(partner.pickup, joining.pickup)
			: partner.rideSoFar + distance(driverAt, joining.pickup);
	const betweenDropoffs = distance(partner.dropoff, joining.dropoff);
	if (partnerDropsFirst(partner, joining)) {
		const toPartnerDropoff = distance(joining.pickup, partner.dropoff);
		return {
			partner: toJoiningPickup + toPartnerDropoff,
			joining: toPartnerDropoff + betweenDropoffs,
		};
	}
	return {
		partner: toJoiningPickup + joiningDirect + betweenDropoffs,
		joining: joiningDirect,
	};
}

// After the joining pickup, the dropoff with the shorter remaining route
// first, ties to the partner's. Both routes end with the leg between the
// dropoffs, so that is the dropoff nearer the joining pickup.
export function partnerDropsFirst(
	partner: PooledTrip,
	joining: PooledTrip,
): boolean {
	return (
		distance(joining.pickup, partner.dropoff) <=
		distance(joining.pickup, joining.dropoff)
	);
}

// A ride of at most 1.5 x the trip's direct distance, in whole numbers.
function withinDetourLimit(ride: number, trip: PooledTrip): boolean {
	return 2 * ride <= 3 * distance(trip.pickup, trip.dropoff);
}

// The least patience: a joining rider never waits out its driver.
const maxJoinEta = 120;

// SPIKE (#361): how far a join may be, given the nearest idle driver's
// distance to the joining pickup (null: none). SPIKE_JOIN_MARGIN unset = the
// 0056 rule (cap only).
const spikeMargin = process.env.SPIKE_JOIN_MARGIN;
export function joinReach(idleEta: number | null): number {
	if (spikeMargin === undefined || idleEta === null) return maxJoinEta;
	return Math.min(maxJoinEta, idleEta + Number(spikeMargin));
}
