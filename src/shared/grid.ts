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
