import type { Random } from "./random.ts";
import type { Result } from "./result.ts";

export type Grid = { width: number; height: number };

declare const cellBrand: unique symbol;

// Branded so the only way to get a Cell is cellIn: holding one means it is inside a grid.
export type Cell = { readonly x: number; readonly y: number } & {
	readonly [cellBrand]: true;
};

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
	return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
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
