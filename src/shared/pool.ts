// Ride pooling (ADR 0056, 0058): whether a pooled trip can join a partner's driver,
// and the order of their dropoffs. Pure, shared by dispatch and drivers.
import type { Cell } from "./grid.ts";
import { distanceOn, type RoadNetwork } from "./roads.ts";

export type PooledTrip = { pickup: Cell; dropoff: Cell };

// rideSoFar: ticks since the partner's trip.picked_up, null before pickup.
export type Partner = PooledTrip & { rideSoFar: number | null };

// The join ETA of a pooled trip joining its partner's driver, at driverAt in
// dispatch's view; null if the join breaks the join ETA or either rider's
// detour limit. Every distance by road with roads on (ADR 0059); driverAt
// drivable, the trips' cells road cells.
export function joinEtaOf(
	driverAt: Cell,
	partner: Partner,
	joining: PooledTrip,
	roads: RoadNetwork | null,
): number | null {
	const eta =
		partner.rideSoFar === null
			? distanceOn(roads, driverAt, partner.pickup) +
				distanceOn(roads, partner.pickup, joining.pickup)
			: distanceOn(roads, driverAt, joining.pickup);
	if (eta > maxJoinEta) return null;
	const rides = ridesOf(driverAt, partner, joining, roads);
	if (!withinDetourLimit(rides.partner, partner, roads)) return null;
	if (!withinDetourLimit(rides.joining, joining, roads)) return null;
	return eta;
}

// Each rider's whole ride along the pooled route, in ticks.
function ridesOf(
	driverAt: Cell,
	partner: Partner,
	joining: PooledTrip,
	roads: RoadNetwork | null,
): { partner: number; joining: number } {
	const joiningDirect = distanceOn(roads, joining.pickup, joining.dropoff);
	// A driver waiting at an aboard partner's dropoff drops it there first.
	if (
		partner.rideSoFar !== null &&
		driverAt.x === partner.dropoff.x &&
		driverAt.y === partner.dropoff.y
	) {
		return { partner: partner.rideSoFar, joining: joiningDirect };
	}
	const toJoiningPickup =
		partner.rideSoFar === null
			? distanceOn(roads, partner.pickup, joining.pickup)
			: partner.rideSoFar + distanceOn(roads, driverAt, joining.pickup);
	const betweenDropoffs = distanceOn(roads, partner.dropoff, joining.dropoff);
	if (partnerDropsFirst(partner, joining, roads)) {
		const toPartnerDropoff = distanceOn(roads, joining.pickup, partner.dropoff);
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
// dropoffs, so that is the dropoff nearer the joining pickup (by road with
// roads on, ADR 0059).
export function partnerDropsFirst(
	partner: PooledTrip,
	joining: PooledTrip,
	roads: RoadNetwork | null,
): boolean {
	return (
		distanceOn(roads, joining.pickup, partner.dropoff) <=
		distanceOn(roads, joining.pickup, joining.dropoff)
	);
}

// A ride of at most 1.5 x the trip's direct distance, in whole numbers.
function withinDetourLimit(
	ride: number,
	trip: PooledTrip,
	roads: RoadNetwork | null,
): boolean {
	return 2 * ride <= 3 * distanceOn(roads, trip.pickup, trip.dropoff);
}

// The least patience: a joining rider never waits out its driver.
const maxJoinEta = 120;

// The greatest join ETA a pooled trip joins at (ADR 0058): no farther than
// the nearest idle driver's pickup distance (undefined: none idle), and never
// over the cap. Equal joins: a join saves a driver.
export function joinReachOf(nearestIdleDistance: number | undefined): number {
	return Math.min(maxJoinEta, nearestIdleDistance ?? maxJoinEta);
}
