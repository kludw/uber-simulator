// Driver earnings (ADR 0060): the driver share of a fare and the earnings
// target a driver means to reach per online period. Pure, shared by drivers,
// the summary, the checker and the UI.
import type { DriverId } from "./messages.ts";
import type { Random } from "./random.ts";
import type { Fare } from "./surge.ts";

// Cents. Binds in about half the online periods at README loads (ADR 0060).
const earningsTargetRange = { min: 1500, max: 3000 };

// Cents: 75% of the fare, halves rounded up, in integers so the report's SQL
// (intDiv(fare * 3 + 2, 4)) gives the same cent; a float round in ClickHouse
// rounds halves to even (254 -> 190, not 191).
export function driverShareOf(fare: Fare): number {
	return Math.floor((3 * fare + 2) / 4);
}

// Cents, uniform in $15-30, one draw from the driver's own child stream of the
// shard's: the same per driver ID and seed, shifting no other draw.
export function earningsTarget(random: Random, driverId: DriverId): number {
	return random
		.child(`earnings:${driverId}`)
		.int(earningsTargetRange.min, earningsTargetRange.max);
}
