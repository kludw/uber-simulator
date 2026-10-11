// Driver ratings (ADR 0057): the stars a rider gives its driver, the driver
// quality they measure, and the rating penalty dispatch adds to a driver's
// pickup distance. Pure, shared by riders and dispatch.
import * as z from "zod";
import type { DriverId } from "./messages.ts";
import type { Random } from "./random.ts";

// A rating's value: an integer 1-5.
export const Stars = z.int().min(1).max(5).brand<"Stars">();
export type Stars = z.infer<typeof Stars>;

// The stars a rider gives its driver: the driver's quality less its wait
// and detour penalties, plus noise drawn from the trip's stream.
// waitTicks: request to pickup; rideTicks: pickup to completion.
export function starsOf(
	quality: number,
	ride: { waitTicks: number; rideTicks: number; directDistance: number },
	noise: Random,
): Stars {
	const waitPenalty = Math.max(0, ride.waitTicks - 60) / 120;
	const score = quality - waitPenalty - detourPenaltyOf(ride) + noiseOf(noise);
	return Math.min(5, Math.max(1, Math.round(score))) as Stars;
}

// 2 stars per 100% of ride ticks over direct distance (pooling's 50% limit
// costs at most 1). Riders redraw a dropoff on their pickup, so a direct
// distance of 0 is a caller bug. Clamped at 0: dispatch stamps pickup and
// completion with the last tick it saw, and over NATS a driver can get its
// trip.picked_up before a tick dispatch already saw (no order across
// publishers), so a ride can measure a tick short of its direct distance;
// that is not a better-than-direct ride.
function detourPenaltyOf(ride: {
	rideTicks: number;
	directDistance: number;
}): number {
	if (ride.directDistance <= 0) {
		throw new Error("direct distance must be positive");
	}
	return 2 * Math.max(0, ride.rideTicks / ride.directDistance - 1);
}

// Uniform in [-1, 1).
function noiseOf(noise: Random): number {
	return 2 * noise.float() - 1;
}

// Cells of pickup distance one star below 5 is worth: a driver one star
// better wins against one up to this much nearer. A constant, not a flag.
export const ratingWeight = 10;

// The rating penalty of a driver from its stars sum and ratings count, in
// cells: 0 to 4 × ratingWeight, 0 unrated.
export function ratingPenaltyOf(sum: number, count: number): number {
	if (count === 0) return 0;
	return Math.round(ratingWeight * (5 - sum / count));
}

// How riders find a driver: uniform in [3.5, 5.0), the same for every rider
// (one label per driver on the riders' stream). Hidden: never in a message.
export function driverQuality(riders: Random, driverId: DriverId): number {
	return 3.5 + 1.5 * riders.child(`quality:${driverId}`).float();
}
