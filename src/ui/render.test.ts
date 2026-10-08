import { describe, expect, test } from "bun:test";
import { DriverIndex, driverIdAt } from "../shared/fleet.ts";
import type { Cell } from "../shared/grid.ts";
import {
	driversWentOnline,
	RiderId,
	type Tick,
	TripId,
} from "../shared/messages.ts";
import { Region } from "../shared/regions.ts";
import {
	cellToPixel,
	drawModeOf,
	driverPosition,
	heatmapOf,
	noTickTiming,
	observeTick,
	tickFraction,
} from "./render.ts";
import { applyEvent, type DriverView, emptyView, type View } from "./view.ts";

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

	test("is 1 when the last two ticks arrived in the same millisecond", () => {
		const first = observeTick(noTickTiming, 1 as Tick, 2000);
		const timing = observeTick(first, 2 as Tick, 2000);
		expect(tickFraction(timing, 2000)).toBe(1);
	});

	test("ignores the latest tick seen again", () => {
		const first = observeTick(noTickTiming, 1 as Tick, 1000);
		const second = observeTick(first, 2 as Tick, 2000);
		const timing = observeTick(second, 2 as Tick, 2100);
		expect(tickFraction(timing, 2250)).toBe(0.25);
	});
});

// Drivers 0, 1, ... of a fleet of fleetSize online (idle) at cells, in order.
function viewOfFleet(fleetSize: number, cells: Cell[] = [cell(0, 0)]): View {
	const view = emptyView();
	applyEvent(
		view,
		driversWentOnline(
			1 as Tick,
			Region.parse(0),
			fleetSize,
			cells.map((at, index) => ({
				driverIndex: DriverIndex.parse(index),
				cell: at,
			})),
		),
	);
	return view;
}

describe("drawModeOf", () => {
	test("draws dots before any fleet size is seen", () => {
		expect(drawModeOf(emptyView())).toBe("dots");
	});

	test("draws dots for a fleet of 10,000 drivers", () => {
		expect(drawModeOf(viewOfFleet(10_000))).toBe("dots");
	});

	test("draws the heatmap for a fleet of 10,001 drivers", () => {
		expect(drawModeOf(viewOfFleet(10_001))).toBe("heatmap");
	});
});

describe("heatmapOf", () => {
	// Two tiles of 5 × 5 cells side by side.
	const twoTiles = { width: 10, height: 5 };

	test("an empty city is one city-colored pixel per tile", () => {
		expect(heatmapOf(emptyView(), twoTiles)).toEqual({
			columns: 2,
			rows: 1,
			rgba: new Uint8ClampedArray([22, 27, 34, 255, 22, 27, 34, 255]),
		});
	});

	// Mean 1.5 drivers per tile: full brightness at 3 (twice the mean).
	test("brightens a tile from city color to idle grey by its drivers against twice the mean", () => {
		const view = viewOfFleet(3, [cell(0, 0), cell(4, 4), cell(5, 0)]);
		expect(heatmapOf(view, twoTiles).rgba).toEqual(
			new Uint8ClampedArray([100, 108, 117, 255, 61, 67, 75, 255]),
		);
	});

	test("colors a tile of busy drivers busy green, whatever their trip stage", () => {
		const view = viewOfFleet(2, [cell(0, 0), cell(1, 1)]);
		for (const index of [0, 1]) {
			applyEvent(view, {
				type: "trip.matched",
				tick: 2 as Tick,
				tripId: TripId.parse(`t-${index}`),
				driverId: driverIdAt(2, DriverIndex.parse(index)),
			});
		}
		expect(heatmapOf(view, twoTiles).rgba).toEqual(
			new Uint8ClampedArray([63, 185, 80, 255, 22, 27, 34, 255]),
		);
	});

	// Mean 1 driver per tile: 3 drivers is past full brightness (2), capped.
	test("mixes idle grey and busy green by a tile's busy share, at most full brightness", () => {
		const view = viewOfFleet(3, [cell(0, 0), cell(1, 1), cell(2, 2)]);
		applyEvent(view, {
			type: "trip.matched",
			tick: 2 as Tick,
			tripId: TripId.parse("t-0"),
			driverId: driverIdAt(3, DriverIndex.parse(0)),
		});
		expect(heatmapOf(view, { width: 15, height: 5 }).rgba).toEqual(
			new Uint8ClampedArray([
				114, 160, 132, 255, 22, 27, 34, 255, 22, 27, 34, 255,
			]),
		);
	});

	// Red in full from 3 waiting riders up.
	test("turns a tile red by the riders waiting for pickup in it", () => {
		const view = emptyView();
		const pickups = [cell(0, 0), cell(5, 0), cell(9, 4), cell(6, 2)];
		for (const [index, pickup] of pickups.entries()) {
			applyEvent(view, {
				type: "trip.requested",
				tick: 1 as Tick,
				tripId: TripId.parse(`t-${index}`),
				riderId: RiderId.parse(`r-${index}`),
				pickup,
				dropoff: cell(0, 0),
			});
		}
		expect(heatmapOf(view, twoTiles).rgba).toEqual(
			new Uint8ClampedArray([100, 59, 61, 255, 255, 123, 114, 255]),
		);
	});
});
