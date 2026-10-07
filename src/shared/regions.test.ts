import { describe, expect, test } from "bun:test";
import { type Cell, cellIn, type Grid } from "./grid.ts";
import { Region, RegionLayout, regionBounds, regionOf } from "./regions.ts";

const grid: Grid = { width: 500, height: 500 };

function cell(x: number, y: number): Cell {
	const result = cellIn(grid, x, y);
	if (!result.ok) throw new Error(`test cell (${x}, ${y}) outside grid`);
	return result.value;
}

function layout(text: string): RegionLayout {
	return RegionLayout.parse(text);
}

describe("RegionLayout", () => {
	test("1x1 is one column and one row", () => {
		expect(RegionLayout.parse("1x1")).toEqual({ columns: 1, rows: 1 });
	});

	test("2x1 is two columns and one row", () => {
		expect(RegionLayout.parse("2x1")).toEqual({ columns: 2, rows: 1 });
	});

	test("2x2 is two columns and two rows", () => {
		expect(RegionLayout.parse("2x2")).toEqual({ columns: 2, rows: 2 });
	});

	test.each(["0x1", "1x0", "2", "2x", "x1", "2x1x1", "-1x1", "1.5x1", ""])(
		"%p is not a layout",
		(text) => {
			expect(RegionLayout.safeParse(text).success).toBe(false);
		},
	);
});

describe("regionOf", () => {
	test("every cell is region 0 with one region", () => {
		expect(regionOf(layout("1x1"), grid, cell(499, 499))).toBe(0);
	});

	test("2x1 puts the left half in region 0", () => {
		expect(regionOf(layout("2x1"), grid, cell(249, 499))).toBe(0);
	});

	test("2x1 puts the right half in region 1", () => {
		expect(regionOf(layout("2x1"), grid, cell(250, 0))).toBe(1);
	});

	test("2x2 numbers regions row-major: bottom left is region 2", () => {
		expect(regionOf(layout("2x2"), grid, cell(0, 250))).toBe(2);
	});

	test("2x2 numbers regions row-major: bottom right is region 3", () => {
		expect(regionOf(layout("2x2"), grid, cell(250, 250))).toBe(3);
	});
});

describe("regionBounds", () => {
	test("one region spans the whole grid", () => {
		expect(regionBounds(layout("1x1"), grid, Region.parse(0))).toEqual({
			min: cell(0, 0),
			max: cell(499, 499),
		});
	});

	test("2x2 region 1 is the top right quarter", () => {
		expect(regionBounds(layout("2x2"), grid, Region.parse(1))).toEqual({
			min: cell(250, 0),
			max: cell(499, 249),
		});
	});

	test("3x1 splits 500 columns into 167, 167 and 166", () => {
		const bounds = [0, 1, 2].map((region) =>
			regionBounds(layout("3x1"), grid, Region.parse(region)),
		);
		expect(bounds.map(({ min, max }) => [min.x, max.x])).toEqual([
			[0, 166],
			[167, 333],
			[334, 499],
		]);
	});

	test("3x1 bounds agree with regionOf at the borders", () => {
		expect(
			[166, 167, 333, 334].map((x) =>
				regionOf(layout("3x1"), grid, cell(x, 0)),
			),
		).toEqual([0, 1, 1, 2]);
	});
});
