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
export const Cell = z
	.object({ x: z.int().nonnegative(), y: z.int().nonnegative() })
	.readonly()
	.brand<"Cell">();
export type Cell = z.infer<typeof Cell>;

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
		return { ...from, y: from.y + Math.sign(dy) };
	}
	return { ...from, x: from.x + Math.sign(dx) };
}
