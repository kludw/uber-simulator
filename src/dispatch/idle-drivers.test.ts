import { describe, expect, test } from "bun:test";
import { type Cell, cellIn, type Grid } from "../shared/grid.ts";
import { DriverId } from "../shared/messages.ts";
import { createRandom } from "../shared/random.ts";
import {
	type IdleDriver,
	type IdleDrivers,
	idleDriversById,
	markBusy,
	markFree,
	nearestIdle,
	placeDriver,
	removeDriver,
	startIdleDrivers,
} from "./idle-drivers.ts";

const grid: Grid = { width: 20, height: 20 };
const none = new Set<DriverId>();

function cell(x: number, y: number): Cell {
	const result = cellIn(grid, x, y);
	if (!result.ok) throw new Error(`test cell (${x}, ${y}) outside grid`);
	return result.value;
}

function driver(id: string, x: number, y: number) {
	return { driverId: DriverId.parse(id), cell: cell(x, y) };
}

function placed(
	drivers: readonly IdleDriver[],
	search?: Parameters<typeof startIdleDrivers>[1],
): IdleDrivers {
	const index = startIdleDrivers(grid, search);
	for (const { driverId, cell: at } of drivers)
		placeDriver(index, driverId, at);
	return index;
}

describe("nearestIdle", () => {
	test("returns the idle driver nearest to the pickup", () => {
		const index = startIdleDrivers(grid);
		placeDriver(index, DriverId.parse("d-1"), cell(15, 15));
		placeDriver(index, DriverId.parse("d-2"), cell(6, 4));
		placeDriver(index, DriverId.parse("d-3"), cell(0, 0));

		expect(nearestIdle(index, cell(5, 5), none)).toBe(DriverId.parse("d-2"));
	});

	test("finds a driver by the cell it last moved to", () => {
		const index = startIdleDrivers(grid);
		placeDriver(index, DriverId.parse("d-1"), cell(15, 15));
		placeDriver(index, DriverId.parse("d-2"), cell(6, 4));
		placeDriver(index, DriverId.parse("d-2"), cell(19, 19));

		expect(nearestIdle(index, cell(5, 5), none)).toBe(DriverId.parse("d-1"));
	});

	test("never returns a busy driver", () => {
		const index = startIdleDrivers(grid);
		placeDriver(index, DriverId.parse("d-1"), cell(15, 15));
		placeDriver(index, DriverId.parse("d-2"), cell(6, 4));
		markBusy(index, DriverId.parse("d-2"));

		expect(nearestIdle(index, cell(5, 5), none)).toBe(DriverId.parse("d-1"));
	});

	test("finds a freed driver by the cell it moved to while busy", () => {
		const index = startIdleDrivers(grid);
		placeDriver(index, DriverId.parse("d-1"), cell(8, 8));
		placeDriver(index, DriverId.parse("d-2"), cell(15, 15));
		markBusy(index, DriverId.parse("d-2"));
		placeDriver(index, DriverId.parse("d-2"), cell(5, 6));
		markFree(index, DriverId.parse("d-2"));

		expect(nearestIdle(index, cell(5, 5), none)).toBe(DriverId.parse("d-2"));
	});

	test("never returns a driver excluded for the trip", () => {
		const index = placed([driver("d-1", 15, 15), driver("d-2", 6, 4)]);

		expect(
			nearestIdle(index, cell(5, 5), new Set([DriverId.parse("d-2")])),
		).toBe(DriverId.parse("d-1"));
	});

	test("returns no driver when none is idle", () => {
		const index = placed([driver("d-1", 15, 15)]);
		markBusy(index, DriverId.parse("d-1"));

		expect(nearestIdle(index, cell(5, 5), none)).toBeUndefined();
	});

	test("ties go to the lowest driver ID in plain string order", () => {
		const index = placed([
			driver("d-10", 5, 7),
			driver("d-2", 7, 5),
			driver("d-3", 5, 3),
		]);

		expect(nearestIdle(index, cell(5, 5), none)).toBe(DriverId.parse("d-10"));
	});

	test("never returns a removed driver", () => {
		const index = startIdleDrivers(grid);
		placeDriver(index, DriverId.parse("d-1"), cell(15, 15));
		placeDriver(index, DriverId.parse("d-2"), cell(6, 4));
		removeDriver(index, DriverId.parse("d-2"));

		expect(nearestIdle(index, cell(5, 5), none)).toBe(DriverId.parse("d-1"));
	});

	test("never returns a driver removed while busy once it is freed", () => {
		const index = startIdleDrivers(grid);
		placeDriver(index, DriverId.parse("d-1"), cell(15, 15));
		placeDriver(index, DriverId.parse("d-2"), cell(6, 4));
		markBusy(index, DriverId.parse("d-2"));
		removeDriver(index, DriverId.parse("d-2"));
		markFree(index, DriverId.parse("d-2"));

		expect(nearestIdle(index, cell(5, 5), none)).toBe(DriverId.parse("d-1"));
	});
});

describe("idleDriversById", () => {
	test("lists idle drivers and their cells ordered by ID", () => {
		const index = placed([
			driver("d-3", 1, 1),
			driver("d-10", 2, 2),
			driver("d-2", 3, 3),
			driver("d-1", 4, 4),
		]);
		markBusy(index, DriverId.parse("d-1"));
		placeDriver(index, DriverId.parse("d-3"), cell(1, 2));

		expect(idleDriversById(index)).toEqual([
			driver("d-10", 2, 2),
			driver("d-2", 3, 3),
			driver("d-3", 1, 2),
		]);
	});
});

// Cells as buckets (one cell each), so rings are easy to see: ring r holds the
// cells at Chebyshev distance r, Manhattan distance r..2r.
const searchGrid = { cellsPerBucket: 1, linearScanBelow: 0 };

describe("nearestIdle grid search", () => {
	test("a driver at distance 2r in ring r loses to one at r+1 in ring r+1", () => {
		const index = placed(
			[driver("d-1", 7, 7), driver("d-2", 8, 5)],
			searchGrid,
		);

		expect(nearestIdle(index, cell(5, 5), none)).toBe(DriverId.parse("d-2"));
	});

	test("a tie in an outer ring with a lower ID wins", () => {
		const index = placed(
			[driver("d-1", 7, 5), driver("d-2", 6, 6)],
			searchGrid,
		);

		expect(nearestIdle(index, cell(5, 5), none)).toBe(DriverId.parse("d-1"));
	});

	test("finds a driver in the farthest corner", () => {
		const index = placed([driver("d-1", 19, 19)], searchGrid);

		expect(nearestIdle(index, cell(0, 0), none)).toBe(DriverId.parse("d-1"));
	});

	test("takes no driver when all are excluded", () => {
		const index = placed([driver("d-1", 3, 3)], searchGrid);

		expect(
			nearestIdle(index, cell(0, 0), new Set([DriverId.parse("d-1")])),
		).toBeUndefined();
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
});

type OffGrid = { drivers: boolean; pickups: boolean };

// Random sequences of placements (new drivers and moves), removals, busy and
// free drivers and searches, each search's driver then made busy as dispatch
// does, against a plain model of the same drivers searched linearly.
function expectLinearScanPicks(seed: number, offGrid: OffGrid): void {
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
		// IDs with mixed digit counts so string order differs from numeric order.
		const randomDriver = () => DriverId.parse(`d-${random.int(0, 99)}`);
		const index = startIdleDrivers(scenarioGrid, {
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
			const driverId = randomDriver();
			if (action <= 4) {
				const at = randomCell(offGrid.drivers);
				placeDriver(index, driverId, at);
				model.cells.set(driverId, at);
			} else if (action === 5) {
				removeDriver(index, driverId);
				model.cells.delete(driverId);
			} else if (action === 6 && !model.busy.has(driverId)) {
				markBusy(index, driverId);
				model.busy.add(driverId);
			} else if (action === 7 && model.busy.has(driverId)) {
				markFree(index, driverId);
				model.busy.delete(driverId);
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
