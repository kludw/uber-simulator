// SPIKE (#331): driver ratings, knobs per SPIKE_* env.
import type { DriverId } from "./messages.ts";
import type { Random } from "./random.ts";

const env = (name: string, fallback: number) =>
	Number(process.env[name] ?? String(fallback));

export const spikeRatings = {
	// Riders rate (rider brain); dispatch acts on ratings it sees.
	on: process.env.SPIKE_RATINGS === "on",
	// Driver quality uniform in [qualityMin, qualityMax).
	qualityMin: env("SPIKE_QUALITY_MIN", 3.5),
	qualityMax: env("SPIKE_QUALITY_MAX", 5),
	// Pickup wait: free up to waitFree ticks, then 1 star per waitPerStar.
	waitFree: env("SPIKE_WAIT_FREE", 60),
	waitPerStar: env("SPIKE_WAIT_PER_STAR", 120),
	// Detour (ride / direct - 1): stars lost per 1.0 of detour.
	detourStars: env("SPIKE_DETOUR_STARS", 2),
	// Noise uniform in [-noise, noise).
	noise: env("SPIKE_NOISE", 1),
	// Dispatch: cells added to a driver's pickup distance per star below 5.
	weight: env("SPIKE_WEIGHT", 10),
	// Pseudo-ratings at priorMean added to every driver's average.
	priorCount: env("SPIKE_PRIOR", 0),
	priorMean: env("SPIKE_PRIOR_MEAN", 5),
};

// A driver's quality as riders see it: one draw per driver, the same for
// every rider (same label, same stream).
export function driverQuality(riders: Random, driverId: DriverId): number {
	const { qualityMin, qualityMax } = spikeRatings;
	return (
		qualityMin +
		(qualityMax - qualityMin) * riders.child(`quality:${driverId}`).float()
	);
}

export function starsOf(
	quality: number,
	trip: { waitTicks: number; rideTicks: number; direct: number },
	noise: Random,
): number {
	const s = spikeRatings;
	const waitPenalty = Math.max(0, trip.waitTicks - s.waitFree) / s.waitPerStar;
	const detour = Math.max(0, trip.rideTicks / trip.direct - 1);
	const score =
		quality -
		waitPenalty -
		s.detourStars * detour +
		s.noise * (2 * noise.float() - 1);
	return Math.min(5, Math.max(1, Math.round(score)));
}

// Cells added to pickup distance for a driver with this rating sum and count.
export function penaltyOf(sum: number, count: number): number {
	const s = spikeRatings;
	const n = count + s.priorCount;
	const average =
		n === 0 ? s.priorMean : (sum + s.priorCount * s.priorMean) / n;
	return Math.round(s.weight * (5 - average));
}

export const maxPenalty = () => Math.round(spikeRatings.weight * 4);
