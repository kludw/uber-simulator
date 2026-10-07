// #240 experiment, not merged: exact batched matching that never scans every
// idle driver. Same objective as minCostMatching (ADR 0030): as many pairs as
// possible, least total pickup distance among those; rows = queued trips
// (needs trips <= idle drivers).
//
// Shortest augmenting paths with potentials, as in matching.ts, but a column
// (idle driver) no phase has reached yet ("untouched") still has potential 0
// and no row, so for each visited row the cheapest untouched column is its
// nearest untouched allowed driver: one grid query, not a scan. Only touched
// columns (reached by some earlier phase) are kept and scanned explicitly.
import type { Cell } from "../shared/grid.ts";
import { distanceToCoordinates } from "../shared/grid.ts";
import type { DriverId } from "../shared/messages.ts";
import {
	type IdleDrivers,
	idleCell,
	idleCount,
	nearestIdle,
} from "./idle-drivers.ts";

export type LazyRow = { pickup: Cell; excludedDrivers: ReadonlySet<DriverId> };
export type LazyPair = { row: number; driverId: DriverId };

export const lazyStats = { phases: 0, steps: 0, queries: 0, touched: 0 };

export function lazyMinCostMatching(
	rows: readonly LazyRow[],
	drivers: IdleDrivers,
	maxDistance: number,
): LazyPair[] {
	const rowCount = rows.length;
	if (rowCount === 0) return [];
	if (rowCount > idleCount(drivers)) throw new Error("more rows than columns");
	// Larger than any whole matching of allowed pairs.
	const sentinel = rowCount * maxDistance + 1;
	const rowPotential = new Float64Array(rowCount);
	// Touched columns, growing.
	const touchedIds: DriverId[] = [];
	const touchedX: number[] = [];
	const touchedY: number[] = [];
	const columnPotential: number[] = [];
	const rowOfColumn: number[] = []; // -1 = free
	const allowedOfColumn: boolean[] = [];
	const columnOfRow = new Int32Array(rowCount).fill(-1);
	const touchedIndex = new Map<DriverId, number>();

	// Per phase, indexed by touched column; reallocated lazily.
	let key: number[] = [];
	let prev: number[] = [];
	let keyAllowed: boolean[] = [];
	let visited: boolean[] = [];
	let visitedAt: number[] = [];

	const useCache = process.env.CACHE_NEAREST !== "false";
	const cachedDriver: (DriverId | undefined)[] = new Array(rowCount);
	const cachedDist: number[] = new Array(rowCount);
	const root = -1;
	for (let startRow = 0; startRow < rowCount; startRow++) {
		lazyStats.phases++;
		const touchedCount = touchedIds.length;
		key = new Array(touchedCount).fill(Number.POSITIVE_INFINITY);
		prev = new Array(touchedCount).fill(root);
		keyAllowed = new Array(touchedCount).fill(false);
		visited = new Array(touchedCount).fill(false);
		visitedAt = new Array(touchedCount).fill(0);
		// Visited rows, when visited, and their cheapest untouched column.
		const visitedRows: number[] = [];
		const rowVisitedAt: number[] = [];
		const poolDriver: (DriverId | undefined)[] = [];
		const poolKey: number[] = [];
		const poolAllowed: boolean[] = [];
		const isTouched = { has: (id: DriverId) => touchedIndex.has(id) };

		let currentRow = startRow;
		let currentColumn = root;
		let reached = 0; // cumulative delta
		let endColumn = -1; // touched column the path ends on, or
		let endPool = -1; // index into visitedRows whose untouched column ends it
		for (;;) {
			lazyStats.steps++;
			visitedRows.push(currentRow);
			rowVisitedAt.push(reached);
			const row = rows[currentRow];
			if (row === undefined) throw new Error("row out of range");
			const u = rowPotential[currentRow] ?? 0;
			for (let column = 0; column < touchedCount; column++) {
				if (visited[column]) continue;
				const allowed = !row.excludedDrivers.has(
					touchedIds[column] as DriverId,
				);
				const cost = allowed
					? distanceToCoordinates(
							row.pickup,
							touchedX[column] as number,
							touchedY[column] as number,
						)
					: sentinel;
				const candidate =
					cost - u - (columnPotential[column] as number) + reached;
				if (candidate < (key[column] as number)) {
					key[column] = candidate;
					prev[column] = currentColumn;
					keyAllowed[column] = allowed;
				}
			}
			// Untouched columns only shrink, so a row's nearest untouched
			// driver stays its nearest until it is touched (CACHE_NEAREST).
			let driverId = useCache ? cachedDriver[currentRow] : undefined;
			let cachedDistance = useCache ? cachedDist[currentRow] : undefined;
			if (driverId === undefined || touchedIndex.has(driverId)) {
				lazyStats.queries++;
				const skip = {
					has: (id: DriverId) =>
						touchedIndex.has(id) || row.excludedDrivers.has(id),
				};
				driverId = nearestIdle(
					drivers,
					row.pickup,
					skip as unknown as ReadonlySet<DriverId>,
				);
				if (driverId !== undefined) {
					const cell = idleCell(drivers, driverId);
					cachedDistance = distanceToCoordinates(row.pickup, cell.x, cell.y);
					cachedDriver[currentRow] = driverId;
					cachedDist[currentRow] = cachedDistance;
				}
			}
			if (driverId !== undefined) {
				poolDriver.push(driverId);
				poolKey.push((cachedDistance as number) - u + reached);
				poolAllowed.push(true);
			} else {
				driverId = nearestIdle(
					drivers,
					row.pickup,
					isTouched as unknown as ReadonlySet<DriverId>,
				);
				poolDriver.push(driverId);
				poolKey.push(
					driverId === undefined
						? Number.POSITIVE_INFINITY
						: sentinel - u + reached,
				);
				poolAllowed.push(false);
			}

			let best = Number.POSITIVE_INFINITY;
			let bestColumn = -1;
			let bestPool = -1;
			for (let column = 0; column < touchedCount; column++) {
				if (visited[column]) continue;
				if ((key[column] as number) < best) {
					best = key[column] as number;
					bestColumn = column;
				}
			}
			for (let index = 0; index < poolKey.length; index++) {
				if ((poolKey[index] as number) < best) {
					best = poolKey[index] as number;
					bestColumn = -1;
					bestPool = index;
				}
			}
			if (best === Number.POSITIVE_INFINITY) throw new Error("no column");
			reached = best;
			if (bestPool !== -1) {
				endPool = bestPool;
				break;
			}
			visited[bestColumn] = true;
			visitedAt[bestColumn] = reached;
			const matchedRow = rowOfColumn[bestColumn] as number;
			if (matchedRow === -1) {
				endColumn = bestColumn;
				break;
			}
			currentRow = matchedRow;
			currentColumn = bestColumn;
		}

		// Potentials: each visited row gains, each visited column loses, the
		// distance travelled since it was visited.
		for (let index = 0; index < visitedRows.length; index++) {
			const row = visitedRows[index] as number;
			rowPotential[row] =
				(rowPotential[row] as number) +
				reached -
				(rowVisitedAt[index] as number);
		}
		for (let column = 0; column < touchedCount; column++) {
			if (!visited[column]) continue;
			columnPotential[column] =
				(columnPotential[column] as number) -
				(reached - (visitedAt[column] as number));
		}

		// The path's last column, then back along prev to the root.
		let column: number;
		let fromColumn: number;
		let allowed: boolean;
		if (endPool !== -1) {
			const driverId = poolDriver[endPool] as DriverId;
			const cell = idleCell(drivers, driverId);
			column = touchedIds.length;
			touchedIds.push(driverId);
			touchedX.push(cell.x);
			touchedY.push(cell.y);
			columnPotential.push(0);
			rowOfColumn.push(-1);
			allowedOfColumn.push(false);
			touchedIndex.set(driverId, column);
			const fromRow = visitedRows[endPool] as number;
			fromColumn = columnOfRow[fromRow] as number;
			if (fromRow === startRow) fromColumn = root;
			allowed = poolAllowed[endPool] as boolean;
		} else {
			column = endColumn;
			fromColumn = prev[column] as number;
			allowed = keyAllowed[column] as boolean;
		}
		for (;;) {
			const row =
				fromColumn === root ? startRow : (rowOfColumn[fromColumn] as number);
			rowOfColumn[column] = row;
			allowedOfColumn[column] = allowed;
			columnOfRow[row] = column;
			if (fromColumn === root) break;
			column = fromColumn;
			fromColumn = prev[column] as number;
			allowed = keyAllowed[column] as boolean;
		}
	}
	lazyStats.touched += touchedIds.length;

	const pairs: LazyPair[] = [];
	for (let row = 0; row < rowCount; row++) {
		const column = columnOfRow[row] as number;
		if (column === -1 || !allowedOfColumn[column]) continue;
		pairs.push({ row, driverId: touchedIds[column] as DriverId });
	}
	return pairs;
}
