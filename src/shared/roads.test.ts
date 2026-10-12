import { describe, expect, test } from "bun:test";
import { type Cell, type Coordinate, cellAt, type Grid } from "./grid.ts";
import { createRandom, type Random } from "./random.ts";
import {
	isDrivable,
	isRoadCell,
	type RoadNetwork,
	type RoadNetworkName,
	roadDistance,
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
	});
}
