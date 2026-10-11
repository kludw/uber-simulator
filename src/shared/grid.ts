import * as z from "zod";
import type { Random } from "./random.ts";
import type { Result } from "./result.ts";
import {
	canDrive,
	isRoad,
	roadDistance,
	roadDistanceFrom,
	roadStep,
	spikeRoads,
} from "./roads.ts";

// SPIKE (#335): roads on when SPIKE_ROADS names a network.
const roads = spikeRoads;

export function manhattan(a: Cell, b: Cell): number {
	return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function onRoad(cell: Cell): boolean {
	return roads === null || isRoad(roads, cell.x, cell.y);
}

export function drivable(cell: Cell): boolean {
	return roads === null || canDrive(roads, cell.x, cell.y);
}

export function maxDistance(grid: Grid): number {
	return roads === null ? grid.width + grid.height - 2 : roads.maxDistance;
}

export type Grid = { width: number; height: number };

// v1 grid (docs/spec.md); services and the UI must agree on it.
export const specGrid: Grid = { width: 500, height: 500 };

// Branded so a Cell comes only from cellIn (inside this grid) or from parsing
// a message. A message can't know the grid, so the schema checks integer,
// non-negative coordinates only; staying inside the grid is a spec invariant
// checked over the event log (src/sim/invariants.ts).
// A non-negative integer: Cell's rule for each of its coordinates.
// drivers.moved carries its cells as arrays of them (ADR 0047).
export const Coordinate = z.int().nonnegative().brand<"Coordinate">();
export type Coordinate = z.infer<typeof Coordinate>;

export const Cell = z
	.object({ x: Coordinate, y: Coordinate })
	.readonly()
	.brand<"Cell">();
export type Cell = z.infer<typeof Cell>;

// Any two coordinates make a Cell: Cell checks nothing more.
export function cellAt(x: Coordinate, y: Coordinate): Cell {
	return { x, y } as Cell;
}

export type CellOutsideGrid = {
	type: "cell_outside_grid";
	x: number;
	y: number;
};

export function cellIn(
	grid: Grid,
	x: number,
	y: number,
): Result<Cell, CellOutsideGrid> {
	const inside =
		Number.isInteger(x) &&
		Number.isInteger(y) &&
		x >= 0 &&
		x < grid.width &&
		y >= 0 &&
		y < grid.height;
	if (!inside) {
		return { ok: false, error: { type: "cell_outside_grid", x, y } };
	}
	return { ok: true, value: { x, y } as Cell };
}

export function distance(a: Cell, b: Cell): number {
	if (roads !== null) return roadDistance(roads, a.x, a.y, b.x, b.y);
	return distanceToCoordinates(a, b.x, b.y);
}

// distance() to a cell held as flat coordinates (batched matching keeps
// drivers' cells in typed arrays, #213).
export function distanceToCoordinates(a: Cell, x: number, y: number): number {
	if (roads !== null) return roadDistanceFrom(roads, a.x, a.y, x, y);
	return Math.abs(a.x - x) + Math.abs(a.y - y);
}

export function randomCell(grid: Grid, random: Random): Cell {
	if (roads !== null) {
		for (;;) {
			const x = random.int(0, grid.width - 1);
			const y = random.int(0, grid.height - 1);
			if (isRoad(roads, x, y)) return { x, y } as Cell;
		}
	}
	const x = random.int(0, grid.width - 1);
	const y = random.int(0, grid.height - 1);
	return { x, y } as Cell;
}

// Stays a valid Cell without a grid check: the step lands between two in-grid cells.
export function stepToward(from: Cell, target: Cell): Cell {
	if (roads !== null) {
		const [x, y] = roadStep(
			roads,
			from.x,
			from.y,
			target.x,
			target.y,
			gridStep,
		);
		return { x, y } as Cell;
	}
	const dx = target.x - from.x;
	const dy = target.y - from.y;
	if (Math.abs(dy) > Math.abs(dx)) {
		return { ...from, y: from.y + Math.sign(dy) } as Cell;
	}
	return { ...from, x: from.x + Math.sign(dx) } as Cell;
}

function gridStep(
	x: number,
	y: number,
	tx: number,
	ty: number,
): [number, number] {
	const dx = tx - x;
	const dy = ty - y;
	if (Math.abs(dy) > Math.abs(dx)) return [x, y + Math.sign(dy)];
	return [x + Math.sign(dx), y];
}
