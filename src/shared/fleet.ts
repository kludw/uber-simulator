import * as z from "zod";
import type { DriverId } from "./messages.ts";

// A driver's place in its run's fleet, 0 <= index < fleet size: shard s's
// driver i is s × driversPerShard + i (ADR 0052).
export const DriverIndex = z.int().nonnegative().brand<"DriverIndex">();
export type DriverIndex = z.infer<typeof DriverIndex>;

// The only place a driver ID is made (ADR 0052): "d-" + index, zero-padded
// to the digits of fleetSize - 1, so plain string order (ordered by ID) is
// index order. One table per fleet size, each entry made on first use.
const tables = new Map<number, DriverId[]>();

export function driverIdAt(fleetSize: number, index: DriverIndex): DriverId {
	if (index >= fleetSize) {
		throw new Error(`driver index ${index} outside fleet of ${fleetSize}`);
	}
	let table = tables.get(fleetSize);
	if (table === undefined) {
		table = [];
		tables.set(fleetSize, table);
	}
	const known = table[index];
	if (known !== undefined) return known;
	const width = String(fleetSize - 1).length;
	// Matches DriverId's pattern by construction.
	const made = `d-${String(index).padStart(width, "0")}` as DriverId;
	table[index] = made;
	return made;
}

const madeId = /^d-(\d+)$/;

// The index driverIdAt made a driver ID from; null for any other ID (the
// schema allows other tokens). Needs no fleet size: padding only orders IDs.
export function driverIndexOf(driverId: DriverId): DriverIndex | null {
	const digits = madeId.exec(driverId)?.[1];
	if (digits === undefined) return null;
	return Number(digits) as DriverIndex;
}
