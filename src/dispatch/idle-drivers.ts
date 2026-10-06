import { type Cell, distance, type Grid } from "../shared/grid.ts";
import type { DriverId } from "../shared/messages.ts";

export type IdleDriver = { driverId: DriverId; cell: Cell };

// Square buckets of cellsPerBucket x cellsPerBucket cells. Below
// linearScanBelow idle drivers, a linear scan beats searching mostly empty
// buckets (ADR 0036). Defaults measured at 50k drivers (docs/performance.md).
type IdleDriverSearch = {
	cellsPerBucket: number;
	linearScanBelow: number;
};

const defaultSearch: IdleDriverSearch = {
	cellsPerBucket: 16,
	linearScanBelow: 64,
};

// Dispatch's drivers across ticks (ADR 0048): known drivers' cells, busy
// drivers, and the idle ones (known, not busy) bucketed for the nearest
// search, updated in place as drivers report and trips change (ADR 0033).
// Opaque: callers can't name `internals`.
const internals: unique symbol = Symbol("idle drivers");
export type IdleDrivers = { readonly [internals]: Drivers };

// An idle driver's bucket and slot in it, so leaving a bucket is a swap with
// its last entry, not a search.
type Entry = { driverId: DriverId; cell: Cell; bucket: number; slot: number };

type Drivers = {
	grid: Grid;
	search: IdleDriverSearch;
	columns: number;
	rows: number;
	// Cells as last reported, busy drivers included.
	cells: Map<DriverId, Cell>;
	busy: Set<DriverId>;
	idle: Map<DriverId, Entry>;
	// Row-major by bucket, unordered within a bucket.
	buckets: Entry[][];
};

export function startIdleDrivers(
	grid: Grid,
	search: IdleDriverSearch = defaultSearch,
): IdleDrivers {
	const size = search.cellsPerBucket;
	const columns = Math.ceil(grid.width / size);
	const rows = Math.ceil(grid.height / size);
	return {
		[internals]: {
			grid,
			search,
			columns,
			rows,
			cells: new Map(),
			busy: new Set(),
			idle: new Map(),
			buckets: Array.from({ length: columns * rows }, (): Entry[] => []),
		},
	};
}

// A driver went online or moved; a driver first seen moving is known from
// then on.
export function placeDriver(
	idle: IdleDrivers,
	driverId: DriverId,
	cell: Cell,
): void {
	const drivers = idle[internals];
	drivers.cells.set(driverId, cell);
	const entry = drivers.idle.get(driverId);
	if (entry === undefined) {
		if (!drivers.busy.has(driverId)) addIdle(drivers, driverId, cell);
		return;
	}
	entry.cell = cell;
	if (bucketOf(drivers, cell) === entry.bucket) return;
	removeFromBucket(drivers, entry);
	addToBucket(drivers, entry);
}

// A driver went offline. A busy driver stays busy until freed.
export function removeDriver(idle: IdleDrivers, driverId: DriverId): void {
	const drivers = idle[internals];
	drivers.cells.delete(driverId);
	removeIdle(drivers, driverId);
}

// A driver was offered a trip or has one. Busy for one trip at a time:
// dispatch offers only idle drivers, so a second mark is a bug.
export function markBusy(idle: IdleDrivers, driverId: DriverId): void {
	const drivers = idle[internals];
	if (drivers.busy.has(driverId)) throw new Error(`${driverId} already busy`);
	drivers.busy.add(driverId);
	removeIdle(drivers, driverId);
}

// A driver's offer or trip is over; idle again if its cell is known.
export function markFree(idle: IdleDrivers, driverId: DriverId): void {
	const drivers = idle[internals];
	if (!drivers.busy.delete(driverId)) throw new Error(`${driverId} not busy`);
	const cell = drivers.cells.get(driverId);
	if (cell !== undefined) addIdle(drivers, driverId, cell);
}

// Idle drivers and their cells, ordered by ID (batched matching's columns).
export function idleDriversById(idle: IdleDrivers): IdleDriver[] {
	const drivers = idle[internals];
	return Array.from(drivers.idle.values(), ({ driverId, cell }) => ({
		driverId,
		cell,
	})).sort((a, b) => (a.driverId < b.driverId ? -1 : 1));
}

function addIdle(drivers: Drivers, driverId: DriverId, cell: Cell): void {
	const entry: Entry = { driverId, cell, bucket: 0, slot: 0 };
	addToBucket(drivers, entry);
	drivers.idle.set(driverId, entry);
}

function removeIdle(drivers: Drivers, driverId: DriverId): void {
	const entry = drivers.idle.get(driverId);
	if (entry === undefined) return;
	removeFromBucket(drivers, entry);
	drivers.idle.delete(driverId);
}

function addToBucket(drivers: Drivers, entry: Entry): void {
	entry.bucket = bucketOf(drivers, entry.cell);
	const bucket = drivers.buckets[entry.bucket];
	if (bucket === undefined) throw new Error(`no bucket ${entry.bucket}`);
	entry.slot = bucket.length;
	bucket.push(entry);
}

function removeFromBucket(drivers: Drivers, entry: Entry): void {
	const bucket = drivers.buckets[entry.bucket];
	const last = bucket?.pop();
	if (bucket === undefined || last === undefined) {
		throw new Error(`${entry.driverId} not in its bucket`);
	}
	if (last === entry) return;
	bucket[entry.slot] = last;
	last.slot = entry.slot;
}

// A cell off the grid (bad input from another service; grid bounds are an
// event log invariant) goes to the nearest edge bucket. The search stays
// exact: from an in-grid pickup, the true cell is at least as far as the
// clamped one, so the ring bound still holds.
function bucketOf(drivers: Drivers, cell: Cell): number {
	const size = drivers.search.cellsPerBucket;
	const column = Math.min(Math.floor(cell.x / size), drivers.columns - 1);
	const row = Math.min(Math.floor(cell.y / size), drivers.rows - 1);
	return row * drivers.columns + column;
}

// The idle driver nearest to the pickup, ties to the lowest ID (plain string
// order), never one excluded; exactly what a linear scan returns.
export function nearestIdle(
	idle: IdleDrivers,
	pickup: Cell,
	excluded: ReadonlySet<DriverId>,
): DriverId | undefined {
	const drivers = idle[internals];
	// The ring bound holds for in-grid pickups only (see bucketOf); a pickup
	// off the grid is bad input, so take the scan, exact by construction.
	const pickupOffGrid =
		pickup.x >= drivers.grid.width || pickup.y >= drivers.grid.height;
	const nearest =
		pickupOffGrid || drivers.idle.size < drivers.search.linearScanBelow
			? scanAll(drivers, pickup, excluded)
			: searchRings(drivers, pickup, excluded);
	return nearest?.driverId;
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
	drivers: Drivers,
	pickup: Cell,
	excluded: ReadonlySet<DriverId>,
): IdleDriver | undefined {
	let nearest: Nearest;
	for (const driver of drivers.idle.values()) {
		if (excluded.has(driver.driverId)) continue;
		nearest = closer(nearest, driver, pickup);
	}
	return nearest?.driver;
}

// Square rings of buckets around the pickup's bucket. Ring r can hold cells
// at up to twice the distance of ring r+1's nearest, so keep expanding until
// nothing in ring r or beyond can be as near as the best found.
function searchRings(
	drivers: Drivers,
	pickup: Cell,
	excluded: ReadonlySet<DriverId>,
): IdleDriver | undefined {
	const size = drivers.search.cellsPerBucket;
	const column = Math.floor(pickup.x / size);
	const row = Math.floor(pickup.y / size);
	const lastRing = Math.max(
		column,
		row,
		drivers.columns - 1 - column,
		drivers.rows - 1 - row,
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
			if (y < 0 || y >= drivers.rows) continue;
			const edgeRow = y === row - ring || y === row + ring;
			const step = edgeRow ? 1 : 2 * ring;
			for (let x = column - ring; x <= column + ring; x += step) {
				if (x < 0 || x >= drivers.columns) continue;
				for (const driver of drivers.buckets[y * drivers.columns + x] ?? []) {
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
