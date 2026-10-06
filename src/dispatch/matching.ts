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

function at(values: readonly number[], index: number): number {
	const value = values[index];
	if (value === undefined) throw new Error(`index ${index} out of range`);
	return value;
}
