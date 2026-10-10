// SPIKE (#327): ride pooling rules shared by dispatch and drivers. Env knobs
// for the experiment only; never merged.
import { type Cell, distance } from "./grid.ts";

export const spikePool = {
	on: process.env.SPIKE_POOL === "on",
	// Share of riders opting in.
	share: Number(process.env.SPIKE_POOL_SHARE ?? "0.5"),
	// Each rider's ride at most (1 + detour) x its direct distance.
	detour: Number(process.env.SPIKE_POOL_DETOUR ?? "0.5"),
	// Pooled fare = fare x discount factor.
	fareFactor: Number(process.env.SPIKE_POOL_FARE ?? "0.75"),
	// "pickup": join only before the first rider's pickup; "aboard": also
	// while the first rider rides.
	join: process.env.SPIKE_POOL_JOIN ?? "pickup",
	// Max cells from the first pickup to the second (0 = no limit).
	maxPickupGap: Number(process.env.SPIKE_POOL_GAP ?? "0"),
	// Max ticks from the partner's driver to the joining pickup (0 = none).
	maxEta: Number(process.env.SPIKE_POOL_ETA ?? "0"),
	// Join only within this many ticks of the nearest idle driver's pickup
	// distance, when one is idle (-1 = no such check).
	idleSlack: Number(process.env.SPIKE_POOL_SLACK ?? "-1"),
};

export type Leg = { pickup: Cell; dropoff: Cell };

// Stops: a's pickup, b's pickup, then the dropoff order with the shorter
// remaining route from b's pickup, ties to a's first.
export function aDropsFirst(from: Cell, a: Cell, b: Cell): boolean {
	return distance(from, a) + distance(a, b) <= distance(from, b) + distance(b, a);
}

// Each rider's ride along the pooled route, from its pickup.
export function pooledRides(
	a: Leg,
	b: Leg,
): { rideA: number; rideB: number; route: number } {
	const gap = distance(a.pickup, b.pickup);
	if (aDropsFirst(b.pickup, a.dropoff, b.dropoff)) {
		const toA = distance(b.pickup, a.dropoff);
		const aToB = distance(a.dropoff, b.dropoff);
		return { rideA: gap + toA, rideB: toA + aToB, route: gap + toA + aToB };
	}
	const toB = distance(b.pickup, b.dropoff);
	const bToA = distance(b.dropoff, a.dropoff);
	return { rideA: gap + toB + bToA, rideB: toB, route: gap + toB + bToA };
}

// a: the trip already holding the driver (not yet picked up), b: joining.
export function canShare(a: Leg, b: Leg): boolean {
	if (
		spikePool.maxPickupGap > 0 &&
		distance(a.pickup, b.pickup) > spikePool.maxPickupGap
	) {
		return false;
	}
	const { rideA, rideB } = pooledRides(a, b);
	const limit = 1 + spikePool.detour;
	return (
		rideA <= limit * distance(a.pickup, a.dropoff) &&
		rideB <= limit * distance(b.pickup, b.dropoff)
	);
}

// a aboard at cell `at`: a's remaining ride and b's, against limits from a's
// direct distance (rideSoFar already ridden).
export function canShareAboard(
	at: Cell,
	a: Leg,
	rideSoFar: number,
	b: Leg,
): boolean {
	const gap = distance(at, b.pickup);
	if (spikePool.maxPickupGap > 0 && gap > spikePool.maxPickupGap) return false;
	let rideA: number;
	let rideB: number;
	if (aDropsFirst(b.pickup, a.dropoff, b.dropoff)) {
		const toA = distance(b.pickup, a.dropoff);
		rideA = rideSoFar + gap + toA;
		rideB = toA + distance(a.dropoff, b.dropoff);
	} else {
		const toB = distance(b.pickup, b.dropoff);
		rideA = rideSoFar + gap + toB + distance(b.dropoff, a.dropoff);
		rideB = toB;
	}
	const limit = 1 + spikePool.detour;
	return (
		rideA <= limit * distance(a.pickup, a.dropoff) &&
		rideB <= limit * distance(b.pickup, b.dropoff)
	);
}
