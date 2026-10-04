import { describe, expect, test } from "bun:test";
import { type Cell, cellIn, type Grid } from "../shared/grid.ts";
import { DriverId } from "../shared/messages.ts";
import { createRandom, type Random } from "../shared/random.ts";
import {
	type IdleDriver,
	indexIdleDrivers,
	takeNearest,
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

describe("takeNearest", () => {
	test("takes the idle driver nearest to the pickup", () => {
		const index = indexIdleDrivers(grid, [
			driver("d-1", 15, 15),
			driver("d-2", 6, 4),
			driver("d-3", 0, 0),
		]);

		expect(takeNearest(index, cell(5, 5), none)).toBe(DriverId.parse("d-2"));
	});

	test("never takes a driver twice", () => {
		const index = indexIdleDrivers(grid, [
			driver("d-1", 15, 15),
			driver("d-2", 6, 4),
		]);
		takeNearest(index, cell(5, 5), none);

		expect(takeNearest(index, cell(5, 5), none)).toBe(DriverId.parse("d-1"));
	});

	test("never takes a driver excluded for the trip", () => {
		const index = indexIdleDrivers(grid, [
			driver("d-1", 15, 15),
			driver("d-2", 6, 4),
		]);

		expect(
			takeNearest(index, cell(5, 5), new Set([DriverId.parse("d-2")])),
		).toBe(DriverId.parse("d-1"));
	});

	test("takes no driver once none is left", () => {
		const index = indexIdleDrivers(grid, [driver("d-1", 15, 15)]);
		takeNearest(index, cell(5, 5), none);

		expect(takeNearest(index, cell(5, 5), none)).toBeUndefined();
	});

	test("ties go to the lowest driver ID in plain string order", () => {
		const index = indexIdleDrivers(grid, [
			driver("d-10", 5, 7),
			driver("d-2", 7, 5),
			driver("d-3", 5, 3),
		]);

		expect(takeNearest(index, cell(5, 5), none)).toBe(DriverId.parse("d-10"));
	});
});

// Cells as buckets (one cell each), so rings are easy to see: ring r holds the
// cells at Chebyshev distance r, Manhattan distance r..2r.
const searchGrid = { cellsPerBucket: 1, linearScanBelow: 0 };

describe("takeNearest grid search", () => {
	test("a driver at distance 2r in ring r loses to one at r+1 in ring r+1", () => {
		const index = indexIdleDrivers(
			grid,
			[driver("d-1", 7, 7), driver("d-2", 8, 5)],
			searchGrid,
		);

		expect(takeNearest(index, cell(5, 5), none)).toBe(DriverId.parse("d-2"));
	});

	test("a tie in an outer ring with a lower ID wins", () => {
		const index = indexIdleDrivers(
			grid,
			[driver("d-1", 7, 5), driver("d-2", 6, 6)],
			searchGrid,
		);

		expect(takeNearest(index, cell(5, 5), none)).toBe(DriverId.parse("d-1"));
	});

	test("finds a driver in the farthest corner", () => {
		const index = indexIdleDrivers(grid, [driver("d-1", 19, 19)], searchGrid);

		expect(takeNearest(index, cell(0, 0), none)).toBe(DriverId.parse("d-1"));
	});

	test("takes no driver when all are excluded", () => {
		const index = indexIdleDrivers(grid, [driver("d-1", 3, 3)], searchGrid);

		expect(
			takeNearest(index, cell(0, 0), new Set([DriverId.parse("d-1")])),
		).toBeUndefined();
	});

	test("takes exactly what a linear scan takes", () => {
		expectLinearScanPicks(147, { drivers: false, pickups: false });
	});

	// Cells come from other services' messages; grid bounds are an invariant
	// checked over the event log, not by dispatch.
	test("takes exactly what a linear scan takes with drivers off the grid", () => {
		expectLinearScanPicks(151, { drivers: true, pickups: false });
	});

	test("takes exactly what a linear scan takes with pickups and drivers off the grid", () => {
		expectLinearScanPicks(152, { drivers: true, pickups: true });
	});
});

type OffGrid = { drivers: boolean; pickups: boolean };

function expectLinearScanPicks(seed: number, offGrid: OffGrid): void {
	const random = createRandom(seed);
	for (let run = 0; run < 3000; run++) {
		const { scenario, expected } = randomScenario(random, offGrid);
		const index = indexIdleDrivers(scenario.grid, scenario.drivers, {
			cellsPerBucket: random.int(1, 6),
			linearScanBelow: random.int(0, 1) === 0 ? 0 : random.int(0, 20),
		});

		const taken = scenario.trips.map((trip) =>
			takeNearest(index, trip.pickup, trip.excluded),
		);

		expect({ run, taken }).toEqual({ run, taken: expected });
	}
}

type Scenario = {
	grid: Grid;
	drivers: IdleDriver[];
	trips: { pickup: Cell; excluded: ReadonlySet<DriverId> }[];
};

// Small grids and few cells per driver so ties and shared cells are common;
// IDs with mixed digit counts so string order differs from numeric order.
// Off the grid: about a quarter of drivers (pickups) up to 20 cells past its
// far edges.
function randomScenario(
	random: Random,
	offGrid: OffGrid,
): {
	scenario: Scenario;
	expected: (DriverId | undefined)[];
} {
	const scenarioGrid = { width: random.int(1, 25), height: random.int(1, 25) };
	const randomCell = (maybeOffGrid: boolean): Cell => {
		const past = maybeOffGrid && random.int(0, 3) === 0 ? 20 : 0;
		return {
			x: random.int(0, scenarioGrid.width - 1 + past),
			y: random.int(0, scenarioGrid.height - 1 + past),
		} as Cell;
	};
	const ids = new Set<DriverId>();
	const driverCount = random.int(0, 60);
	while (ids.size < driverCount) {
		ids.add(DriverId.parse(`d-${random.int(0, 999)}`));
	}
	const drivers = [...ids].toSorted().map((driverId) => ({
		driverId,
		cell: randomCell(offGrid.drivers),
	}));
	const trips = Array.from({ length: random.int(1, 30) }, () => ({
		pickup: randomCell(offGrid.pickups),
		excluded: new Set(
			drivers
				.filter(() => random.int(0, 9) === 0)
				.map(({ driverId }) => driverId),
		),
	}));
	return {
		scenario: { grid: scenarioGrid, drivers, trips },
		expected: linearScan(drivers, trips),
	};
}

// Reference: sort every remaining eligible driver by (distance, ID).
function linearScan(
	drivers: readonly IdleDriver[],
	trips: Scenario["trips"],
): (DriverId | undefined)[] {
	const taken = new Set<DriverId>();
	return trips.map(({ pickup, excluded }) => {
		const [nearest] = drivers
			.filter(({ driverId }) => !taken.has(driverId) && !excluded.has(driverId))
			.map(({ driverId, cell: at }) => ({
				driverId,
				distance: Math.abs(at.x - pickup.x) + Math.abs(at.y - pickup.y),
			}))
			.toSorted(
				(a, b) =>
					a.distance - b.distance ||
					(a.driverId < b.driverId ? -1 : a.driverId > b.driverId ? 1 : 0),
			);
		if (nearest !== undefined) taken.add(nearest.driverId);
		return nearest?.driverId;
	});
}
