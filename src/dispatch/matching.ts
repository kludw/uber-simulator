export type Cost = number | null;

export interface Pair {
	row: number;
	column: number;
}

/**
 * Batch assignment (ADR 0030). `costs` is rows x columns (rectangular), each cell a
 * non-negative integer or `null` (pair not allowed). Returns pairs ordered by row:
 * as many allowed pairs as possible, least total cost among those. Pure function of
 * the input; which of several optimal matchings comes back is not specified.
 * Throws on ragged rows or a cost that is not a non-negative integer (caller bug).
 */
export function minCostMatching(costs: readonly (readonly Cost[])[]): Pair[] {
	const rows = costs.length;
	const columns = costs[0]?.length ?? 0;
	for (const row of costs) {
		if (row.length !== columns) throw new Error("costs rows differ in length");
		for (const cell of row) {
			if (cell !== null && !(Number.isInteger(cell) && cell >= 0)) {
				throw new Error(`cost ${cell} is not a non-negative integer`);
			}
		}
	}
	const size = Math.max(rows, columns);
	// Disallowed and padding cells cost more than any whole set of real pairs, so the optimum
	// uses as many real pairs as possible. Finite: Infinity breaks the potentials.
	const sentinel = costs.flat().reduce<number>((sum, c) => sum + (c ?? 0), 1);
	const cost = (row: number, column: number) =>
		costs[row]?.[column] ?? sentinel;

	// Hungarian algorithm with potentials (shortest augmenting paths), 1-indexed;
	// index 0 is a virtual column used as the root of each augmenting path.
	const rowPotential = new Array<number>(size + 1).fill(0);
	const columnPotential = new Array<number>(size + 1).fill(0);
	const rowOfColumn = new Array<number>(size + 1).fill(0);
	const previousColumn = new Array<number>(size + 1).fill(0);
	for (let row = 1; row <= size; row++) {
		rowOfColumn[0] = row;
		let column = 0;
		const slack = new Array<number>(size + 1).fill(Number.POSITIVE_INFINITY);
		const visited = new Array<boolean>(size + 1).fill(false);
		do {
			visited[column] = true;
			const currentRow = at(rowOfColumn, column);
			let delta = Number.POSITIVE_INFINITY;
			let nextColumn = 0;
			for (let candidate = 1; candidate <= size; candidate++) {
				if (visited[candidate]) continue;
				const reduced =
					cost(currentRow - 1, candidate - 1) -
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
			for (let candidate = 0; candidate <= size; candidate++) {
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
	for (let column = 1; column <= size; column++) {
		const row = at(rowOfColumn, column) - 1;
		if (costs[row]?.[column - 1] == null) continue;
		pairs.push({ row, column: column - 1 });
	}
	return pairs.toSorted((a, b) => a.row - b.row);
}

function at(values: readonly number[], index: number): number {
	const value = values[index];
	if (value === undefined) throw new Error(`index ${index} out of range`);
	return value;
}
