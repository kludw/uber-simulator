// SPIKE (#335): road distance equals BFS over drivable cells; a road step
// lands on a drivable 4-neighbor exactly one closer.
import { expect, test } from "bun:test";
import { createRandom } from "./random.ts";
import {
	canDrive,
	isRoad,
	roadDistance,
	roadDistanceFrom,
	roadNetworkNamed,
	roadStep,
} from "./roads.ts";

const grid = { width: 500, height: 500 };

function bfs(net: ReturnType<typeof roadNetworkNamed>, sx: number, sy: number) {
	const dist = new Int32Array(grid.width * grid.height).fill(-1);
	const queue = new Int32Array(grid.width * grid.height);
	let head = 0;
	let tail = 0;
	dist[sy * grid.width + sx] = 0;
	queue[tail++] = sy * grid.width + sx;
	while (head < tail) {
		const at = queue[head++] as number;
		const x = at % grid.width;
		const y = (at - x) / grid.width;
		for (const [nx, ny] of [
			[x + 1, y],
			[x - 1, y],
			[x, y + 1],
			[x, y - 1],
		] as [number, number][]) {
			if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
			if (!canDrive(net, nx, ny)) continue;
			const n = ny * grid.width + nx;
			if (dist[n] !== -1) continue;
			dist[n] = (dist[at] as number) + 1;
			queue[tail++] = n;
		}
	}
	return dist;
}

const step = (
	x: number,
	y: number,
	tx: number,
	ty: number,
): [number, number] => {
	const dx = tx - x;
	const dy = ty - y;
	if (Math.abs(dy) > Math.abs(dx)) return [x, y + Math.sign(dy)];
	return [x + Math.sign(dx), y];
};

for (const name of ["river", "canals"]) {
	test(`${name}: road distance and steps match BFS`, () => {
		const net = roadNetworkNamed(name, grid);
		const random = createRandom(7);
		const roadCell = (): [number, number] => {
			for (;;) {
				const x = random.int(0, 499);
				const y = random.int(0, 499);
				if (isRoad(net, x, y)) return [x, y];
			}
		};
		for (let source = 0; source < 6; source++) {
			const [sx, sy] = roadCell();
			const dist = bfs(net, sx, sy);
			for (let i = 0; i < 2000; i++) {
				const [x, y] = roadCell();
				const want = dist[y * grid.width + x];
				expect(roadDistance(net, x, y, sx, sy)).toBe(want as number);
				expect(roadDistance(net, sx, sy, x, y)).toBe(want as number);
				expect(roadDistanceFrom(net, sx, sy, x, y)).toBe(want as number);
				if (want === 0) continue;
				const [nx, ny] = roadStep(net, x, y, sx, sy, step);
				expect(Math.abs(nx - x) + Math.abs(ny - y)).toBe(1);
				expect(canDrive(net, nx, ny)).toBe(true);
				expect(dist[ny * grid.width + nx]).toBe((want as number) - 1);
			}
			// Bridges as either end.
			for (let b = 0; b < net.bridgeX.length; b++) {
				const x = net.bridgeX[b] as number;
				const y = net.bridgeY[b] as number;
				expect(roadDistance(net, x, y, sx, sy)).toBe(
					dist[y * grid.width + x] as number,
				);
			}
		}
	});
}
