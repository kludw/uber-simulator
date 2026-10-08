import { describe, expect, test } from "bun:test";
import { DriverIndex, driverIdAt } from "../shared/fleet.ts";
import {
	type Cell,
	type Coordinate,
	cellIn,
	type Grid,
} from "../shared/grid.ts";
import type { DriverId } from "../shared/messages.ts";
import { createRandom } from "../shared/random.ts";
import {
	oneRegion,
	Region,
	RegionLayout,
	regionBounds,
} from "../shared/regions.ts";
import {
	type IdleDriver,
	type IdleDrivers,
	idleCount,
	idleCountsByZone,
	idleDriversById,
	markBusy,
	markFree,
	nearestIdle,
	nearestIdleSkipping,
	placeDriver,
	placeDriverAt,
	removeDriver,
	startIdleDrivers,
} from "./idle-drivers.ts";

const grid: Grid = { width: 20, height: 20 };
// Two-digit IDs (ADR 0052): driver 2 is d-02, driver 10 is d-10.
const fleetSize = 12;
const none = new Set<DriverId>();

function cell(x: number, y: number): Cell {
	const result = cellIn(grid, x, y);
	if (!result.ok) throw new Error(`test cell (${x}, ${y}) outside grid`);
	return result.value;
}

function xy(x: number, y: number): [Coordinate, Coordinate] {
	const at = cell(x, y);
	return [at.x, at.y];
}

function i(index: number): DriverIndex {
	return DriverIndex.parse(index);
}

function id(index: number): DriverId {
	return driverIdAt(fleetSize, i(index));
}

function driver(index: number, x: number, y: number): IdleDriver {
	return { driverId: id(index), cell: cell(x, y) };
}

function at(index: number, x: number, y: number) {
	return { driverIndex: i(index), cell: cell(x, y) };
}

function placed(
	drivers: readonly ReturnType<typeof at>[],
	search?: Parameters<typeof startIdleDrivers>[3],
): IdleDrivers {
	const index = startIdleDrivers(grid, fleetSize, undefined, search);
	for (const { driverIndex, cell: placedAt } of drivers)
		placeDriverAt(index, driverIndex, placedAt.x, placedAt.y);
	return index;
}

describe("nearestIdle", () => {
	test("returns the idle driver nearest to the pickup", () => {
		const index = startIdleDrivers(grid, fleetSize);
		placeDriverAt(index, i(1), ...xy(15, 15));
		placeDriverAt(index, i(2), ...xy(6, 4));
		placeDriverAt(index, i(3), ...xy(0, 0));

		expect(nearestIdle(index, cell(5, 5), none)).toBe(id(2));
	});

	test("finds a driver by the cell it last moved to", () => {
		const index = startIdleDrivers(grid, fleetSize);
		placeDriverAt(index, i(1), ...xy(15, 15));
		placeDriverAt(index, i(2), ...xy(6, 4));
		placeDriverAt(index, i(2), ...xy(19, 19));

		expect(nearestIdle(index, cell(5, 5), none)).toBe(id(1));
	});

	test("never returns a busy driver", () => {
		const index = startIdleDrivers(grid, fleetSize);
		placeDriverAt(index, i(1), ...xy(15, 15));
		placeDriverAt(index, i(2), ...xy(6, 4));
		markBusy(index, id(2));

		expect(nearestIdle(index, cell(5, 5), none)).toBe(id(1));
	});

	test("finds a freed driver by the cell it moved to while busy", () => {
		const index = startIdleDrivers(grid, fleetSize);
		placeDriverAt(index, i(1), ...xy(8, 8));
		placeDriverAt(index, i(2), ...xy(15, 15));
		markBusy(index, id(2));
		placeDriverAt(index, i(2), ...xy(5, 6));
		markFree(index, id(2));

		expect(nearestIdle(index, cell(5, 5), none)).toBe(id(2));
	});

	test("never returns a driver excluded for the trip", () => {
		const index = placed([at(1, 15, 15), at(2, 6, 4)]);

		expect(nearestIdle(index, cell(5, 5), new Set([id(2)]))).toBe(id(1));
	});

	test("returns no driver when none is idle", () => {
		const index = placed([at(1, 15, 15)]);
		markBusy(index, id(1));

		expect(nearestIdle(index, cell(5, 5), none)).toBeUndefined();
	});

	// Within a fleet, index order is ID order (ADR 0052).
	test("ties go to the lowest driver ID", () => {
		const index = placed([at(10, 5, 7), at(2, 7, 5), at(3, 5, 3)]);

		expect(nearestIdle(index, cell(5, 5), none)).toBe(id(2));
	});

	test("never returns a removed driver", () => {
		const index = startIdleDrivers(grid, fleetSize);
		placeDriverAt(index, i(1), ...xy(15, 15));
		placeDriverAt(index, i(2), ...xy(6, 4));
		removeDriver(index, id(2));

		expect(nearestIdle(index, cell(5, 5), none)).toBe(id(1));
	});

	test("never returns a driver removed while busy once it is freed", () => {
		const index = startIdleDrivers(grid, fleetSize);
		placeDriverAt(index, i(1), ...xy(15, 15));
		placeDriverAt(index, i(2), ...xy(6, 4));
		markBusy(index, id(2));
		removeDriver(index, id(2));
		markFree(index, id(2));

		expect(nearestIdle(index, cell(5, 5), none)).toBe(id(1));
	});
});

// ADR 0050: an instance's index covers its region, the left half (x 0-9).
describe("a region's drivers", () => {
	const leftHalf = regionBounds(
		RegionLayout.parse("2x1"),
		grid,
		Region.parse(0),
	);

	test("a driver moving out of the region is no longer idle in it", () => {
		const index = startIdleDrivers(grid, fleetSize, leftHalf);
		placeDriverAt(index, i(1), ...xy(9, 5));
		placeDriverAt(index, i(1), ...xy(10, 5));

		expect(idleDriversById(index)).toEqual([]);
	});

	test("a busy driver moving out of the region is idle again when freed back inside", () => {
		const index = startIdleDrivers(grid, fleetSize, leftHalf);
		placeDriverAt(index, i(1), ...xy(9, 5));
		markBusy(index, id(1));
		placeDriverAt(index, i(1), ...xy(10, 5));
		placeDriverAt(index, i(1), ...xy(9, 6));
		markFree(index, id(1));

		expect(idleDriversById(index)).toEqual([driver(1, 9, 6)]);
	});

	test("a busy driver freed outside the region is not idle in it", () => {
		const index = startIdleDrivers(grid, fleetSize, leftHalf);
		placeDriverAt(index, i(1), ...xy(9, 5));
		markBusy(index, id(1));
		placeDriverAt(index, i(1), ...xy(10, 5));
		markFree(index, id(1));

		expect(idleDriversById(index)).toEqual([]);
	});

	test("a driver first seen outside the region is not idle in it", () => {
		const index = startIdleDrivers(grid, fleetSize, leftHalf);
		placeDriverAt(index, i(1), ...xy(10, 5));

		expect(idleDriversById(index)).toEqual([]);
	});
});

// Dispatch offers only idle drivers, and only a busy driver's offer or trip
// can end.
describe("busy marks", () => {
	test("marking a driver busy that isn't idle is a bug", () => {
		const index = placed([at(1, 3, 3)]);
		markBusy(index, id(1));

		expect(() => markBusy(index, id(1))).toThrow();
	});

	test("marking an unknown driver busy is a bug", () => {
		const index = placed([]);

		expect(() => markBusy(index, id(1))).toThrow();
	});

	test("freeing a driver that isn't busy is a bug", () => {
		const index = placed([at(1, 3, 3)]);

		expect(() => markFree(index, id(1))).toThrow();
	});
});

describe("idleCount", () => {
	test("counts online drivers that are not busy", () => {
		const index = placed([at(1, 1, 1), at(2, 2, 2), at(3, 3, 3)]);
		markBusy(index, id(1));
		removeDriver(index, id(2));

		expect(idleCount(index)).toBe(1);
	});
});

describe("idleCountsByZone", () => {
	// 2 x 2 surge zones of 50 x 50 cells (ADR 0054): zone 1 is top right.
	const zonedGrid: Grid = { width: 100, height: 100 };

	function zonedAt(x: number, y: number): [Coordinate, Coordinate] {
		return [x as Coordinate, y as Coordinate];
	}

	test("counts idle drivers by the zone of their cell", () => {
		const index = startIdleDrivers(zonedGrid, fleetSize);
		placeDriverAt(index, i(1), ...zonedAt(10, 10));
		placeDriverAt(index, i(2), ...zonedAt(60, 10));
		placeDriverAt(index, i(3), ...zonedAt(99, 49));
		placeDriverAt(index, i(4), ...zonedAt(10, 60));
		placeDriverAt(index, i(4), ...zonedAt(55, 60));

		expect(idleCountsByZone(index)).toEqual(
			new Map([
				[0, 1],
				[1, 2],
				[3, 1],
			]),
		);
	});

	test("never counts busy or offline drivers", () => {
		const index = startIdleDrivers(zonedGrid, fleetSize);
		placeDriverAt(index, i(1), ...zonedAt(10, 10));
		placeDriverAt(index, i(2), ...zonedAt(20, 10));
		placeDriverAt(index, i(3), ...zonedAt(30, 10));
		markBusy(index, id(2));
		removeDriver(index, id(3));

		expect(idleCountsByZone(index)).toEqual(new Map([[0, 1]]));
	});
});

describe("nearestIdleSkipping", () => {
	test("returns the nearest idle driver the predicate keeps, with its cell", () => {
		const index = placed([at(1, 15, 15), at(2, 6, 4), at(3, 4, 6)]);

		expect(
			nearestIdleSkipping(index, cell(5, 5), (driverId) => driverId === id(2)),
		).toEqual(driver(3, 4, 6));
	});

	test("searching rings, skips drivers the predicate rejects", () => {
		const index = placed([at(1, 5, 6), at(2, 9, 9), at(3, 5, 2)], searchGrid);

		expect(
			nearestIdleSkipping(index, cell(5, 5), (driverId) => driverId === id(1)),
		).toEqual(driver(3, 5, 2));
	});

	test("returns no driver when the predicate skips every idle driver", () => {
		const index = placed([at(1, 15, 15)]);

		expect(nearestIdleSkipping(index, cell(5, 5), () => true)).toBeUndefined();
	});
});

describe("idleDriversById", () => {
	test("lists idle drivers and their cells ordered by ID", () => {
		const index = placed([at(3, 1, 1), at(10, 2, 2), at(2, 3, 3), at(1, 4, 4)]);
		markBusy(index, id(1));
		placeDriverAt(index, i(3), ...xy(1, 2));

		expect(idleDriversById(index)).toEqual([
			driver(2, 3, 3),
			driver(3, 1, 2),
			driver(10, 2, 2),
		]);
	});
});

// Offer replies and arrivals name a driver by ID (ADR 0052); dispatch only
// takes them from the driver its offer or trip keeps busy.
describe("placing a driver by ID", () => {
	test("a busy driver placed by ID is idle at that cell once freed", () => {
		const index = placed([at(1, 8, 8), at(2, 15, 15)]);
		markBusy(index, id(2));
		placeDriver(index, id(2), ...xy(5, 6));
		markFree(index, id(2));

		expect(nearestIdle(index, cell(5, 5), none)).toBe(id(2));
	});

	test("placing a driver no message placed by index is a bug", () => {
		const index = placed([]);

		expect(() => placeDriver(index, id(1), ...xy(5, 6))).toThrow();
	});
});

// Cells as buckets (one cell each), so rings are easy to see: ring r holds the
// cells at Chebyshev distance r, Manhattan distance r..2r.
const searchGrid = { cellsPerBucket: 1, linearScanBelow: 0 };

describe("nearestIdle grid search", () => {
	test("a driver at distance 2r in ring r loses to one at r+1 in ring r+1", () => {
		const index = placed([at(1, 7, 7), at(2, 8, 5)], searchGrid);

		expect(nearestIdle(index, cell(5, 5), none)).toBe(id(2));
	});

	test("a tie in an outer ring with a lower ID wins", () => {
		const index = placed([at(1, 7, 5), at(2, 6, 6)], searchGrid);

		expect(nearestIdle(index, cell(5, 5), none)).toBe(id(1));
	});

	test("finds a driver in the farthest corner", () => {
		const index = placed([at(1, 19, 19)], searchGrid);

		expect(nearestIdle(index, cell(0, 0), none)).toBe(id(1));
	});

	test("takes no driver when all are excluded", () => {
		const index = placed([at(1, 3, 3)], searchGrid);

		expect(nearestIdle(index, cell(0, 0), new Set([id(1)]))).toBeUndefined();
	});

	test("returns exactly what a linear scan returns", () => {
		expectLinearScanPicks(147, { drivers: false, pickups: false });
	});

	// Cells come from other services' messages; grid bounds are an invariant
	// checked over the event log, not by dispatch.
	test("returns exactly what a linear scan returns with drivers off the grid", () => {
		expectLinearScanPicks(151, { drivers: true, pickups: false });
	});

	test("returns exactly what a linear scan returns with pickups and drivers off the grid", () => {
		expectLinearScanPicks(152, { drivers: true, pickups: true });
	});

	test("returns exactly what a linear scan of the region's drivers returns", () => {
		expectLinearScanPicks(153, { drivers: true, pickups: false }, true);
	});
});

type OffGrid = { drivers: boolean; pickups: boolean };

// Random sequences of placements (new drivers and moves), removals, busy and
// free drivers and searches, each search's driver then made busy as dispatch
// does, against a plain model of the same drivers searched linearly. With
// regions, the index covers one random region of a random layout: the model
// drops a driver placed outside it unless busy, and one freed outside it.
function expectLinearScanPicks(
	seed: number,
	offGrid: OffGrid,
	regions = false,
): void {
	const random = createRandom(seed);
	for (let run = 0; run < 1000; run++) {
		const scenarioGrid = {
			width: random.int(1, 25),
			height: random.int(1, 25),
		};
		const randomCell = (maybeOffGrid: boolean): Cell => {
			const past = maybeOffGrid && random.int(0, 3) === 0 ? 20 : 0;
			return {
				x: random.int(0, scenarioGrid.width - 1 + past),
				y: random.int(0, scenarioGrid.height - 1 + past),
			} as Cell;
		};
		const scenarioFleet = 100;
		const layout = regions
			? RegionLayout.parse(
					`${random.int(1, Math.min(3, scenarioGrid.width))}x${random.int(1, Math.min(3, scenarioGrid.height))}`,
				)
			: oneRegion;
		const region = regionBounds(
			layout,
			scenarioGrid,
			Region.parse(random.int(0, layout.columns * layout.rows - 1)),
		);
		// Off-grid cells belong to the region at that grid edge.
		const inRegion = (at: Cell) =>
			at.x >= region.min.x &&
			at.y >= region.min.y &&
			(at.x <= region.max.x || region.max.x === scenarioGrid.width - 1) &&
			(at.y <= region.max.y || region.max.y === scenarioGrid.height - 1);
		const index = startIdleDrivers(scenarioGrid, scenarioFleet, region, {
			cellsPerBucket: random.int(1, 6),
			linearScanBelow: random.int(0, 1) === 0 ? 0 : random.int(0, 20),
		});
		const model = {
			cells: new Map<DriverId, Cell>(),
			busy: new Set<DriverId>(),
		};
		const found: (DriverId | undefined)[] = [];
		const expected: (DriverId | undefined)[] = [];
		for (let step = 0; step < 200; step++) {
			const action = random.int(0, 9);
			const driverIndex = DriverIndex.parse(random.int(0, scenarioFleet - 1));
			const driverId = driverIdAt(scenarioFleet, driverIndex);
			if (action <= 4) {
				const at = randomCell(offGrid.drivers);
				placeDriverAt(index, driverIndex, at.x, at.y);
				if (inRegion(at) || model.busy.has(driverId)) {
					model.cells.set(driverId, at);
				} else {
					model.cells.delete(driverId);
				}
			} else if (action === 5) {
				removeDriver(index, driverId);
				model.cells.delete(driverId);
			} else if (
				action === 6 &&
				model.cells.has(driverId) &&
				!model.busy.has(driverId)
			) {
				markBusy(index, driverId);
				model.busy.add(driverId);
			} else if (action === 7 && model.busy.has(driverId)) {
				markFree(index, driverId);
				model.busy.delete(driverId);
				const at = model.cells.get(driverId);
				if (at !== undefined && !inRegion(at)) model.cells.delete(driverId);
			} else if (action >= 8) {
				const pickup = randomCell(offGrid.pickups);
				const excluded = new Set(
					[...model.cells.keys()].filter(() => random.int(0, 9) === 0),
				);
				const nearest = nearestIdle(index, pickup, excluded);
				found.push(nearest);
				expected.push(linearScan(model, pickup, excluded));
				if (nearest !== undefined && !model.busy.has(nearest)) {
					markBusy(index, nearest);
					model.busy.add(nearest);
				}
			}
		}

		expect({ run, found }).toEqual({ run, found: expected });
	}
}

// Reference: sort every idle, not excluded driver by (distance, ID).
function linearScan(
	model: { cells: ReadonlyMap<DriverId, Cell>; busy: ReadonlySet<DriverId> },
	pickup: Cell,
	excluded: ReadonlySet<DriverId>,
): DriverId | undefined {
	const [nearest] = [...model.cells]
		.filter(
			([driverId]) => !model.busy.has(driverId) && !excluded.has(driverId),
		)
		.map(([driverId, at]) => ({
			driverId,
			distance: Math.abs(at.x - pickup.x) + Math.abs(at.y - pickup.y),
		}))
		.toSorted(
			(a, b) =>
				a.distance - b.distance ||
				(a.driverId < b.driverId ? -1 : a.driverId > b.driverId ? 1 : 0),
		);
	return nearest?.driverId;
}
