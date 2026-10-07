// #240 experiment, not merged: the lazy solver against the dense one.
import { expect, test } from "bun:test";
import { type Coordinate, cellAt, distance } from "../shared/grid.ts";
import type { DriverId } from "../shared/messages.ts";
import { createRandom } from "../shared/random.ts";
import { placeDriver, startIdleDrivers } from "./idle-drivers.ts";
import { type LazyRow, lazyMinCostMatching } from "./lazy-matching.ts";
import { minCostMatching } from "./matching.ts";

test("lazy matches dense: same pair count and total distance", () => {
	const random = createRandom(7);
	const int = (n: number) => random.int(0, n - 1);
	for (let instance = 0; instance < 3000; instance++) {
		const size = 1 + int(instance < 1500 ? 12 : 120);
		const grid = { width: size, height: size };
		const driverCount = 1 + int(instance < 1500 ? 15 : 200);
		const tripCount = 1 + int(driverCount);
		const drivers = startIdleDrivers(grid);
		const ids: DriverId[] = [];
		const cells: ReturnType<typeof cellAt>[] = [];
		for (let index = 0; index < driverCount; index++) {
			const id = `d-${index}` as DriverId;
			const cell = cellAt(int(size) as Coordinate, int(size) as Coordinate);
			ids.push(id);
			cells.push(cell);
			placeDriver(drivers, id, cell.x, cell.y);
		}
		const rows: LazyRow[] = [];
		for (let index = 0; index < tripCount; index++) {
			const excluded = new Set<DriverId>();
			const exclusions = random.int(0, 9) < 3 ? int(driverCount + 1) : 0;
			for (let e = 0; e < exclusions; e++)
				excluded.add(ids[int(driverCount)] as DriverId);
			rows.push({
				pickup: cellAt(int(size) as Coordinate, int(size) as Coordinate),
				excludedDrivers: excluded,
			});
		}
		const cost = (row: number, column: number) => {
			const trip = rows[row] as LazyRow;
			return trip.excludedDrivers.has(ids[column] as DriverId)
				? Number.POSITIVE_INFINITY
				: distance(trip.pickup, cells[column] as never);
		};
		const dense = minCostMatching(tripCount, driverCount, {
			ofRow: (row, out) => {
				for (let c = 0; c < driverCount; c++) out[c] = cost(row, c);
			},
			ofColumn: (column, out) => {
				for (let r = 0; r < tripCount; r++) out[r] = cost(r, column);
			},
		});
		const lazy = lazyMinCostMatching(rows, drivers, 2 * size);
		const denseTotal = dense.reduce((sum, p) => sum + cost(p.row, p.column), 0);
		const lazyTotal = lazy.reduce(
			(sum, p) => sum + cost(p.row, ids.indexOf(p.driverId)),
			0,
		);
		expect({ instance, n: lazy.length, total: lazyTotal }).toEqual({
			instance,
			n: dense.length,
			total: denseTotal,
		});
		expect(new Set(lazy.map((p) => p.driverId)).size).toBe(lazy.length);
		for (const p of lazy)
			expect(cost(p.row, ids.indexOf(p.driverId))).toBeLessThan(Infinity);
	}
});
