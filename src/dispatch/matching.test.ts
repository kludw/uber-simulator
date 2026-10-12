import { describe, expect, test } from "bun:test";
import { type Cell, cellIn, type Grid, specGrid } from "../shared/grid.ts";
import { DriverId } from "../shared/messages.ts";
import { createRandom, type Random } from "../shared/random.ts";
import {
	distanceOn,
	isDrivable,
	isRoadCell,
	type RoadNetwork,
	roadNetworkNamed,
} from "../shared/roads.ts";
import {
	type MatchTrip,
	minCostMatching,
	minCostMatchingByNearest,
	type Pair,
} from "./matching.ts";

// A cell of a test matrix; null = pair not allowed.
type Cost = number | null;

// The matrix's rows and columns as minCostMatching asks for them.
function matchMatrix(costs: Cost[][]): Pair[] {
	const columns = costs[0]?.length ?? 0;
	const allowed = (cost: Cost | undefined) => cost ?? Number.POSITIVE_INFINITY;
	return minCostMatching(costs.length, columns, {
		ofRow: (row, out) => {
			for (let column = 0; column < columns; column++) {
				out[column] = allowed(costs[row]?.[column]);
			}
		},
		ofColumn: (column, out) => {
			for (const [row, cells] of costs.entries()) {
				out[row] = allowed(cells[column]);
			}
		},
	});
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

	test("a row filler that skips a cell is a caller bug", () => {
		// Writes column 1 only; column 0 must not keep row 0's cost.
		const ofRow = (row: number, out: number[]) => {
			if (row === 0) out[0] = 1;
			out[1] = 2;
		};
		expect(() => minCostMatching(2, 2, { ofRow, ofColumn: ofRow })).toThrow();
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

	// ADR 0057, heavy batched: with more trips than drivers and no exclusions,
	// every driver is matched, so its penalty is in every optimal total alike.
	// Which of several optimal matchings comes back may differ: count and
	// total pickup distance only.
	test("with every driver matched, rating penalties leave the pair count and total pickup distance unchanged", () => {
		const random = createRandom(366);
		for (let sample = 0; sample < 300; sample++) {
			const columns = random.int(1, 8);
			const rows = columns + random.int(1, 6);
			const distances = Array.from({ length: rows }, () =>
				Array.from({ length: columns }, () => random.int(0, 30)),
			);
			const penalties = Array.from({ length: columns }, () =>
				random.int(0, 40),
			);
			const rated = distances.map((row) =>
				row.map((cost, column) => cost + (penalties[column] ?? 0)),
			);
			const pickupDistance = (pairs: Pair[]) =>
				pairs.reduce(
					(total, { row, column }) =>
						total + (distances[row]?.[column] ?? Number.NaN),
					0,
				);
			const unratedPairs = matchMatrix(distances);
			const ratedPairs = matchMatrix(rated);

			expect({
				sample,
				pairs: ratedPairs.length,
				pickupDistance: pickupDistance(ratedPairs),
			}).toEqual({
				sample,
				pairs: unratedPairs.length,
				pickupDistance: pickupDistance(unratedPairs),
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

const grid: Grid = { width: 10, height: 10 };

function cell(x: number, y: number): Cell {
	const result = cellIn(grid, x, y);
	if (!result.ok) throw new Error(`test cell (${x}, ${y}) outside grid`);
	return result.value;
}

type TestDriver = { driverId: DriverId; cell: Cell; ratingPenalty: number };

function driver(
	id: string,
	x: number,
	y: number,
	ratingPenalty = 0,
): TestDriver {
	return { driverId: DriverId.parse(id), cell: cell(x, y), ratingPenalty };
}

function trip(x: number, y: number, ...excluded: string[]): MatchTrip {
	return {
		pickup: cell(x, y),
		excludedDrivers: new Set(excluded.map((id) => DriverId.parse(id))),
	};
}

// Pickup distance (by road with a network, ADR 0059) + rating penalty (ADR
// 0057).
function matchCost(
	pickup: Cell,
	candidate: TestDriver,
	roads: RoadNetwork | null = null,
): number {
	return distanceOn(roads, candidate.cell, pickup) + candidate.ratingPenalty;
}

// The index's query as a linear scan: least match cost not skipped, ties to
// the lowest ID. maxRatingPenalty: the most any driver's penalty can be.
// roads: the network distances are measured on (ADR 0059), null = Manhattan.
function matchByNearest(
	trips: readonly MatchTrip[],
	drivers: readonly TestDriver[],
	onGrid: Grid = grid,
	maxRatingPenalty = 0,
	roads: RoadNetwork | null = null,
) {
	return minCostMatchingByNearest(
		trips,
		(pickup, skip) => {
			let best: TestDriver | undefined;
			for (const candidate of drivers) {
				if (skip(candidate.driverId)) continue;
				const cost = matchCost(pickup, candidate, roads);
				if (
					best === undefined ||
					cost < matchCost(pickup, best, roads) ||
					(cost === matchCost(pickup, best, roads) &&
						candidate.driverId < best.driverId)
				) {
					best = candidate;
				}
			}
			return best;
		},
		onGrid,
		maxRatingPenalty,
		roads,
	);
}

describe("minCostMatchingByNearest", () => {
	test("no trips gives no pairs", () => {
		expect(matchByNearest([], [driver("d-1", 0, 0)])).toEqual([]);
	});

	test("one trip takes its nearest driver", () => {
		expect(
			matchByNearest(
				[trip(5, 5)],
				[driver("d-1", 0, 0), driver("d-2", 6, 6), driver("d-3", 9, 9)],
			),
		).toEqual([{ row: 0, driverId: DriverId.parse("d-2") }]);
	});

	test("beats greedy by trip: least total pickup distance", () => {
		// d-1 is nearest both pickups. Greedy gives it to row 0 and sends d-2
		// four cells to row 1: 1 + 4 = 5. Swapped: 2 + 1 = 3.
		expect(
			matchByNearest(
				[trip(2, 0), trip(0, 0)],
				[driver("d-1", 1, 0), driver("d-2", 4, 0)],
			),
		).toEqual([
			{ row: 0, driverId: DriverId.parse("d-2") },
			{ row: 1, driverId: DriverId.parse("d-1") },
		]);
	});

	test("never pairs a trip with a driver excluded for it", () => {
		expect(
			matchByNearest(
				[trip(5, 5, "d-2")],
				[driver("d-1", 0, 0), driver("d-2", 6, 6), driver("d-3", 9, 9)],
			),
		).toEqual([{ row: 0, driverId: DriverId.parse("d-3") }]);
	});

	test("a trip with every driver excluded stays unpaired and takes no driver from another", () => {
		// Row 0 first holds d-1 at the sentinel cost; row 1 then takes d-1.
		expect(
			matchByNearest(
				[trip(0, 0, "d-1", "d-2"), trip(1, 0)],
				[driver("d-1", 0, 0), driver("d-2", 9, 9)],
			),
		).toEqual([{ row: 1, driverId: DriverId.parse("d-1") }]);
	});

	test("prefers more pairs over less total pickup distance", () => {
		// Row 0 alone would take d-1 (0); row 1 may only take d-1, so row 0
		// goes 18 cells to d-2.
		expect(
			matchByNearest(
				[trip(0, 0), trip(0, 1, "d-2")],
				[driver("d-1", 0, 0), driver("d-2", 9, 9)],
			),
		).toEqual([
			{ row: 0, driverId: DriverId.parse("d-2") },
			{ row: 1, driverId: DriverId.parse("d-1") },
		]);
	});

	test("more trips than idle drivers is a caller bug", () => {
		expect(() =>
			matchByNearest([trip(0, 0), trip(1, 1)], [driver("d-1", 0, 0)]),
		).toThrow();
	});

	test("same pair count and total pickup distance as the dense solver on seeded random batches", () => {
		const random = createRandom(241);
		for (let sample = 0; sample < 1000; sample++) {
			const batch = randomBatch(random);
			expect({ sample, ...nearestOutcome(batch) }).toEqual({
				sample,
				...denseOutcome(batch),
			});
		}
	});

	test("a trip takes a better-rated driver while its match cost is lower", () => {
		// d-1: 1 + 10 = 11; d-2: 9 + 0 = 9.
		expect(
			matchByNearest(
				[trip(5, 5)],
				[driver("d-1", 5, 6, 10), driver("d-2", 9, 0)],
				grid,
				maxRatingPenalty,
			),
		).toEqual([{ row: 0, driverId: DriverId.parse("d-2") }]);
	});

	test("same pair count and total match cost as the dense solver on seeded random batches with rating penalties", () => {
		const random = createRandom(332);
		for (let sample = 0; sample < 1000; sample++) {
			const batch = randomBatch(random, true);
			expect({ sample, ...nearestOutcome(batch) }).toEqual({
				sample,
				...denseOutcome(batch),
			});
		}
	});
});

// ADR 0059: with roads on, pickup distance is road distance, and the solver
// stays exact.
describe.each(["river", "canals"] as const)(
	"minCostMatchingByNearest on %s roads",
	(name) => {
		const roads = roadNetworkNamed(name, specGrid);

		test.each([
			["", false],
			[" with rating penalties", true],
		])(
			"same pair count and total match cost by road distance as the dense solver on seeded random batches%s",
			(_, rated) => {
				const random = createRandom(rated ? 3362 : 3361);
				for (let sample = 0; sample < 500; sample++) {
					const batch = randomRoadBatch(random, roads, rated);
					expect({ sample, ...nearestOutcome(batch) }).toEqual({
						sample,
						...denseOutcome(batch),
					});
				}
			},
		);
	},
);

// ADR 0057: 10 cells per star below 5, at most 4 stars.
const maxRatingPenalty = 40;

type Batch = {
	grid: Grid;
	trips: MatchTrip[];
	drivers: TestDriver[];
	rated: boolean;
	roads: RoadNetwork | null;
};

// Up to 12 trips on small grids, so pickups and drivers share cells and tie
// often; at least as many drivers as trips; each driver excluded for a trip
// with probability 0 to 1/2 (some trips lose every driver). rated: each
// driver unrated or with a rating penalty from 0 to the most there is, so
// penalties outweigh distances often.
function randomBatch(random: Random, rated = false): Batch {
	const batchGrid = { width: random.int(1, 12), height: random.int(1, 12) };
	const at = (): Cell =>
		({
			x: random.int(0, batchGrid.width - 1),
			y: random.int(0, batchGrid.height - 1),
		}) as Cell;
	const tripCount = random.int(0, 12);
	const drivers = Array.from(
		{ length: tripCount + random.int(0, 8) },
		(_, index) => ({
			driverId: DriverId.parse(`d-${index}`),
			cell: at(),
			ratingPenalty:
				rated && random.int(0, 3) > 0 ? random.int(0, maxRatingPenalty) : 0,
		}),
	);
	const excludedOneIn = random.int(0, 2);
	const trips = Array.from({ length: tripCount }, () => ({
		pickup: at(),
		excludedDrivers: new Set(
			drivers
				.filter(
					() => excludedOneIn > 0 && random.int(1, 2 * excludedOneIn) === 1,
				)
				.map(({ driverId }) => driverId),
		),
	}));
	return { grid: batchGrid, trips, drivers, rated, roads: null };
}

// As randomBatch on the spec grid with a road network (ADR 0059): pickups on
// road cells, drivers on drivable ones (bridges too, mid-crossing), most
// within 40 cells of one random bridge so pairs cross its river, the rest
// anywhere.
function randomRoadBatch(
	random: Random,
	roads: RoadNetwork,
	rated: boolean,
): Batch {
	const bridge = roads.bridges[random.int(0, roads.bridges.length - 1)] as Cell;
	const at = (road: boolean): Cell => {
		const near = random.int(0, 4) > 0;
		for (;;) {
			const x = near
				? Math.min(499, Math.max(0, bridge.x + random.int(-40, 40)))
				: random.int(0, 499);
			const y = near
				? Math.min(499, Math.max(0, bridge.y + random.int(-40, 40)))
				: random.int(0, 499);
			if (road ? isRoadCell(roads, x, y) : isDrivable(roads, x, y)) {
				return { x, y } as Cell;
			}
		}
	};
	const tripCount = random.int(0, 12);
	const drivers = Array.from(
		{ length: tripCount + random.int(0, 8) },
		(_, index) => ({
			driverId: DriverId.parse(`d-${index}`),
			cell: at(random.int(0, 9) > 0),
			ratingPenalty:
				rated && random.int(0, 3) > 0 ? random.int(0, maxRatingPenalty) : 0,
		}),
	);
	const excludedOneIn = random.int(0, 2);
	const trips = Array.from({ length: tripCount }, () => ({
		pickup: at(true),
		excludedDrivers: new Set(
			drivers
				.filter(
					() => excludedOneIn > 0 && random.int(1, 2 * excludedOneIn) === 1,
				)
				.map(({ driverId }) => driverId),
		),
	}));
	return { grid: specGrid, trips, drivers, rated, roads };
}

// Throws if not a valid matching (trip or driver used twice, excluded pair).
function nearestOutcome({
	grid: batchGrid,
	trips,
	drivers,
	rated,
	roads,
}: Batch) {
	const pairs = matchByNearest(
		trips,
		drivers,
		batchGrid,
		rated ? maxRatingPenalty : 0,
		roads,
	);
	const driverOf = new Map(drivers.map((each) => [each.driverId, each]));
	if (
		new Set(pairs.map(({ row }) => row)).size !== pairs.length ||
		new Set(pairs.map(({ driverId }) => driverId)).size !== pairs.length
	) {
		throw new Error(`trip or driver used twice: ${JSON.stringify(pairs)}`);
	}
	let totalMatchCost = 0;
	for (const { row, driverId } of pairs) {
		const paired = trips[row];
		const matched = driverOf.get(driverId);
		if (paired === undefined || matched === undefined) {
			throw new Error("no pair");
		}
		if (paired.excludedDrivers.has(driverId)) {
			throw new Error(`excluded pair (${row}, ${driverId})`);
		}
		totalMatchCost += matchCost(paired.pickup, matched, roads);
	}
	return { pairs: pairs.length, totalMatchCost };
}

function denseOutcome({ trips, drivers, roads }: Batch) {
	const costs = trips.map((paired) =>
		drivers.map((candidate) =>
			paired.excludedDrivers.has(candidate.driverId)
				? null
				: matchCost(paired.pickup, candidate, roads),
		),
	);
	const { size, cost } = outcome(costs);
	return { pairs: size, totalMatchCost: cost };
}

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
