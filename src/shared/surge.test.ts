import { describe, expect, test } from "bun:test";
import { type Cell, cellIn, type Grid } from "./grid.ts";
import { Region, RegionLayout } from "./regions.ts";
import {
	baseSurge,
	dollars,
	Fare,
	fareOf,
	Surge,
	surgeOf,
	Zone,
	zoneOf,
	zonePartBounds,
} from "./surge.ts";

const grid: Grid = { width: 500, height: 500 };

function cell(x: number, y: number): Cell {
	const result = cellIn(grid, x, y);
	if (!result.ok) throw new Error(`test cell (${x}, ${y}) outside grid`);
	return result.value;
}

describe("zoneOf", () => {
	test("the top-left cell is zone 0", () => {
		expect(zoneOf(grid, cell(0, 0))).toBe(Zone.parse(0));
	});

	test("zones are 50 cells wide", () => {
		expect(zoneOf(grid, cell(50, 0))).toBe(Zone.parse(1));
	});

	test("zones are numbered row-major, 10 per row on the spec grid", () => {
		expect(zoneOf(grid, cell(49, 50))).toBe(Zone.parse(10));
	});

	test("the bottom-right cell is the last zone", () => {
		expect(zoneOf(grid, cell(499, 499))).toBe(Zone.parse(99));
	});
});

describe("zonePartBounds", () => {
	function bounds(text: string, region: number, zone: number) {
		return zonePartBounds(
			RegionLayout.parse(text),
			grid,
			Region.parse(region),
			Zone.parse(zone),
		);
	}

	test("with one region a zone's part is the whole zone", () => {
		expect(bounds("1x1", 0, 11)).toEqual({
			min: cell(50, 50),
			max: cell(99, 99),
		});
	});

	test("a zone inside a region is whole in it", () => {
		expect(bounds("2x1", 1, 9)).toEqual({
			min: cell(450, 0),
			max: cell(499, 49),
		});
	});

	test("a zone outside a region has no part in it", () => {
		expect(bounds("2x1", 0, 9)).toBeNull();
	});

	test("a zone cut by a region border has a part on each side", () => {
		// 3x1: region 0 is x 0-166, region 1 x 167-333; zone 3 is x 150-199.
		expect([bounds("3x1", 0, 3), bounds("3x1", 1, 3)]).toEqual([
			{ min: cell(150, 0), max: cell(166, 49) },
			{ min: cell(167, 0), max: cell(199, 49) },
		]);
	});
});

describe("Surge", () => {
	test.each([1, 1.3, 2])("%p is a surge", (surge) => {
		expect(Surge.safeParse(surge).success).toBe(true);
	});

	test.each([0.9, 2.1, 1.25, Number.NaN])("%p is not a surge", (surge) => {
		expect(Surge.safeParse(surge).success).toBe(false);
	});
});

describe("surgeOf", () => {
	// [unmatched trips, idle drivers, surge], worked examples from ADR 0054.
	test.each([
		[0, 5, 1],
		[1, 0, 1],
		[2, 0, 2],
		[3, 2, 1.5],
		[4, 3, 1.3],
		[100, 1, 2],
	])(
		"%p unmatched trips against %p idle drivers is %p",
		(unmatched, idle, surge) => {
			expect(surgeOf(unmatched, idle)).toBe(Surge.parse(surge));
		},
	);
});

describe("fareOf", () => {
	test("is $2.50 plus 2 cents per cell at 1.0", () => {
		expect(fareOf(cell(0, 0), cell(100, 50), Surge.parse(1))).toBe(
			Fare.parse(550),
		);
	});

	test("is multiplied by the surge", () => {
		expect(fareOf(cell(0, 0), cell(100, 50), Surge.parse(1.5))).toBe(
			Fare.parse(825),
		);
	});

	test("rounds to whole cents", () => {
		expect(fareOf(cell(0, 0), cell(1, 0), Surge.parse(1.3))).toBe(
			Fare.parse(328),
		);
	});
});

describe("dollars", () => {
	test("writes cents as dollars with thousands separators and two decimals", () => {
		expect(dollars(432_150)).toBe("$4,321.50");
	});

	test("writes whole dollars with two decimals", () => {
		expect(dollars(300)).toBe("$3.00");
	});
});

describe("baseSurge", () => {
	// $2.50 + 1 cell × 2 cents, unmultiplied.
	test("prices a fare at base price", () => {
		expect(fareOf(cell(0, 0), cell(1, 0), baseSurge)).toBe(Fare.parse(252));
	});
});
