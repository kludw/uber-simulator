// Surge pricing (ADR 0054): surge zones, the surge of a zone, and fares.
// Pure, shared by dispatch (prices), riders (quotes), the summary, and the UI.
import * as z from "zod";
import { type Cell, Coordinate, cellAt, distance, type Grid } from "./grid.ts";
import { type Region, type RegionLayout, regionBounds } from "./regions.ts";

// Surge zones are zoneCells x zoneCells squares of the grid, numbered
// row-major from 0. On the spec grid: 10 x 10 zones of 500 m.
const zoneCells = 50;

export const Zone = z.int().nonnegative().brand<"Zone">();
export type Zone = z.infer<typeof Zone>;

export function zoneOf(grid: Grid, cell: Cell): Zone {
	const column = Math.floor(cell.x / zoneCells);
	const row = Math.floor(cell.y / zoneCells);
	return (row * zoneColumns(grid) + column) as Zone;
}

export function zoneCount(grid: Grid): number {
	return zoneColumns(grid) * Math.ceil(grid.height / zoneCells);
}

// Manhattan distance between zones in zone columns and rows (ADR 0055).
export function zoneDistance(grid: Grid, a: Zone, b: Zone): number {
	const columns = zoneColumns(grid);
	return (
		Math.abs((a % columns) - (b % columns)) +
		Math.abs(Math.floor(a / columns) - Math.floor(b / columns))
	);
}

// Inclusive corners of the zone's part inside the region, null if the zone
// lies outside it. A zone cut by a region border is priced per part, each by
// its region's dispatch.
export function zonePartBounds(
	layout: RegionLayout,
	grid: Grid,
	region: Region,
	zone: Zone,
): { min: Cell; max: Cell } | null {
	const tile = regionBounds(layout, grid, region);
	const column = zone % zoneColumns(grid);
	const row = Math.floor(zone / zoneColumns(grid));
	const minX = Math.max(column * zoneCells, tile.min.x);
	const minY = Math.max(row * zoneCells, tile.min.y);
	const maxX = Math.min((column + 1) * zoneCells - 1, tile.max.x);
	const maxY = Math.min((row + 1) * zoneCells - 1, tile.max.y);
	if (minX > maxX || minY > maxY) return null;
	return {
		min: cellAt(Coordinate.parse(minX), Coordinate.parse(minY)),
		max: cellAt(Coordinate.parse(maxX), Coordinate.parse(maxY)),
	};
}

// A fare multiplier: 1.0 to 2.0 (the cap) in tenths.
export const Surge = z
	.number()
	.min(1)
	.max(2)
	.refine((surge) => Number.isInteger(Number((surge * 10).toFixed(6))), {
		error: "surge is not a whole number of tenths",
	})
	.brand<"Surge">();
export type Surge = z.infer<typeof Surge>;

// No surge: a zone not priced, a rider with no quote, a trip without a price
// (surge off) at base fare.
export const baseSurge = Surge.parse(1);

// A zone's surge from its unmatched trips (requested, no driver yet) against
// its idle drivers: twice as many unmatched trips as idle drivers is the cap.
export function surgeOf(unmatched: number, idle: number): Surge {
	const tenths = Math.round((unmatched / Math.max(idle, 1)) * 10);
	return (Math.min(20, Math.max(10, tenths)) / 10) as Surge;
}

// Integer cents: $2.50 plus $2 per km (2 cents per 10 m cell), times surge.
export const Fare = z.int().positive().brand<"Fare">();
export type Fare = z.infer<typeof Fare>;

export function fareOf(pickup: Cell, dropoff: Cell, surge: Surge): Fare {
	return Math.round((250 + 2 * distance(pickup, dropoff)) * surge) as Fare;
}

// Cents as dollars, e.g. $4,321.50: how revenue is printed and shown.
export function dollars(cents: number): string {
	return `$${(cents / 100).toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

function zoneColumns(grid: Grid): number {
	return Math.ceil(grid.width / zoneCells);
}
