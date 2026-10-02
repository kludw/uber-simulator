import { describe, expect, test } from "bun:test";
import {
	type Cell,
	cellIn,
	distance,
	type Grid,
	randomCell,
	stepToward,
} from "./grid.ts";
import { createRandom } from "./random.ts";

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

describe("stepToward", () => {
	test("moves along x when x has more remaining distance", () => {
		expect(stepToward(cell(0, 0), cell(3, 1))).toEqual(cell(1, 0));
	});

	test("moves along y when y has more remaining distance", () => {
		expect(stepToward(cell(0, 0), cell(1, 3))).toEqual(cell(0, 1));
	});

	test("moves along x when both axes have equal remaining distance", () => {
		expect(stepToward(cell(2, 2), cell(4, 4))).toEqual(cell(3, 2));
	});

	test("moves in the negative direction toward a target behind", () => {
		expect(stepToward(cell(5, 5), cell(5, 2))).toEqual(cell(5, 4));
	});

	test("stays on the target cell when already there", () => {
		expect(stepToward(cell(7, 3), cell(7, 3))).toEqual(cell(7, 3));
	});

	test("reaches the target in exactly distance steps", () => {
		const from = cell(9, 2);
		const target = cell(4, 6);
		let position = from;
		for (let step = 0; step < 9; step++) {
			position = stepToward(position, target);
		}
		expect(position).toEqual(target);
	});
});

describe("randomCell", () => {
	test("is always inside the grid", () => {
		const small: Grid = { width: 3, height: 2 };
		const random = createRandom(11);
		const cells = Array.from({ length: 1_000 }, () =>
			randomCell(small, random),
		);
		expect(
			cells.every(
				(drawn) => drawn.x >= 0 && drawn.x < 3 && drawn.y >= 0 && drawn.y < 2,
			),
		).toBe(true);
	});
});
