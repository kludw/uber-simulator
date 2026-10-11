import { type DriverIndex, driverIdAt } from "../shared/fleet.ts";
import {
	type Cell,
	type Coordinate,
	cellAt,
	distanceToCoordinates,
	type Grid,
} from "../shared/grid.ts";
import type { DriverId } from "../shared/messages.ts";
import { ratingPenaltyOf, type Stars } from "../shared/rating.ts";
import { roadBoundToBox, spikeCounts, spikeRoads } from "../shared/roads.ts";

const spikeNoBound = process.env.SPIKE_NOBOUND === "1";

import { type Zone, zoneOf } from "../shared/surge.ts";

// ratingPenalty: 0 unrated (ADR 0057).
export type IdleDriver = {
	driverId: DriverId;
	cell: Cell;
	ratingPenalty: number;
};

// Square buckets of cellsPerBucket x cellsPerBucket cells. Below
// linearScanBelow idle drivers, a linear scan beats searching mostly empty
// buckets (ADR 0036). linearScanBelow measured at 50k drivers, cellsPerBucket
// retuned at 400k and re-checked at 50k (docs/performance-history.md, Dispatch moves
// profile, Move handling cut).
type IdleDriverSearch = {
	cellsPerBucket: number;
	linearScanBelow: number;
};

const defaultSearch: IdleDriverSearch = {
	cellsPerBucket: 8,
	linearScanBelow: 64,
};

// Dispatch's drivers in its region across ticks (ADR 0048, 0050): each known
// or busy driver's cell, whether it is online and busy, and the idle ones
// (online, not busy) bucketed for the nearest search, the joinable ones
// (online, busy, marked by the brain) for the partner search (ADR 0058),
// updated in place as drivers report and trips change (ADR 0033). Opaque:
// callers can't name `internals`.
const internals: unique symbol = Symbol("idle drivers");
export type IdleDrivers = { readonly [internals]: Drivers };

// One record per driver, so a move costs one array read by driver index
// (ADR 0052). Its cell as x and y numbers, not a Cell, so a move allocates
// nothing (docs/performance-history.md, Dispatch moves profile). bucket is -1 unless idle; slot is its place in the
// bucket, so leaving is a swap with the bucket's last entry, not a search. A
// driver offline and not busy has none. partnerBucket and partnerSlot are
// the same for joinable drivers.
type Driver = {
	driverId: DriverId;
	index: DriverIndex;
	x: Coordinate;
	y: Coordinate;
	online: boolean;
	busy: boolean;
	bucket: number;
	slot: number;
	joinable: boolean;
	partnerBucket: number;
	partnerSlot: number;
};

type Drivers = {
	grid: Grid;
	region: Area;
	search: IdleDriverSearch;
	columns: number;
	rows: number;
	// Known drivers by driver index, the fleet's size long, for moves; by ID
	// for the messages that name a driver by ID. Set and cleared together.
	byIndex: (Driver | undefined)[];
	byId: Map<DriverId, Driver>;
	idleCount: number;
	// Row-major by bucket, unordered within a bucket.
	buckets: Driver[][];
	// Online joinable drivers (holding one pooled trip alone, ADR 0058), the
	// same buckets.
	partnerBuckets: Driver[][];
	// The fleet's ratings by driver index, any region's drivers (ADR 0057):
	// null until the first rating, so nothing is allocated with ratings off.
	ratings: Ratings | null;
};

// Fleet-sized: stars sum, ratings count and the rating penalty they give.
type Ratings = { sum: Int32Array; count: Int32Array; penalty: Int32Array };

const notIdle = -1;

// Inclusive corners, as regionBounds returns them.
type Area = { min: Cell; max: Cell };

// fleetSize: the run's fleet; driver indexes are below it (ADR 0052).
// region: the cells whose drivers this index keeps (ADR 0050); missing = the
// whole grid.
export function startIdleDrivers(
	grid: Grid,
	fleetSize: number,
	region: Area = {
		min: cellAt(0 as Coordinate, 0 as Coordinate),
		max: cellAt(
			(grid.width - 1) as Coordinate,
			(grid.height - 1) as Coordinate,
		),
	},
	search: IdleDriverSearch = defaultSearch,
): IdleDrivers {
	const size = search.cellsPerBucket;
	const columns = Math.ceil(grid.width / size);
	const rows = Math.ceil(grid.height / size);
	return {
		[internals]: {
			grid,
			region,
			search,
			columns,
			rows,
			byIndex: new Array<Driver | undefined>(fleetSize).fill(undefined),
			byId: new Map(),
			idleCount: 0,
			buckets: Array.from({ length: columns * rows }, (): Driver[] => []),
			partnerBuckets: Array.from(
				{ length: columns * rows },
				(): Driver[] => [],
			),
			ratings: null,
		},
	};
}

// A rider rated a driver of the fleet, in this region or not: a driver
// crossing into the region brings its rating (ADR 0057). Callers check the
// index is the fleet's.
export function rateDriver(
	idle: IdleDrivers,
	index: DriverIndex,
	stars: Stars,
): void {
	const drivers = idle[internals];
	const size = drivers.byIndex.length;
	if (index >= size) throw new Error(`driver index ${index} outside the fleet`);
	drivers.ratings ??= {
		sum: new Int32Array(size),
		count: new Int32Array(size),
		penalty: new Int32Array(size),
	};
	const { sum, count, penalty } = drivers.ratings;
	const newSum = (sum[index] ?? 0) + stars;
	const newCount = (count[index] ?? 0) + 1;
	sum[index] = newSum;
	count[index] = newCount;
	penalty[index] = ratingPenaltyOf(newSum, newCount);
}

// Whether any driver of the fleet is rated; its arrays exist only then.
export function anyDriverRated(idle: IdleDrivers): boolean {
	return idle[internals].ratings !== null;
}

// A driver went online or moved; a driver first seen moving in the region is
// known from then on. A known driver outside the region is dropped unless
// busy (ADR 0050).
export function placeDriverAt(
	idle: IdleDrivers,
	index: DriverIndex,
	x: Coordinate,
	y: Coordinate,
): void {
	const drivers = idle[internals];
	// Callers check messages' fleet size against this index's (ADR 0052).
	if (index >= drivers.byIndex.length) {
		throw new Error(`driver index ${index} outside the fleet`);
	}
	const driver = drivers.byIndex[index];
	if (driver !== undefined) {
		place(drivers, driver, x, y);
		return;
	}
	if (!inRegion(drivers, x, y)) return;
	const placed: Driver = {
		driverId: driverIdAt(drivers.byIndex.length, index),
		index,
		x,
		y,
		online: true,
		busy: false,
		bucket: notIdle,
		slot: 0,
		joinable: false,
		partnerBucket: notIdle,
		partnerSlot: 0,
	};
	drivers.byIndex[index] = placed;
	drivers.byId.set(placed.driverId, placed);
	addToBucket(drivers, placed);
}

// As placeDriverAt, for a driver named by ID: an offer reply or an arrival,
// taken only from a driver dispatch keeps busy, so known; any other is a bug.
export function placeDriver(
	idle: IdleDrivers,
	driverId: DriverId,
	x: Coordinate,
	y: Coordinate,
): void {
	const drivers = idle[internals];
	const driver = drivers.byId.get(driverId);
	if (driver === undefined) throw new Error(`${driverId} is not known`);
	place(drivers, driver, x, y);
}

function place(
	drivers: Drivers,
	driver: Driver,
	x: Coordinate,
	y: Coordinate,
): void {
	driver.x = x;
	driver.y = y;
	// A busy driver keeps its record, offline or outside the region, until
	// freed, and stays out of the buckets until then. Any other known driver
	// is online, in the region, and bucketed.
	if (driver.busy) {
		driver.online = true;
		if (driver.joinable) placePartner(drivers, driver);
		return;
	}
	if (!inRegion(drivers, x, y)) {
		removeFromBucket(drivers, driver);
		forget(drivers, driver);
		return;
	}
	if (bucketOf(drivers, x, y) === driver.bucket) return;
	removeFromBucket(drivers, driver);
	addToBucket(drivers, driver);
}

// A driver went offline. A busy driver stays busy until freed.
export function removeDriver(idle: IdleDrivers, driverId: DriverId): void {
	const drivers = idle[internals];
	const driver = drivers.byId.get(driverId);
	if (driver === undefined) return;
	if (driver.bucket !== notIdle) removeFromBucket(drivers, driver);
	if (driver.partnerBucket !== notIdle) removePartner(drivers, driver);
	if (driver.busy) driver.online = false;
	else forget(drivers, driver);
}

// A driver was offered a trip while idle. One mark covers a driver's trips:
// a second (a pooled join, ADR 0056) is the caller's to count, so marking a
// driver that is not idle is a bug.
export function markBusy(idle: IdleDrivers, driverId: DriverId): void {
	const drivers = idle[internals];
	const driver = drivers.byId.get(driverId);
	if (driver === undefined || driver.bucket === notIdle) {
		throw new Error(`${driverId} is not idle`);
	}
	removeFromBucket(drivers, driver);
	driver.busy = true;
}

// A driver's offer or trip is over: idle again if online and in the region,
// else dropped.
export function markFree(idle: IdleDrivers, driverId: DriverId): void {
	const drivers = idle[internals];
	const driver = drivers.byId.get(driverId);
	if (driver === undefined || !driver.busy) {
		throw new Error(`${driverId} is not busy`);
	}
	if (driver.joinable) throw new Error(`${driverId} is joinable`);
	driver.busy = false;
	if (driver.online && inRegion(drivers, driver.x, driver.y)) {
		addToBucket(drivers, driver);
	} else forget(drivers, driver);
}

function forget(drivers: Drivers, driver: Driver): void {
	drivers.byIndex[driver.index] = undefined;
	drivers.byId.delete(driver.driverId);
}

export function idleCount(idle: IdleDrivers): number {
	return idle[internals].idleCount;
}

// Idle drivers per surge zone of their cell (pricing, ADR 0054); zones without
// one are missing. A pass over the buckets, no collecting or sorting.
export function idleCountsByZone(idle: IdleDrivers): Map<Zone, number> {
	const drivers = idle[internals];
	const counts = new Map<Zone, number>();
	for (const bucket of drivers.buckets) {
		for (const { x, y } of bucket) {
			const zone = zoneOf(drivers.grid, cellAt(x, y));
			counts.set(zone, (counts.get(zone) ?? 0) + 1);
		}
	}
	return counts;
}

// Idle drivers, their cells and rating penalties, ordered by ID (batched
// matching's columns).
export function idleDriversById(idle: IdleDrivers): IdleDriver[] {
	const drivers = idle[internals];
	const idleDrivers: IdleDriver[] = [];
	for (const bucket of drivers.buckets) {
		for (const driver of bucket) {
			idleDrivers.push(idleDriverOf(drivers, driver));
		}
	}
	return idleDrivers.sort((a, b) => (a.driverId < b.driverId ? -1 : 1));
}

function addToBucket(drivers: Drivers, driver: Driver): void {
	driver.bucket = bucketOf(drivers, driver.x, driver.y);
	const bucket = drivers.buckets[driver.bucket];
	if (bucket === undefined) throw new Error(`no bucket ${driver.bucket}`);
	driver.slot = bucket.length;
	bucket.push(driver);
	drivers.idleCount++;
}

function removeFromBucket(drivers: Drivers, driver: Driver): void {
	const bucket = drivers.buckets[driver.bucket];
	const last = bucket?.pop();
	if (bucket === undefined || last === undefined) {
		throw new Error(`${driver.driverId} not in its bucket`);
	}
	if (last !== driver) {
		bucket[driver.slot] = last;
		last.slot = driver.slot;
	}
	driver.bucket = notIdle;
	drivers.idleCount--;
}

// A region's sides on the grid's edges are open, so a cell off the grid
// (bad input) stays where bucketOf puts it, as with one region.
function inRegion(drivers: Drivers, x: number, y: number): boolean {
	const { grid, region } = drivers;
	return (
		x >= region.min.x &&
		y >= region.min.y &&
		(x <= region.max.x || region.max.x === grid.width - 1) &&
		(y <= region.max.y || region.max.y === grid.height - 1)
	);
}

// A cell off the grid (bad input from another service; grid bounds are an
// event log invariant) goes to the nearest edge bucket. The search stays
// exact: from an in-grid pickup, the true cell is at least as far as the
// clamped one, so the ring bound still holds.
function bucketOf(drivers: Drivers, x: number, y: number): number {
	const size = drivers.search.cellsPerBucket;
	const column = Math.min(Math.floor(x / size), drivers.columns - 1);
	const row = Math.min(Math.floor(y / size), drivers.rows - 1);
	return row * drivers.columns + column;
}

// The idle driver nearest to the pickup, ties to the lowest ID (plain string
// order), never one excluded; exactly what a linear scan returns.
export function nearestIdle(
	idle: IdleDrivers,
	pickup: Cell,
	excluded: ReadonlySet<DriverId>,
): DriverId | undefined {
	return search(idle[internals], pickup, (driverId) => excluded.has(driverId))
		?.driverId;
}

// As nearestIdle, never a driver `skip` holds for, and with the driver's cell
// and rating penalty. By pickup distance alone, rated or not: a pooled
// trip's join reach (ADR 0057, 0058).
export function nearestIdleSkipping(
	idle: IdleDrivers,
	pickup: Cell,
	skip: (driverId: DriverId) => boolean,
): IdleDriver | undefined {
	const drivers = idle[internals];
	const nearest = search(drivers, pickup, skip);
	return nearest === undefined ? undefined : idleDriverOf(drivers, nearest);
}

function idleDriverOf(drivers: Drivers, driver: Driver): IdleDriver {
	return {
		driverId: driver.driverId,
		cell: cellAt(driver.x, driver.y),
		ratingPenalty: drivers.ratings?.penalty[driver.index] ?? 0,
	};
}

// The idle driver of least match cost (pickup distance + rating penalty) to
// the pickup, ties to the lowest ID, never one excluded; exactly what a
// linear scan returns (greedy matching, ADR 0057). Before any rating, the
// nearest idle driver by today's search.
export function leastMatchCostIdle(
	idle: IdleDrivers,
	pickup: Cell,
	excluded: ReadonlySet<DriverId>,
): DriverId | undefined {
	const drivers = idle[internals];
	if (drivers.ratings === null) return nearestIdle(idle, pickup, excluded);
	return searchRated(drivers, drivers.ratings.penalty, pickup, (driverId) =>
		excluded.has(driverId),
	)?.driverId;
}

// As leastMatchCostIdle, never a driver `skip` holds for, with the driver's
// cell and rating penalty (batched matching's untouched driver, ADR 0051,
// 0057).
export function leastMatchCostIdleSkipping(
	idle: IdleDrivers,
	pickup: Cell,
	skip: (driverId: DriverId) => boolean,
): IdleDriver | undefined {
	const drivers = idle[internals];
	const best =
		drivers.ratings === null
			? search(drivers, pickup, skip)
			: searchRated(drivers, drivers.ratings.penalty, pickup, skip);
	return best === undefined ? undefined : idleDriverOf(drivers, best);
}

function searchRated(
	drivers: Drivers,
	penalty: Int32Array,
	pickup: Cell,
	skip: (driverId: DriverId) => boolean,
): Driver | undefined {
	// As search: the ring bound holds for in-grid pickups only.
	const pickupOffGrid =
		pickup.x >= drivers.grid.width || pickup.y >= drivers.grid.height;
	return pickupOffGrid || drivers.idleCount < drivers.search.linearScanBelow
		? scanAllRated(drivers, penalty, pickup, skip)
		: searchRingsRated(drivers, penalty, pickup, skip);
}

// As searchRings, by match cost. Penalties are never negative, so a ring,
// bucket or driver farther than the best match cost found can't hold a
// better one: each is skipped before reading a penalty. The best is kept in
// locals, nothing allocated per candidate (ADR 0057's bench).
function searchRingsRated(
	drivers: Drivers,
	penalty: Int32Array,
	pickup: Cell,
	skip: (driverId: DriverId) => boolean,
): Driver | undefined {
	const size = drivers.search.cellsPerBucket;
	const column = Math.floor(pickup.x / size);
	const row = Math.floor(pickup.y / size);
	const lastRing = Math.max(
		column,
		row,
		drivers.columns - 1 - column,
		drivers.rows - 1 - row,
	);
	let best: Driver | undefined;
	let bestCost = Number.POSITIVE_INFINITY;
	for (let ring = 0; ring <= lastRing; ring++) {
		if (nearestBeyond(pickup, size, ring) > bestCost) break;
		for (let y = row - ring; y <= row + ring; y++) {
			if (y < 0 || y >= drivers.rows) continue;
			const edgeRow = y === row - ring || y === row + ring;
			const step = edgeRow ? 1 : 2 * ring;
			// Least distance from the pickup to this row of buckets. A driver
			// off the grid sits in an edge bucket but is no nearer than it.
			const dy =
				y < row
					? pickup.y - (y * size + size - 1)
					: y > row
						? y * size - pickup.y
						: 0;
			for (let x = column - ring; x <= column + ring; x += step) {
				if (x < 0 || x >= drivers.columns) continue;
				const dx =
					x < column
						? pickup.x - (x * size + size - 1)
						: x > column
							? x * size - pickup.x
							: 0;
				if (dx + dy > bestCost) continue;
				for (const driver of drivers.buckets[y * drivers.columns + x] ?? []) {
					const distance = distanceToCoordinates(pickup, driver.x, driver.y);
					if (distance > bestCost) continue;
					const cost = distance + (penalty[driver.index] ?? 0);
					if (cost > bestCost) continue;
					if (
						cost === bestCost &&
						best !== undefined &&
						driver.driverId > best.driverId
					) {
						continue;
					}
					if (skip(driver.driverId)) continue;
					best = driver;
					bestCost = cost;
				}
			}
		}
	}
	return best;
}

function scanAllRated(
	drivers: Drivers,
	penalty: Int32Array,
	pickup: Cell,
	skip: (driverId: DriverId) => boolean,
): Driver | undefined {
	let best: Driver | undefined;
	let bestCost = Number.POSITIVE_INFINITY;
	for (const bucket of drivers.buckets) {
		for (const driver of bucket) {
			if (skip(driver.driverId)) continue;
			const cost =
				distanceToCoordinates(pickup, driver.x, driver.y) +
				(penalty[driver.index] ?? 0);
			if (cost > bestCost) continue;
			if (
				cost === bestCost &&
				best !== undefined &&
				driver.driverId > best.driverId
			) {
				continue;
			}
			best = driver;
			bestCost = cost;
		}
	}
	return best;
}

function search(
	drivers: Drivers,
	pickup: Cell,
	skip: (driverId: DriverId) => boolean,
): Driver | undefined {
	// The ring bound holds for in-grid pickups only (see bucketOf); a pickup
	// off the grid is bad input, so take the scan, exact by construction.
	const pickupOffGrid =
		pickup.x >= drivers.grid.width || pickup.y >= drivers.grid.height;
	const before = spikeCounts.calls;
	const found =
		pickupOffGrid || drivers.idleCount < drivers.search.linearScanBelow
			? scanAll(drivers, pickup, skip)
			: searchRings(drivers, pickup, skip);
	const used = spikeCounts.calls - before;
	spikeCounts.searches++;
	spikeCounts.idle = drivers.idleCount;
	if (used > spikeCounts.maxCalls) spikeCounts.maxCalls = used;
	if (used > 5000) spikeCounts.wide++;
	if (used > 5000 && found !== undefined)
		spikeCounts.wideDistance += distanceToCoordinates(pickup, found.x, found.y);
	return found;
}

type Nearest = { driver: Driver; distance: number } | undefined;

function closer(nearest: Nearest, driver: Driver, pickup: Cell): Nearest {
	const toPickup = distanceToCoordinates(pickup, driver.x, driver.y);
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
	skip: (driverId: DriverId) => boolean,
): Driver | undefined {
	let nearest: Nearest;
	for (const bucket of drivers.buckets) {
		for (const driver of bucket) {
			if (skip(driver.driverId)) continue;
			nearest = closer(nearest, driver, pickup);
		}
	}
	return nearest?.driver;
}

// Square rings of buckets around the pickup's bucket. Ring r can hold cells
// at up to twice the distance of ring r+1's nearest, so keep expanding until
// nothing in ring r or beyond can be as near as the best found.
function searchRings(
	drivers: Drivers,
	pickup: Cell,
	skip: (driverId: DriverId) => boolean,
): Driver | undefined {
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
				const bucket = drivers.buckets[y * drivers.columns + x] ?? [];
				if (bucket.length === 0) continue;
				if (
					spikeRoads !== null &&
					!spikeNoBound &&
					nearest !== undefined &&
					roadBoundToBox(
						spikeRoads,
						pickup.x,
						pickup.y,
						x * size,
						y * size,
						Math.min(x * size + size - 1, drivers.grid.width - 1),
						Math.min(y * size + size - 1, drivers.grid.height - 1),
					) > nearest.distance
				) {
					continue;
				}
				for (const driver of bucket) {
					if (skip(driver.driverId)) continue;
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

// A busy driver became joinable (holds one pooled trip alone) or stopped
// being so (ADR 0058); searched by bestPartner while online.
export function markJoinable(
	idle: IdleDrivers,
	driverId: DriverId,
	joinable: boolean,
): void {
	const drivers = idle[internals];
	const driver = drivers.byId.get(driverId);
	if (driver === undefined || !driver.busy) {
		throw new Error(`${driverId} is not busy`);
	}
	driver.joinable = joinable;
	if (joinable && driver.online) placePartner(drivers, driver);
	if (!joinable && driver.partnerBucket !== notIdle) {
		removePartner(drivers, driver);
	}
}

function placePartner(drivers: Drivers, driver: Driver): void {
	const bucket = bucketOf(drivers, driver.x, driver.y);
	if (bucket === driver.partnerBucket) return;
	if (driver.partnerBucket !== notIdle) removePartner(drivers, driver);
	const partners = drivers.partnerBuckets[bucket];
	if (partners === undefined) throw new Error(`no bucket ${bucket}`);
	driver.partnerBucket = bucket;
	driver.partnerSlot = partners.length;
	partners.push(driver);
}

function removePartner(drivers: Drivers, driver: Driver): void {
	const partners = drivers.partnerBuckets[driver.partnerBucket];
	const last = partners?.pop();
	if (partners === undefined || last === undefined) {
		throw new Error(`${driver.driverId} not in its partner bucket`);
	}
	if (last !== driver) {
		partners[driver.partnerSlot] = last;
		last.partnerSlot = driver.partnerSlot;
	}
	driver.partnerBucket = notIdle;
}

// The online joinable driver with the least join ETA to the pickup, at most
// `within`, ties to the lowest ID; joinEta gives a driver's join ETA from its
// cell (null: no join), never less than the cell's distance to the pickup, so
// rings beyond the best (or `within`) are skipped.
export function bestPartner(
	idle: IdleDrivers,
	pickup: Cell,
	within: number,
	joinEta: (driverId: DriverId, cell: Cell) => number | null,
): DriverId | undefined {
	const drivers = idle[internals];
	const size = drivers.search.cellsPerBucket;
	// As search: the ring bound holds for in-grid pickups only.
	const exact = pickup.x < drivers.grid.width && pickup.y < drivers.grid.height;
	const column = Math.min(Math.floor(pickup.x / size), drivers.columns - 1);
	const row = Math.min(Math.floor(pickup.y / size), drivers.rows - 1);
	const lastRing = Math.max(
		column,
		row,
		drivers.columns - 1 - column,
		drivers.rows - 1 - row,
	);
	let best: { driverId: DriverId; eta: number } | undefined;
	for (let ring = 0; ring <= lastRing; ring++) {
		if (exact && nearestBeyond(pickup, size, ring) > (best?.eta ?? within)) {
			break;
		}
		for (let y = row - ring; y <= row + ring; y++) {
			if (y < 0 || y >= drivers.rows) continue;
			const edgeRow = y === row - ring || y === row + ring;
			const step = edgeRow ? 1 : 2 * ring;
			for (let x = column - ring; x <= column + ring; x += step) {
				if (x < 0 || x >= drivers.columns) continue;
				for (const driver of drivers.partnerBuckets[y * drivers.columns + x] ??
					[]) {
					if (distanceToCoordinates(pickup, driver.x, driver.y) > within) {
						continue;
					}
					const eta = joinEta(driver.driverId, cellAt(driver.x, driver.y));
					if (eta === null || eta > within) continue;
					if (
						best === undefined ||
						eta < best.eta ||
						(eta === best.eta && driver.driverId < best.driverId)
					) {
						best = { driverId: driver.driverId, eta };
					}
				}
			}
		}
	}
	return best?.driverId;
}
