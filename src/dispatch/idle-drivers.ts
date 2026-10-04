import { type Cell, distance, type Grid } from "../shared/grid.ts";
import type { DriverId } from "../shared/messages.ts";

export type IdleDriver = { driverId: DriverId; cell: Cell };

// Square buckets of cellsPerBucket x cellsPerBucket cells. Below
// linearScanBelow drivers left, a linear scan beats searching mostly empty
// buckets (ADR 0036). Defaults measured at 50k drivers (docs/performance.md).
type IdleDriverSearch = {
	cellsPerBucket: number;
	linearScanBelow: number;
};

const defaultSearch: IdleDriverSearch = {
	cellsPerBucket: 16,
	linearScanBelow: 64,
};

// One tick's idle drivers, owned by the caller for that tick: takeNearest
// removes the driver it returns. Opaque: callers can't name `internals`.
const internals: unique symbol = Symbol("idle driver index");
export type IdleDriverIndex = { readonly [internals]: Index };

type Index = {
	grid: Grid;
	search: IdleDriverSearch;
	drivers: readonly IdleDriver[];
	taken: Set<DriverId>;
	columns: number;
	rows: number;
	// Row-major by bucket; each bucket's drivers not yet taken.
	buckets: IdleDriver[][];
};

export function indexIdleDrivers(
	grid: Grid,
	drivers: readonly IdleDriver[],
	search: IdleDriverSearch = defaultSearch,
): IdleDriverIndex {
	const size = search.cellsPerBucket;
	const columns = Math.ceil(grid.width / size);
	const rows = Math.ceil(grid.height / size);
	const buckets = Array.from(
		{ length: columns * rows },
		(): IdleDriver[] => [],
	);
	const index: Index = {
		grid,
		search,
		drivers,
		taken: new Set<DriverId>(),
		columns,
		rows,
		buckets,
	};
	for (const driver of drivers) bucketOf(index, driver.cell).push(driver);
	return { [internals]: index };
}

// A cell off the grid (bad input from another service; grid bounds are an
// event log invariant) goes to the nearest edge bucket. The search stays
// exact: from an in-grid pickup, the true cell is at least as far as the
// clamped one, so the ring bound still holds.
function bucketOf(index: Index, cell: Cell): IdleDriver[] {
	const size = index.search.cellsPerBucket;
	const column = Math.min(Math.floor(cell.x / size), index.columns - 1);
	const row = Math.min(Math.floor(cell.y / size), index.rows - 1);
	const bucket = index.buckets[row * index.columns + column];
	if (bucket === undefined) throw new Error(`no bucket (${column}, ${row})`);
	return bucket;
}

// The driver nearest to the pickup, ties to the lowest ID (plain string
// order), never one taken or excluded; exactly what a linear scan returns.
export function takeNearest(
	idle: IdleDriverIndex,
	pickup: Cell,
	excluded: ReadonlySet<DriverId>,
): DriverId | undefined {
	const index = idle[internals];
	const remaining = index.drivers.length - index.taken.size;
	// The ring bound holds for in-grid pickups only (see bucketOf); a pickup
	// off the grid is bad input, so take the scan, exact by construction.
	const pickupOffGrid =
		pickup.x >= index.grid.width || pickup.y >= index.grid.height;
	const nearest =
		pickupOffGrid || remaining < index.search.linearScanBelow
			? scanAll(index, pickup, excluded)
			: searchRings(index, pickup, excluded);
	if (nearest === undefined) return undefined;
	index.taken.add(nearest.driverId);
	const bucket = bucketOf(index, nearest.cell);
	const position = bucket.indexOf(nearest);
	if (position === -1) {
		throw new Error(`${nearest.driverId} not in its bucket`);
	}
	bucket.splice(position, 1);
	return nearest.driverId;
}

type Nearest = { driver: IdleDriver; distance: number } | undefined;

function closer(nearest: Nearest, driver: IdleDriver, pickup: Cell): Nearest {
	const toPickup = distance(driver.cell, pickup);
	if (nearest === undefined || toPickup < nearest.distance) {
		return { driver, distance: toPickup };
	}
	if (
		toPickup === nearest.distance &&
		driver.driverId < nearest.driver.driverId
	) {
		return { driver, distance: toPickup };
	}
	return nearest;
}

function scanAll(
	index: Index,
	pickup: Cell,
	excluded: ReadonlySet<DriverId>,
): IdleDriver | undefined {
	let nearest: Nearest;
	for (const driver of index.drivers) {
		if (index.taken.has(driver.driverId) || excluded.has(driver.driverId)) {
			continue;
		}
		nearest = closer(nearest, driver, pickup);
	}
	return nearest?.driver;
}

// Square rings of buckets around the pickup's bucket. Ring r can hold cells
// at up to twice the distance of ring r+1's nearest, so keep expanding until
// nothing in ring r or beyond can be as near as the best found.
function searchRings(
	index: Index,
	pickup: Cell,
	excluded: ReadonlySet<DriverId>,
): IdleDriver | undefined {
	const size = index.search.cellsPerBucket;
	const column = Math.floor(pickup.x / size);
	const row = Math.floor(pickup.y / size);
	const lastRing = Math.max(
		column,
		row,
		index.columns - 1 - column,
		index.rows - 1 - row,
	);
	let nearest: Nearest;
	for (let ring = 0; ring <= lastRing; ring++) {
		if (
			nearest !== undefined &&
			nearestBeyond(pickup, size, ring) > nearest.distance
		) {
			break;
		}
		for (let y = row - ring; y <= row + ring; y++) {
			if (y < 0 || y >= index.rows) continue;
			const edgeRow = y === row - ring || y === row + ring;
			const step = edgeRow ? 1 : 2 * ring;
			for (let x = column - ring; x <= column + ring; x += step) {
				if (x < 0 || x >= index.columns) continue;
				for (const driver of index.buckets[y * index.columns + x] ?? []) {
					if (excluded.has(driver.driverId)) continue;
					nearest = closer(nearest, driver, pickup);
				}
			}
		}
	}
	return nearest?.driver;
}

// Least distance from the pickup to any cell in ring `ring` or beyond, i.e.
// outside the square of buckets of rings 0..ring-1.
function nearestBeyond(pickup: Cell, size: number, ring: number): number {
	if (ring === 0) return 0;
	const column = Math.floor(pickup.x / size);
	const row = Math.floor(pickup.y / size);
	return Math.min(
		pickup.x - (column - ring + 1) * size + 1,
		(column + ring) * size - pickup.x,
		pickup.y - (row - ring + 1) * size + 1,
		(row + ring) * size - pickup.y,
	);
}
