import { describe, expect, test } from "bun:test";
import { type Cell, cellIn, type Grid } from "../shared/grid.ts";
import { DriverId, Tick } from "../shared/messages.ts";
import { createRandom, type Random } from "../shared/random.ts";
import { decideDriverShard, startDriverShard } from "./brain.ts";

const grid: Grid = { width: 10, height: 10 };
const d1 = DriverId.parse("d-1");
const d2 = DriverId.parse("d-2");

function cell(x: number, y: number): Cell {
	const result = cellIn(grid, x, y);
	if (!result.ok) throw new Error(`test cell (${x}, ${y}) outside grid`);
	return result.value;
}

function tick(n: number): Tick {
	return Tick.parse(n);
}

// Scripted randomness: randomCell draws x then y, so values come in (x, y) pairs.
function scriptedRandom(draws: number[]): Random {
	const queue = [...draws];
	return {
		int: () => {
			const next = queue.shift();
			if (next === undefined) throw new Error("unexpected random draw");
			return next;
		},
		float: () => {
			throw new Error("unexpected float draw");
		},
		child: () => {
			throw new Error("unexpected child stream");
		},
	};
}

describe("startDriverShard", () => {
	test("places each driver at a random cell and announces it online, in driver ID order", () => {
		const { outputs } = startDriverShard(
			{ grid, driverIds: [d2, d1] },
			scriptedRandom([3, 4, 7, 8]),
		);
		expect(outputs).toEqual([
			{ type: "driver.went_online", driverId: d1, cell: cell(3, 4) },
			{ type: "driver.went_online", driverId: d2, cell: cell(7, 8) },
		]);
	});
});

describe("decideDriverShard on tick", () => {
	test("idle driver without a wander target picks one and moves one step toward it", () => {
		const random = scriptedRandom([0, 0, 3, 1]);
		const { state } = startDriverShard({ grid, driverIds: [d1] }, random);
		const { outputs } = decideDriverShard(
			state,
			{ type: "tick", tick: tick(1) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(1), driverId: d1, cell: cell(1, 0) },
		]);
	});

	test("each idle driver moves, in driver ID order", () => {
		const random = scriptedRandom([0, 0, 9, 9, 3, 0, 9, 5]);
		const { state } = startDriverShard({ grid, driverIds: [d2, d1] }, random);
		const { outputs } = decideDriverShard(
			state,
			{ type: "tick", tick: tick(1) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(1), driverId: d1, cell: cell(1, 0) },
			{ type: "driver.moved", tick: tick(1), driverId: d2, cell: cell(9, 8) },
		]);
	});

	test("driver keeps its wander target until it reaches it", () => {
		const random = scriptedRandom([0, 0, 3, 0]);
		const started = startDriverShard({ grid, driverIds: [d1] }, random);
		const first = decideDriverShard(
			started.state,
			{ type: "tick", tick: tick(1) },
			random,
		);
		const { outputs } = decideDriverShard(
			first.state,
			{ type: "tick", tick: tick(2) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(2), driverId: d1, cell: cell(2, 0) },
		]);
	});

	test("driver whose new wander target is its own cell does not move", () => {
		const random = scriptedRandom([2, 2, 2, 2]);
		const { state } = startDriverShard({ grid, driverIds: [d1] }, random);
		const { outputs } = decideDriverShard(
			state,
			{ type: "tick", tick: tick(1) },
			random,
		);
		expect(outputs).toEqual([]);
	});

	test("driver that reached its wander target picks a new one on the next tick", () => {
		const random = scriptedRandom([0, 0, 1, 0, 1, 2]);
		const started = startDriverShard({ grid, driverIds: [d1] }, random);
		const arrived = decideDriverShard(
			started.state,
			{ type: "tick", tick: tick(1) },
			random,
		);
		const { outputs } = decideDriverShard(
			arrived.state,
			{ type: "tick", tick: tick(2) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(2), driverId: d1, cell: cell(1, 1) },
		]);
	});
});

describe("driver shard determinism", () => {
	function run(seed: number) {
		const random = createRandom(seed);
		const started = startDriverShard({ grid, driverIds: [d1, d2] }, random);
		const outputs: unknown[] = [...started.outputs];
		let state = started.state;
		for (let n = 1; n <= 30; n++) {
			const decided = decideDriverShard(
				state,
				{ type: "tick", tick: tick(n) },
				random,
			);
			state = decided.state;
			outputs.push(...decided.outputs);
		}
		return outputs;
	}

	test("same seed and inputs give identical outputs", () => {
		expect(run(42)).toEqual(run(42));
	});
});
