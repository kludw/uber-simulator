export type Cost = number | null;

export interface Pair {
	row: number;
	column: number;
}

/**
 * Batch assignment (ADR 0030). `cost(row, column)` for `0 <= row < rows`,
 * `0 <= column < columns` is a non-negative integer or `null` (pair not allowed);
 * it is asked for each cell many times, so it must be pure and cheap. Costs are
 * never stored: memory is O(rows + columns), not O(rows x columns) (#213).
 * Returns pairs ordered by row: as many allowed pairs as possible, least total
 * cost among those. Pure function of the input; which of several optimal
 * matchings comes back is not specified. Throws on a cost that is not a
 * non-negative integer (caller bug).
 */
export function minCostMatching(
	rows: number,
	columns: number,
	cost: (row: number, column: number) => Cost,
): Pair[] {
	// Hungarian below needs rows <= columns: solve the transpose otherwise, swap back.
	const transposed = rows > columns;
	const pairs = transposed
		? solve(columns, rows, (row, column) => cost(column, row)).map(
				({ row, column }) => ({ row: column, column: row }),
			)
		: solve(rows, columns, cost);
	return pairs.sort((a, b) => a.row - b.row);
}

// Rectangular Hungarian with potentials (shortest augmenting paths), rows <= columns,
// O(rows^2 x columns); 1-indexed, index 0 is a virtual column used as the root of each
// augmenting path. Every row ends matched; rows matched on a disallowed cell are dropped.
function solve(
	rows: number,
	columns: number,
	cost: (row: number, column: number) => Cost,
): Pair[] {
	// Disallowed cells cost more than any whole set of allowed pairs, so the optimum
	// uses as many allowed pairs as possible. Finite: Infinity breaks the potentials.
	let sentinel = 1;
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			const cell = cost(row, column);
			if (cell === null) continue;
			if (!(Number.isInteger(cell) && cell >= 0)) {
				throw new Error(`cost ${cell} is not a non-negative integer`);
			}
			sentinel += cell;
		}
	}

	const rowPotential = new Array<number>(rows + 1).fill(0);
	const columnPotential = new Array<number>(columns + 1).fill(0);
	const rowOfColumn = new Array<number>(columns + 1).fill(0);
	const previousColumn = new Array<number>(columns + 1).fill(0);
	// Reset per row, allocated once: a fresh pair per row was rows x columns of garbage.
	const slack = new Array<number>(columns + 1);
	const visited = new Array<boolean>(columns + 1);
	for (let row = 1; row <= rows; row++) {
		rowOfColumn[0] = row;
		let column = 0;
		slack.fill(Number.POSITIVE_INFINITY);
		visited.fill(false);
		do {
			visited[column] = true;
			const currentRow = at(rowOfColumn, column);
			let delta = Number.POSITIVE_INFINITY;
			let nextColumn = 0;
			for (let candidate = 1; candidate <= columns; candidate++) {
				if (visited[candidate]) continue;
				const reduced =
					(cost(currentRow - 1, candidate - 1) ?? sentinel) -
					at(rowPotential, currentRow) -
					at(columnPotential, candidate);
				if (reduced < at(slack, candidate)) {
					slack[candidate] = reduced;
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
		do {
			const previous = at(previousColumn, column);
			rowOfColumn[column] = at(rowOfColumn, previous);
			column = previous;
		} while (column !== 0);
	}

	const pairs: Pair[] = [];
	for (let column = 1; column <= columns; column++) {
		const row = at(rowOfColumn, column) - 1;
		if (row < 0 || cost(row, column - 1) === null) continue;
		pairs.push({ row, column: column - 1 });
	}
	return pairs;
}

function at(values: readonly number[], index: number): number {
	const value = values[index];
	if (value === undefined) throw new Error(`index ${index} out of range`);
	return value;
}
