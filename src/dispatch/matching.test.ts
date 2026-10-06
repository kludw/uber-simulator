import { describe, expect, test } from "bun:test";
import { createRandom, type Random } from "../shared/random.ts";
import { type Cost, minCostMatching, type Pair } from "./matching.ts";

// The matrix's cells as the cost function minCostMatching asks for.
function matchMatrix(costs: Cost[][]): Pair[] {
	return minCostMatching(
		costs.length,
		costs[0]?.length ?? 0,
		(row, column) => costs[row]?.[column] ?? null,
	);
}

// Size and total cost of the returned matching; throws if it is not a valid matching
// (row or column used twice, or a disallowed pair).
function outcome(costs: Cost[][]): { size: number; cost: number } {
	const pairs = matchMatrix(costs);
	const rows = new Set(pairs.map((pair) => pair.row));
	const columns = new Set(pairs.map((pair) => pair.column));
	if (rows.size !== pairs.length || columns.size !== pairs.length) {
		throw new Error(`row or column used twice: ${JSON.stringify(pairs)}`);
	}
	let cost = 0;
	for (const { row, column } of pairs) {
		const cell = costs[row]?.[column];
		if (cell === null || cell === undefined) {
			throw new Error(`disallowed pair (${row}, ${column})`);
		}
		cost += cell;
	}
	return { size: pairs.length, cost };
}

describe("minCostMatching", () => {
	test("empty matrix gives no pairs", () => {
		expect(matchMatrix([])).toEqual([]);
	});

	test("square matrix: beats greedy by row", () => {
		// Greedy: row 0 takes column 0 (1), row 1 left with column 1 (100) = 101.
		expect(
			outcome([
				[1, 2],
				[2, 100],
			]),
		).toEqual({ size: 2, cost: 4 });
	});

	test("more rows than columns: every column matched, cheapest rows win", () => {
		// Greedy: row 0 takes column 0 (2), row 1 takes column 1 (9) = 11.
		expect(
			outcome([
				[2, 3],
				[3, 9],
				[8, 4],
			]),
		).toEqual({ size: 2, cost: 6 });
	});

	test("more columns than rows: every row matched, cheapest columns win", () => {
		// Greedy: row 0 takes column 0 (1), row 1 takes column 2 (7) = 8.
		expect(
			outcome([
				[1, 2, 6],
				[1, 9, 7],
			]),
		).toEqual({ size: 2, cost: 3 });
	});

	test("all-disallowed row stays unmatched", () => {
		expect(
			outcome([
				[null, null],
				[4, 1],
			]),
		).toEqual({ size: 1, cost: 1 });
	});

	test("all-disallowed column stays unmatched", () => {
		expect(
			outcome([
				[null, 5],
				[null, 2],
			]),
		).toEqual({ size: 1, cost: 2 });
	});

	test("prefers more pairs over lower total cost", () => {
		// One pair (row 0, column 0) costs 1; two pairs cost 10 + 10.
		expect(
			outcome([
				[1, 10],
				[10, null],
			]),
		).toEqual({ size: 2, cost: 20 });
	});

	test("negative cost is a caller bug", () => {
		expect(() => matchMatrix([[1, -2]])).toThrow();
	});

	test("non-integer cost is a caller bug", () => {
		expect(() => matchMatrix([[1, 2.5]])).toThrow();
	});

	test("same input gives the same pairs", () => {
		// Many equally optimal matchings: all costs equal.
		const costs = Array.from({ length: 5 }, () => [3, 3, 3, 3]);
		expect(matchMatrix(costs)).toEqual(matchMatrix(costs));
	});

	test("matches a brute-force oracle on seeded random matrices", () => {
		const random = createRandom(87);
		for (let sample = 0; sample < 500; sample++) {
			const costs = randomCosts(random, random.int(0, 6), random.int(0, 6));
			expect({ costs, ...outcome(costs) }).toEqual({
				costs,
				...bruteForce(costs),
			});
		}
	});

	test("matches a brute-force oracle on very unequal shapes", () => {
		const random = createRandom(113);
		for (let sample = 0; sample < 100; sample++) {
			const small = random.int(1, 3);
			const large = random.int(20, 40);
			const wide = randomCosts(random, small, large);
			const tall = transpose(wide);
			expect({ wide, ...outcome(wide) }).toEqual({
				wide,
				...bruteForce(wide),
			});
			expect({ tall, ...outcome(tall) }).toEqual({
				tall,
				...bruteForce(wide),
			});
		}
	});

	test("50 x 10,000 matrix: every row matched", () => {
		// Was padded to 10,000 x 10,000 (ADR 0033); now about 50^2 x 10,000 steps.
		const random = createRandom(5);
		const costs = randomCosts(random, 50, 10_000);
		expect(matchMatrix(costs)).toHaveLength(50);
	}, 10_000);
});

// About a quarter of cells disallowed.
function randomCosts(random: Random, rows: number, columns: number): Cost[][] {
	return Array.from({ length: rows }, () =>
		Array.from({ length: columns }, () =>
			random.int(0, 3) === 0 ? null : random.int(0, 20),
		),
	);
}

function transpose(costs: Cost[][]): Cost[][] {
	const columns = costs[0]?.length ?? 0;
	return Array.from({ length: columns }, (_, column) =>
		costs.map((row) => row[column] ?? null),
	);
}

// Every way to give each row a distinct allowed column or none:
// most pairs first, then least total cost.
function bruteForce(costs: Cost[][]): { size: number; cost: number } {
	let best = { size: 0, cost: 0 };
	const visit = (
		row: number,
		used: Set<number>,
		size: number,
		cost: number,
	) => {
		if (row === costs.length) {
			if (size > best.size || (size === best.size && cost < best.cost)) {
				best = { size, cost };
			}
			return;
		}
		visit(row + 1, used, size, cost);
		for (const [column, cell] of (costs[row] ?? []).entries()) {
			if (cell === null || used.has(column)) continue;
			used.add(column);
			visit(row + 1, used, size + 1, cost + cell);
			used.delete(column);
		}
	};
	visit(0, new Set(), 0, 0);
	return best;
}
