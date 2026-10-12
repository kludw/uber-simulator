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
	});
}

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
