import { describe, expect, test } from "bun:test";
import { type Cell, cellIn, distance, type Grid } from "./grid.ts";

const grid: Grid = { width: 500, height: 500 };

function cell(x: number, y: number): Cell {
	const result = cellIn(grid, x, y);
	if (!result.ok) throw new Error(`test cell (${x}, ${y}) outside grid`);
	return result.value;
}

describe("cellIn", () => {
	test("origin is inside the grid", () => {
		const result = cellIn(grid, 0, 0);
		expect(result).toMatchObject({ ok: true, value: { x: 0, y: 0 } });
	});

	test("x equal to width is outside the grid", () => {
		const result = cellIn(grid, 500, 0);
		expect(result).toEqual({
			ok: false,
			error: { type: "cell_outside_grid", x: 500, y: 0 },
		});
	});

	test("negative x is outside the grid", () => {
		const result = cellIn(grid, -1, 3);
		expect(result).toEqual({
			ok: false,
			error: { type: "cell_outside_grid", x: -1, y: 3 },
		});
	});

	test("y equal to height is outside the grid", () => {
		const result = cellIn(grid, 0, 500);
		expect(result).toEqual({
			ok: false,
			error: { type: "cell_outside_grid", x: 0, y: 500 },
		});
	});

	test("far corner is inside the grid", () => {
		const result = cellIn(grid, 499, 499);
		expect(result).toMatchObject({ ok: true, value: { x: 499, y: 499 } });
	});

	test("non-integer coordinate is not a cell", () => {
		const result = cellIn(grid, 1.5, 2);
		expect(result).toEqual({
			ok: false,
			error: { type: "cell_outside_grid", x: 1.5, y: 2 },
		});
	});
});

describe("distance", () => {
	test("is the Manhattan distance between cells", () => {
		expect(distance(cell(1, 2), cell(4, 6))).toBe(7);
	});

	test("from a cell to itself is zero", () => {
		const a = cell(3, 8);
		expect(distance(a, a)).toBe(0);
	});
});
