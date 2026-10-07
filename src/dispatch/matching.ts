import {
	type Cell,
	distance,
	distanceToCoordinates,
	type Grid,
} from "../shared/grid.ts";
import type { DriverId } from "../shared/messages.ts";

export interface Pair {
	row: number;
	column: number;
}

/**
 * Writes one row's (or column's) costs into `out`, one per member of the other
 * side: a non-negative integer, or Infinity where the pair is not allowed.
 */
export type FillCosts = (index: number, out: number[]) => void;

/**
 * Batch assignment (ADR 0030) of `rows` x `columns`. Asks for one row's costs at a
 * time (`ofRow`), or one column's when there are more rows than columns
 * (`ofColumn`), several times each, and never stores the matrix: memory is
 * O(rows + columns), not O(rows x columns) (#213). Returns pairs ordered by row: as
 * many allowed pairs as possible, least total cost among those. Pure function of
 * the input; which of several optimal matchings comes back is not specified.
 * Throws on a cost that is neither a non-negative integer nor Infinity (caller bug).
 */
export function minCostMatching(
	rows: number,
	columns: number,
	costs: { ofRow: FillCosts; ofColumn: FillCosts },
): Pair[] {
	// Hungarian below needs rows <= columns: solve the transpose otherwise, swap back.
	const pairs =
		rows > columns
			? solve(columns, rows, costs.ofColumn).map(({ row, column }) => ({
					row: column,
					column: row,
				}))
			: solve(rows, columns, costs.ofRow);
	return pairs.sort((a, b) => a.row - b.row);
}

// Rectangular Hungarian with potentials (shortest augmenting paths), rows <= columns,
// O(rows^2 x columns); 1-indexed, index 0 is a virtual column used as the root of each
// augmenting path. Every row ends matched; rows matched on a disallowed cell are dropped.
function solve(rows: number, columns: number, ofRow: FillCosts): Pair[] {
	const rowCosts = new Array<number>(columns).fill(0);
	// Disallowed cells cost more than any whole set of allowed pairs, so the optimum
	// uses as many allowed pairs as possible. Finite: Infinity breaks the potentials.
	let sentinel = 1;
	for (let row = 0; row < rows; row++) {
		// A cell the filler skips stays NaN and throws below, not a stale cost.
		rowCosts.fill(Number.NaN);
		ofRow(row, rowCosts);
		for (const cost of rowCosts) {
			if (cost === Number.POSITIVE_INFINITY) continue;
			if (!(Number.isInteger(cost) && cost >= 0)) {
				throw new Error(`cost ${cost} is not a non-negative integer`);
			}
			sentinel += cost;
		}
	}

	const rowPotential = new Array<number>(rows + 1).fill(0);
	const columnPotential = new Array<number>(columns + 1).fill(0);
	const rowOfColumn = new Array<number>(columns + 1).fill(0);
	const previousColumn = new Array<number>(columns + 1).fill(0);
	// Whether the pair a column is matched on is allowed: costs aren't kept to look up.
	const allowedOfColumn = new Array<boolean>(columns + 1).fill(false);
	// Reset per row, allocated once: a fresh set per row was rows x columns of garbage.
	const slack = new Array<number>(columns + 1);
	const slackAllowed = new Array<boolean>(columns + 1);
	const visited = new Array<boolean>(columns + 1);
	for (let row = 1; row <= rows; row++) {
		rowOfColumn[0] = row;
		let column = 0;
		slack.fill(Number.POSITIVE_INFINITY);
		slackAllowed.fill(false);
		visited.fill(false);
		do {
			visited[column] = true;
			const currentRow = at(rowOfColumn, column);
			ofRow(currentRow - 1, rowCosts);
			let delta = Number.POSITIVE_INFINITY;
			let nextColumn = 0;
			for (let candidate = 1; candidate <= columns; candidate++) {
				if (visited[candidate]) continue;
				const cost = at(rowCosts, candidate - 1);
				const allowed = cost !== Number.POSITIVE_INFINITY;
				const reduced =
					(allowed ? cost : sentinel) -
					at(rowPotential, currentRow) -
					at(columnPotential, candidate);
				if (reduced < at(slack, candidate)) {
					slack[candidate] = reduced;
					slackAllowed[candidate] = allowed;
					previousColumn[candidate] = column;
				}
				if (at(slack, candidate) < delta) {
					delta = at(slack, candidate);
					nextColumn = candidate;
				}
			}
			for (let candidate = 0; candidate <= columns; candidate++) {
				if (visited[candidate]) {
					const visitedRow = at(rowOfColumn, candidate);
					rowPotential[visitedRow] = at(rowPotential, visitedRow) + delta;
					columnPotential[candidate] = at(columnPotential, candidate) - delta;
				} else {
					slack[candidate] = at(slack, candidate) - delta;
				}
			}
			column = nextColumn;
		} while (at(rowOfColumn, column) !== 0);
		// Each column on the path takes the row (and pair) its slack came from.
		do {
			const previous = at(previousColumn, column);
			rowOfColumn[column] = at(rowOfColumn, previous);
			allowedOfColumn[column] = slackAllowed[column] === true;
			column = previous;
		} while (column !== 0);
	}

	const pairs: Pair[] = [];
	for (let column = 1; column <= columns; column++) {
		const row = at(rowOfColumn, column) - 1;
		if (row < 0 || !allowedOfColumn[column]) continue;
		pairs.push({ row, column: column - 1 });
	}
	return pairs;
}

function at<Value>(values: ArrayLike<Value>, index: number): Value {
	const value = values[index];
	if (value === undefined) throw new Error(`index ${index} out of range`);
	return value;
}

export type MatchTrip = {
	pickup: Cell;
	excludedDrivers: ReadonlySet<DriverId>;
};

/**
 * The idle driver nearest to the pickup that `skip` doesn't hold for, ties to
 * the lowest ID, with its cell; undefined when there is none.
 */
export type NearestDriver = (
	pickup: Cell,
	skip: (driverId: DriverId) => boolean,
) => { driverId: DriverId; cell: Cell } | undefined;

export type TripPair = { row: number; driverId: DriverId };

/**
 * Batch assignment (ADR 0030) of queued trips to idle drivers found by
 * `nearest`, never listed (ADR 0051): same objective as minCostMatching, pairs
 * ordered by row (trip index). Needs at least as many idle drivers as trips;
 * throws otherwise (caller bug). Costs are pickup distances; drivers excluded
 * for a trip are not allowed. Pure function of the input; which of several
 * optimal matchings comes back is not specified.
 */
export function minCostMatchingByNearest(
	trips: readonly MatchTrip[],
	nearest: NearestDriver,
	grid: Grid,
): TripPair[] {
	const rows = trips.length;
	// A disallowed pair costs more than any whole set of allowed pairs, so the
	// optimum uses as many allowed pairs as possible.
	const sentinel = rows * (grid.width + grid.height - 2) + 1;
	const rowPotential = new Float64Array(rows);
	const columnOfRow = new Int32Array(rows).fill(unmatched);
	// Touched drivers (columns), in the order paths reached them. Each path
	// touches exactly one, so there are at most `rows`. Every touched driver
	// is matched; an untouched one has potential 0 and no row.
	const touchedIds: DriverId[] = [];
	const columnOf = new Map<DriverId, number>();
	const touchedXs = new Int32Array(rows);
	const touchedYs = new Int32Array(rows);
	const columnPotential = new Float64Array(rows);
	const rowOfColumn = new Int32Array(rows);
	const allowedOfColumn = new Uint8Array(rows);
	// Per path, by touched column: least reduced distance from the path's
	// start found so far, the column it came through (root: the start row),
	// whether that pair is allowed, and when the column was reached.
	const key = new Float64Array(rows);
	const keyFrom = new Int32Array(rows);
	const keyAllowed = new Uint8Array(rows);
	const reachedAt = new Float64Array(rows);
	const visited = new Uint8Array(rows);
	// Per path, by visited row: the row and when it was reached.
	const pathRows: number[] = [];
	const pathReachedAt: number[] = [];
	// Each trip's nearest allowed untouched driver. Untouched drivers only
	// shrink, so it stays the nearest until it is touched.
	const cached: (Untouched | undefined)[] = new Array(rows);

	// The cheapest untouched driver for a row: its nearest allowed one, else
	// any untouched one at the sentinel cost.
	const untouched = (row: number, trip: MatchTrip): Untouched => {
		const hit = cached[row];
		if (hit !== undefined && !columnOf.has(hit.driverId)) return hit;
		const allowed = nearest(
			trip.pickup,
			(driverId) =>
				columnOf.has(driverId) || trip.excludedDrivers.has(driverId),
		);
		if (allowed !== undefined) {
			const found = {
				driverId: allowed.driverId,
				cell: allowed.cell,
				cost: distance(trip.pickup, allowed.cell),
				allowed: true,
			};
			cached[row] = found;
			return found;
		}
		const any = nearest(trip.pickup, (driverId) => columnOf.has(driverId));
		if (any === undefined) throw new Error("more trips than idle drivers");
		return { ...any, cost: sentinel, allowed: false };
	};

	for (let start = 0; start < rows; start++) {
		const touched = touchedIds.length;
		key.fill(Number.POSITIVE_INFINITY, 0, touched);
		visited.fill(0, 0, touched);
		pathRows.length = 0;
		pathReachedAt.length = 0;
		let end: (Untouched & { from: number }) | undefined;
		let endKey = Number.POSITIVE_INFINITY;
		let row = start;
		let from = root;
		let reached = 0;
		// Dijkstra over reduced costs. Every touched driver is matched, so the
		// path goes on through its row and ends only at an untouched driver.
		for (;;) {
			pathRows.push(row);
			pathReachedAt.push(reached);
			const trip = at(trips, row);
			const base = reached - at(rowPotential, row);
			for (let column = 0; column < touched; column++) {
				if (visited[column] === 1) continue;
				const allowed = !trip.excludedDrivers.has(at(touchedIds, column));
				const cost = allowed
					? distanceToCoordinates(
							trip.pickup,
							at(touchedXs, column),
							at(touchedYs, column),
						)
					: sentinel;
				const reduced = base + cost - at(columnPotential, column);
				if (reduced < at(key, column)) {
					key[column] = reduced;
					keyFrom[column] = from;
					keyAllowed[column] = allowed ? 1 : 0;
				}
			}
			const candidate = untouched(row, trip);
			if (base + candidate.cost < endKey) {
				endKey = base + candidate.cost;
				end = { ...candidate, from };
			}

			let best = endKey;
			let bestColumn = root;
			for (let column = 0; column < touched; column++) {
				if (visited[column] === 1 || at(key, column) >= best) continue;
				best = at(key, column);
				bestColumn = column;
			}
			reached = best;
			if (bestColumn === root) break;
			visited[bestColumn] = 1;
			reachedAt[bestColumn] = reached;
			from = bestColumn;
			row = at(rowOfColumn, bestColumn);
		}
		if (end === undefined) throw new Error("path without an end");

		// Keeps reduced costs non-negative, and zero on matched pairs.
		for (const [index, pathRow] of pathRows.entries()) {
			rowPotential[pathRow] =
				at(rowPotential, pathRow) + reached - at(pathReachedAt, index);
		}
		for (let column = 0; column < touched; column++) {
			if (visited[column] === 0) continue;
			columnPotential[column] =
				at(columnPotential, column) - (reached - at(reachedAt, column));
		}

		// Touch the path's last driver, then shift each pair along the path.
		let column = touched;
		touchedIds.push(end.driverId);
		columnOf.set(end.driverId, column);
		touchedXs[column] = end.cell.x;
		touchedYs[column] = end.cell.y;
		columnPotential[column] = 0;
		let previous = end.from;
		let allowed = end.allowed;
		for (;;) {
			const pathRow = previous === root ? start : at(rowOfColumn, previous);
			rowOfColumn[column] = pathRow;
			allowedOfColumn[column] = allowed ? 1 : 0;
			columnOfRow[pathRow] = column;
			if (previous === root) break;
			column = previous;
			previous = at(keyFrom, column);
			allowed = keyAllowed[column] === 1;
		}
	}

	const pairs: TripPair[] = [];
	for (let row = 0; row < rows; row++) {
		const column = at(columnOfRow, row);
		if (column === unmatched || allowedOfColumn[column] === 0) continue;
		pairs.push({ row, driverId: at(touchedIds, column) });
	}
	return pairs;
}

type Untouched = {
	driverId: DriverId;
	cell: Cell;
	cost: number;
	allowed: boolean;
};

const root = -1;
const unmatched = -1;
