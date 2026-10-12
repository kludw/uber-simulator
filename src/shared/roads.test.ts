import { describe, expect, test } from "bun:test";
import { type Cell, type Coordinate, cellAt, type Grid } from "./grid.ts";
import { createRandom, type Random } from "./random.ts";
import {
	exitCostsToward,
	isDrivable,
	isRoadCell,
	type RoadNetwork,
	type RoadNetworkName,
	roadBoundToBox,
	roadDistance,
	roadDistanceTo,
	roadNetworkNamed,
	roadStep,
	waypointsFor,
} from "./roads.ts";

const grid: Grid = { width: 500, height: 500 };

function cell(x: number, y: number): Cell {
	return cellAt(x as Coordinate, y as Coordinate);
}

function randomRoadCell(network: RoadNetwork, random: Random): Cell {
	for (;;) {
		const x = random.int(0, grid.width - 1);
		const y = random.int(0, grid.height - 1);
		if (isRoadCell(network, x, y)) return cell(x, y);
	}
}

// The independent source of road distance: breadth-first search over
// drivable cells, 4-neighbor moves. Row-major, -1 where unreachable.
function bfsFrom(network: RoadNetwork, source: Cell): Int32Array {
	const { width, height } = grid;
	const distances = new Int32Array(width * height).fill(-1);
	const queue = new Int32Array(width * height);
	let head = 0;
	let tail = 0;
	distances[source.y * width + source.x] = 0;
	queue[tail++] = source.y * width + source.x;
	while (head < tail) {
		const at = queue[head++] as number;
		const x = at % width;
		const y = (at - x) / width;
		const neighbors = [
			[x + 1, y],
			[x - 1, y],
			[x, y + 1],
			[x, y - 1],
		];
		for (const [nx = -1, ny = -1] of neighbors) {
			if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
			if (!isDrivable(network, nx, ny)) continue;
			const next = ny * width + nx;
			if (distances[next] !== -1) continue;
			distances[next] = (distances[at] as number) + 1;
			queue[tail++] = next;
		}
	}
	return distances;
}

// Every network's searches compare against a few BFS sources: road cells
// drawn from a fixed seed, and the first bridge.
function sourcesOf(network: RoadNetwork): Cell[] {
	const random = createRandom(7);
	const roadCells = Array.from({ length: 4 }, () =>
		randomRoadCell(network, random),
	);
	return [...roadCells, network.bridges[0] as Cell];
}

function targetsOf(network: RoadNetwork, random: Random): Cell[] {
	const roadCells = Array.from({ length: 300 }, () =>
		randomRoadCell(network, random),
	);
	return [...roadCells, ...network.bridges];
}

describe("presets", () => {
	test("river is one horizontal river at row 263 with 4 bridges", () => {
		const network = roadNetworkNamed("river", grid);
		expect({
			rows: network.riverRows,
			columns: network.riverColumns,
			bridges: network.bridges.length,
		}).toEqual({ rows: [263], columns: [], bridges: 4 });
	});

	test("canals is 3 + 3 rivers near the quarter lines with 48 bridges", () => {
		const network = roadNetworkNamed("canals", grid);
		expect({
			rows: network.riverRows,
			columns: network.riverColumns,
			bridges: network.bridges.length,
		}).toEqual({
			rows: [138, 248, 361],
			columns: [105, 264, 367],
			bridges: 48,
		});
	});
});

const names: RoadNetworkName[] = ["river", "canals"];

for (const name of names) {
	describe(`${name} network`, () => {
		const network = roadNetworkNamed(name, grid);

		test("is the same every time it is built, whatever the run", () => {
			expect(roadNetworkNamed(name, grid)).toEqual(network);
		});

		test("bridges are at least 2 cells apart", () => {
			const closest = Math.min(
				...network.bridges.flatMap((a, i) =>
					network.bridges
						.slice(i + 1)
						.map((b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)),
				),
			);
			expect(closest).toBeGreaterThanOrEqual(2);
		});

		test("bridges are clear of other rivers: both landings are road cells", () => {
			const offRoad = network.bridges.filter((bridge) => {
				const acrossRow = network.riverRows.includes(bridge.y);
				const ends = acrossRow
					? [
							[bridge.x, bridge.y - 1],
							[bridge.x, bridge.y + 1],
						]
					: [
							[bridge.x - 1, bridge.y],
							[bridge.x + 1, bridge.y],
						];
				return ends.some(([x, y]) => !isRoadCell(network, x ?? -1, y ?? -1));
			});
			expect(offRoad).toEqual([]);
		});

		const sources = sourcesOf(network);
		const bfs = sources.map((source) => bfsFrom(network, source));

		test("road distance is the shortest path over drivable cells, both ways", () => {
			const random = createRandom(11);
			const wrong: string[] = [];
			sources.forEach((source, s) => {
				for (const target of targetsOf(network, random)) {
					const want = bfs[s]?.[target.y * grid.width + target.x];
					const there = roadDistance(network, source, target);
					const back = roadDistance(network, target, source);
					if (there !== want || back !== want) {
						wrong.push(
							`(${source.x}, ${source.y}) (${target.x}, ${target.y}): ${there} / ${back}, BFS ${want}`,
						);
					}
				}
			});
			expect(wrong).toEqual([]);
		});

		test("road distance through a cell's exit costs is the shortest path", () => {
			const random = createRandom(13);
			const wrong: string[] = [];
			sources.forEach((source, s) => {
				const toward = exitCostsToward(network, source);
				for (const target of targetsOf(network, random)) {
					const want = bfs[s]?.[target.y * grid.width + target.x];
					const got = roadDistanceTo(network, toward, target.x, target.y);
					if (got !== want) {
						wrong.push(
							`(${target.x}, ${target.y}) to (${source.x}, ${source.y}): ${got}, BFS ${want}`,
						);
					}
				}
			});
			expect(wrong).toEqual([]);
		});

		test("the bucket bound never exceeds the least road distance into the bucket", () => {
			const random = createRandom(17);
			const wrong: string[] = [];
			sources.forEach((source, s) => {
				const toward = exitCostsToward(network, source);
				for (const box of bucketsOf(network, random)) {
					const least = leastIn(bfs[s] as Int32Array, box);
					const bound = roadBoundToBox(network, toward, ...box);
					if (bound > least) {
						wrong.push(
							`[${box}] from (${source.x}, ${source.y}): ${bound} > ${least}`,
						);
					}
				}
			});
			expect(wrong).toEqual([]);
		});

		test("the bucket bound of one drivable cell is its road distance", () => {
			const random = createRandom(19);
			const wrong: string[] = [];
			sources.forEach((source, s) => {
				const toward = exitCostsToward(network, source);
				for (const target of targetsOf(network, random)) {
					const want = bfs[s]?.[target.y * grid.width + target.x];
					const { x, y } = target;
					const bound = roadBoundToBox(network, toward, x, y, x, y);
					if (bound !== want) {
						wrong.push(
							`(${x}, ${y}) from (${source.x}, ${source.y}): ${bound}, BFS ${want}`,
						);
					}
				}
			});
			expect(wrong).toEqual([]);
		});

		// Targets are road cells; drivers start anywhere drivable.
		const roadTargets = sources.flatMap((target, s) =>
			isRoadCell(network, target.x, target.y)
				? [{ target, distances: bfs[s] as Int32Array }]
				: [],
		);

		test("a step lands on a drivable 4-neighbor one closer to the target", () => {
			const random = createRandom(23);
			const wrong: string[] = [];
			for (const { target, distances } of roadTargets) {
				for (const from of targetsOf(network, random)) {
					const want = distances[from.y * grid.width + from.x] as number;
					if (want === 0) continue;
					const next = roadStep(network, waypointsFor(1), 0, from, target);
					const moved = Math.abs(next.x - from.x) + Math.abs(next.y - from.y);
					const closer = distances[next.y * grid.width + next.x];
					if (
						moved !== 1 ||
						!isDrivable(network, next.x, next.y) ||
						closer !== want - 1
					) {
						wrong.push(
							`(${from.x}, ${from.y}) toward (${target.x}, ${target.y}): (${next.x}, ${next.y})`,
						);
					}
				}
			}
			expect(wrong).toEqual([]);
		});

		test("a driver keeping its waypoint arrives in exactly the road distance", () => {
			const random = createRandom(29);
			const waypoints = waypointsFor(1);
			const wrong: string[] = [];
			for (const { target, distances } of roadTargets) {
				for (const start of targetsOf(network, random)) {
					const want = distances[start.y * grid.width + start.x] as number;
					let at = start;
					let moves = 0;
					while ((at.x !== target.x || at.y !== target.y) && moves <= want) {
						at = roadStep(network, waypoints, 0, at, target);
						moves++;
						if (!isDrivable(network, at.x, at.y)) break;
					}
					if (moves !== want || at.x !== target.x || at.y !== target.y) {
						wrong.push(
							`(${start.x}, ${start.y}) toward (${target.x}, ${target.y}): at (${at.x}, ${at.y}) after ${moves}, road distance ${want}`,
						);
					}
				}
			}
			expect(wrong).toEqual([]);
		});

		for (const change of [
			"in the old target's district",
			"across a river from the old target",
		]) {
			test(`a driver whose target changes mid-route ${change} arrives in exactly the new road distance`, () => {
				const random = createRandom(37);
				const waypoints = waypointsFor(1);
				const wrong: string[] = [];
				for (let i = 0; i < 25; i++) {
					const start = randomRoadCell(network, random);
					let oldTarget = randomRoadCell(network, random);
					while (sameDistrict(network, start, oldTarget)) {
						oldTarget = randomRoadCell(network, random);
					}
					let newTarget = randomRoadCell(network, random);
					while (
						sameDistrict(network, oldTarget, newTarget) !==
							(change === "in the old target's district") ||
						(newTarget.x === oldTarget.x && newTarget.y === oldTarget.y)
					) {
						newTarget = randomRoadCell(network, random);
					}
					let at = start;
					const before = random.int(
						1,
						Math.max(
							1,
							Math.floor(roadDistance(network, start, oldTarget) / 2),
						),
					);
					for (let m = 0; m < before; m++) {
						at = roadStep(network, waypoints, 0, at, oldTarget);
					}
					const changedAt = at;
					const want = bfsFrom(network, newTarget)[
						changedAt.y * grid.width + changedAt.x
					] as number;
					let moves = 0;
					while (
						(at.x !== newTarget.x || at.y !== newTarget.y) &&
						moves <= want
					) {
						at = roadStep(network, waypoints, 0, at, newTarget);
						moves++;
					}
					if (moves !== want || at.x !== newTarget.x || at.y !== newTarget.y) {
						wrong.push(
							`(${changedAt.x}, ${changedAt.y}) toward (${newTarget.x}, ${newTarget.y}) after (${oldTarget.x}, ${oldTarget.y}): ${moves} moves, road distance ${want}`,
						);
					}
				}
				expect(wrong).toEqual([]);
			});
		}
	});
}

// No river row or column between the two cells.
function sameDistrict(network: RoadNetwork, a: Cell, b: Cell): boolean {
	const between = (river: number, p: number, q: number) =>
		river > Math.min(p, q) && river < Math.max(p, q);
	return (
		!network.riverRows.some((row) => between(row, a.y, b.y)) &&
		!network.riverColumns.some((column) => between(column, a.x, b.x))
	);
}

test("both presets in one process share no state: each answers by its own network", () => {
	const river = roadNetworkNamed("river", grid);
	const canals = roadNetworkNamed("canals", grid);
	// A road cell of both, asked of both in turn.
	const random = createRandom(31);
	let target = randomRoadCell(river, random);
	while (!isRoadCell(canals, target.x, target.y)) {
		target = randomRoadCell(river, random);
	}
	const networks = [river, canals].map((network) => ({
		network,
		distances: bfsFrom(network, target),
		toward: exitCostsToward(network, target),
		waypoints: waypointsFor(1),
	}));
	const wrong: string[] = [];
	for (let i = 0; i < 100; i++) {
		const starts = networks.map(({ network }) =>
			randomRoadCell(network, random),
		);
		const at = [...starts];
		const moves = [0, 0];
		networks.forEach(({ network, distances, toward }, n) => {
			const start = starts[n] as Cell;
			const want = distances[start.y * grid.width + start.x];
			const got = roadDistanceTo(network, toward, start.x, start.y);
			if (got !== want) {
				wrong.push(`${network.name} distance ${got}, BFS ${want}`);
			}
		});
		// The two drivers step in turn, same driver index, until both arrive.
		const arrived = (n: number) =>
			at[n]?.x === target.x && at[n]?.y === target.y;
		while (!(arrived(0) && arrived(1)) && moves.every((m) => m < 2000)) {
			networks.forEach(({ network, waypoints }, n) => {
				if (arrived(n)) return;
				at[n] = roadStep(network, waypoints, 0, at[n] as Cell, target);
				moves[n] = (moves[n] as number) + 1;
			});
		}
		networks.forEach(({ network, distances }, n) => {
			const start = starts[n] as Cell;
			const want = distances[start.y * grid.width + start.x];
			if (!arrived(n) || moves[n] !== want) {
				wrong.push(
					`${network.name} from (${start.x}, ${start.y}): ${moves[n]} moves, BFS ${want}`,
				);
			}
		});
	}
	expect(wrong).toEqual([]);
});

test("a step for a driver index outside its waypoints is a caller's bug", () => {
	const river = roadNetworkNamed("river", grid);
	expect(() =>
		roadStep(river, waypointsFor(1), 1, cell(10, 10), cell(10, 400)),
	).toThrow();
});

type Box = [x0: number, y0: number, x1: number, y1: number];

// Search buckets of 1 to 60 cells a side anywhere, and around bridges so
// many straddle a river.
function bucketsOf(network: RoadNetwork, random: Random): Box[] {
	const boxAt = (x: number, y: number): Box => {
		const x0 = Math.max(0, x);
		const y0 = Math.max(0, y);
		return [
			x0,
			y0,
			Math.min(grid.width - 1, x0 + random.int(0, 59)),
			Math.min(grid.height - 1, y0 + random.int(0, 59)),
		];
	};
	const anywhere = Array.from({ length: 200 }, () =>
		boxAt(random.int(0, grid.width - 1), random.int(0, grid.height - 1)),
	);
	const aroundBridges = network.bridges.map((bridge) =>
		boxAt(bridge.x - random.int(0, 30), bridge.y - random.int(0, 30)),
	);
	return [...anywhere, ...aroundBridges];
}

// Least BFS distance to a drivable cell of the box; Infinity when none is.
function leastIn(distances: Int32Array, [x0, y0, x1, y1]: Box): number {
	let least = Number.POSITIVE_INFINITY;
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			const distance = distances[y * grid.width + x] as number;
			if (distance >= 0 && distance < least) least = distance;
		}
	}
	return least;
}
