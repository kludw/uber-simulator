import { describe, expect, test } from "bun:test";
import type { Cell } from "../shared/grid.ts";
import type { Tick } from "../shared/messages.ts";
import {
	cellToPixel,
	driverPosition,
	noTickTiming,
	observeTick,
	tickFraction,
} from "./render.ts";
import type { DriverView } from "./view.ts";

const grid = { width: 500, height: 500 };

function cell(x: number, y: number): Cell {
	return { x, y } as Cell;
}

describe("cellToPixel", () => {
	test("maps a cell to its center on a canvas the grid's shape", () => {
		expect(
			cellToPixel(cell(0, 499), grid, { width: 1000, height: 1000 }),
		).toEqual({ x: 1, y: 999 });
	});

	test("fits the grid to a wide canvas's height, centered horizontally", () => {
		expect(
			cellToPixel(cell(0, 0), grid, { width: 1500, height: 1000 }),
		).toEqual({
			x: 251,
			y: 1,
		});
	});

	test("fits the grid to a tall canvas's width, centered vertically", () => {
		expect(
			cellToPixel(cell(0, 0), grid, { width: 1000, height: 1500 }),
		).toEqual({
			x: 1,
			y: 251,
		});
	});
});

describe("driverPosition", () => {
	// Moved from (10, 20) to (11, 20) on tick 7.
	const driver: DriverView = {
		state: "idle",
		cell: cell(11, 20),
		previousCell: cell(10, 20),
		movedAt: 7 as Tick,
	};

	test("is at the previous cell at the start of the tick it moved", () => {
		expect(driverPosition(driver, 7 as Tick, 0)).toEqual({ x: 10, y: 20 });
	});

	test("is halfway between cells halfway through the tick it moved", () => {
		expect(driverPosition(driver, 7 as Tick, 0.5)).toEqual({ x: 10.5, y: 20 });
	});

	test("is at the current cell at the end of the tick it moved", () => {
		expect(driverPosition(driver, 7 as Tick, 1)).toEqual({ x: 11, y: 20 });
	});

	test("is at the current cell once the move is older than the tick", () => {
		expect(driverPosition(driver, 8 as Tick, 0.5)).toEqual({ x: 11, y: 20 });
	});

	test("stays at the current cell while the next tick is late", () => {
		expect(driverPosition(driver, 7 as Tick, 1.5)).toEqual({ x: 11, y: 20 });
	});

	test("is at the current cell before any tick is seen", () => {
		expect(driverPosition(driver, null, 0)).toEqual({ x: 11, y: 20 });
	});
});

describe("tickFraction", () => {
	test("is 1 after the first tick, before a tick duration is known", () => {
		const timing = observeTick(noTickTiming, 1 as Tick, 1000);
		expect(tickFraction(timing, 1500)).toBe(1);
	});

	test("is the share of the last tick duration elapsed since the latest tick", () => {
		const first = observeTick(noTickTiming, 1 as Tick, 1000);
		const timing = observeTick(first, 2 as Tick, 2000);
		expect(tickFraction(timing, 2250)).toBe(0.25);
	});

	test("stays at 1 while the next tick is late", () => {
		const first = observeTick(noTickTiming, 1 as Tick, 1000);
		const timing = observeTick(first, 2 as Tick, 2000);
		expect(tickFraction(timing, 3500)).toBe(1);
	});

	test("ignores the latest tick seen again", () => {
		const first = observeTick(noTickTiming, 1 as Tick, 1000);
		const second = observeTick(first, 2 as Tick, 2000);
		const timing = observeTick(second, 2 as Tick, 2100);
		expect(tickFraction(timing, 2250)).toBe(0.25);
	});
});
