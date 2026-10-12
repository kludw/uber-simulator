// SPIKE (#339): driver earnings behind SPIKE_* env knobs, read once at
// module load. Not merged; the ADR decides the real switch.
import type { DriverId } from "./messages.ts";
import type { Random } from "./random.ts";
import type { Fare } from "./surge.ts";

const env = Bun.env;

// SPIKE_EARNINGS=on: dispatch puts the trip's fare on trip.completed and
// trip_status completed, drivers keep online-period earnings and (with shifts)
// end the period at their target. SPIKE_TARGET_MIN / _MAX in dollars;
// SPIKE_TARGET=off keeps earnings but never ends a period early.
// SPIKE_SHARE: driver share of a fare.
export const spikeEarnings = {
	on: env.SPIKE_EARNINGS === "on",
	share: Number(env.SPIKE_SHARE ?? "0.75"),
	target: env.SPIKE_TARGET !== "off",
	targetMin: Math.round(Number(env.SPIKE_TARGET_MIN ?? "15") * 100),
	targetMax: Math.round(Number(env.SPIKE_TARGET_MAX ?? "30") * 100),
};

// Cents, rounded once per trip.
export function driverShareOf(fare: Fare): number {
	return Math.round(fare * spikeEarnings.share);
}

// Cents, uniform in [targetMin, targetMax], one draw per driver from its own
// child stream: independent of every other draw.
export function earningsTarget(random: Random, driverId: DriverId): number {
	return random
		.child(`earnings:${driverId}`)
		.int(spikeEarnings.targetMin, spikeEarnings.targetMax);
}
