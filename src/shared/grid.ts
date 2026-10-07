import * as z from "zod";
import type { Random } from "./random.ts";
import type { Result } from "./result.ts";

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
	return distanceToCoordinates(a, b.x, b.y);
}

// distance() to a cell held as flat coordinates (batched matching keeps
// drivers' cells in typed arrays, #213).
export function distanceToCoordinates(a: Cell, x: number, y: number): number {
	return Math.abs(a.x - x) + Math.abs(a.y - y);
}

export function randomCell(grid: Grid, random: Random): Cell {
	const x = random.int(0, grid.width - 1);
	const y = random.int(0, grid.height - 1);
	return { x, y } as Cell;
}

// Stays a valid Cell without a grid check: the step lands between two in-grid cells.
export function stepToward(from: Cell, target: Cell): Cell {
	const dx = target.x - from.x;
	const dy = target.y - from.y;
	if (Math.abs(dy) > Math.abs(dx)) {
		return { ...from, y: from.y + Math.sign(dy) } as Cell;
	}
	return { ...from, x: from.x + Math.sign(dx) } as Cell;
}

// SPIKE (#236, not for merge): region layout from SPIKE_REGIONS="<cols>x<rows>".
const spikeLayout = (() => {
	const raw = process.env.SPIKE_REGIONS ?? "1x1";
	const [cols, rows] = raw.split("x").map(Number);
	return { cols: cols ?? 1, rows: rows ?? 1 };
})();
export const spikeCounters = {
	idleCrossings: 0,
	busyCrossings: 0,
	regionDeclines: 0,
	offers: 0,
	moves: 0,
};
export function spikeRegionOf(grid: Grid, x: number, y: number): number {
	const col = Math.min(
		Math.floor((x * spikeLayout.cols) / grid.width),
		spikeLayout.cols - 1,
	);
	const row = Math.min(
		Math.floor((y * spikeLayout.rows) / grid.height),
		spikeLayout.rows - 1,
	);
	return row * spikeLayout.cols + col;
}
process.on("exit", () => {
	if (process.env.SPIKE_REGIONS === undefined) return;
	console.error(
		JSON.stringify({ spike: process.env.SPIKE_REGIONS, ...spikeCounters }),
	);
});
