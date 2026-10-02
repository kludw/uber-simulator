import { describe, expect, test } from "bun:test";
import { type Cell, cellIn, type Grid } from "../shared/grid.ts";
import { RiderId, Tick, TripId } from "../shared/messages.ts";
import { createRandom, type Random } from "../shared/random.ts";
import { decideRiders, type RidersState, startRiders } from "./brain.ts";

const grid: Grid = { width: 10, height: 10 };

function cell(x: number, y: number): Cell {
	const result = cellIn(grid, x, y);
	if (!result.ok) throw new Error(`test cell (${x}, ${y}) outside grid`);
	return result.value;
}

function tick(n: number): Tick {
	return Tick.parse(n);
}

type Script = { ints?: number[]; floats?: number[] };

// Scripted randomness: one script per child stream label, unknown labels throw.
function scriptedRandom(streams: Record<string, Script>): Random {
	return {
		int: () => {
			throw new Error("unexpected int draw on root stream");
		},
		float: () => {
			throw new Error("unexpected float draw on root stream");
		},
		child: (label) => {
			const script = streams[label];
			if (script === undefined) throw new Error(`unexpected child ${label}`);
			return scriptedStream(label, script);
		},
	};
}

function scriptedStream(label: string, script: Script): Random {
	const ints = [...(script.ints ?? [])];
	const floats = [...(script.floats ?? [])];
	return {
		int: () => {
			const next = ints.shift();
			if (next === undefined)
				throw new Error(`unexpected int draw on ${label}`);
			return next;
		},
		float: () => {
			const next = floats.shift();
			if (next === undefined) {
				throw new Error(`unexpected float draw on ${label}`);
			}
			return next;
		},
		child: () => {
			throw new Error(`unexpected child of ${label}`);
		},
	};
}

describe("decideRiders on tick", () => {
	// Mean 10/60 per tick: Poisson draws 0 when the first uniform is below e^-(1/6) ~ 0.846.
	test("spawns no rider when the demand draw is zero", () => {
		const state = startRiders({ grid, requestsPerMinute: 10 });
		const { outputs } = decideRiders(
			state,
			{ type: "clock.ticked", tick: tick(1) },
			scriptedRandom({ "demand:1": { floats: [0.5] }, "patience:1": {} }),
		);
		expect(outputs).toEqual([]);
	});

	// Uniforms 0.9 then 0.5: product drops below e^-(1/6) on the second draw -> 1 spawn.
	test("spawned rider requests a trip from a random pickup to a random dropoff", () => {
		const state = startRiders({ grid, requestsPerMinute: 10 });
		const { outputs } = decideRiders(
			state,
			{ type: "clock.ticked", tick: tick(1) },
			scriptedRandom({
				"demand:1": { floats: [0.9, 0.5], ints: [2, 3, 7, 8] },
				"patience:1": { ints: [150] },
			}),
		);
		expect(outputs).toEqual([
			{
				type: "request_trip",
				tick: tick(1),
				tripId: TripId.parse("t-1"),
				riderId: RiderId.parse("r-1"),
				pickup: cell(2, 3),
				dropoff: cell(7, 8),
			},
		]);
	});

	test("spawned rider waits with patience drawn from the patience stream", () => {
		const start = startRiders({ grid, requestsPerMinute: 10 });
		const { state } = decideRiders(
			start,
			{ type: "clock.ticked", tick: tick(1) },
			scriptedRandom({
				"demand:1": { floats: [0.9, 0.5], ints: [2, 3, 7, 8] },
				"patience:1": { ints: [150] },
			}),
		);
		expect(state.riders).toEqual([
			{
				state: "waiting",
				id: RiderId.parse("r-1"),
				tripId: TripId.parse("t-1"),
				requestedAt: tick(1),
				patience: 150,
			},
		]);
	});

	test("dropoff drawn on the pickup cell is redrawn", () => {
		const state = startRiders({ grid, requestsPerMinute: 10 });
		const { outputs } = decideRiders(
			state,
			{ type: "clock.ticked", tick: tick(1) },
			scriptedRandom({
				"demand:1": { floats: [0.9, 0.5], ints: [2, 3, 2, 3, 7, 8] },
				"patience:1": { ints: [150] },
			}),
		);
		expect(outputs).toEqual([
			{
				type: "request_trip",
				tick: tick(1),
				tripId: TripId.parse("t-1"),
				riderId: RiderId.parse("r-1"),
				pickup: cell(2, 3),
				dropoff: cell(7, 8),
			},
		]);
	});
});

function runTicks(
	ticks: number,
	seed: number,
): { state: RidersState; outputs: unknown[] } {
	const random = createRandom(seed);
	let state = startRiders({ grid, requestsPerMinute: 10 });
	const outputs: unknown[] = [];
	for (let n = 1; n <= ticks; n++) {
		const decision = decideRiders(
			state,
			{ type: "clock.ticked", tick: tick(n) },
			random,
		);
		state = decision.state;
		outputs.push(...decision.outputs);
	}
	return { state, outputs };
}

describe("decideRiders over many ticks", () => {
	// 6000 ticks at 10/min -> 1000 expected; Poisson sd ~32, so +-100 is ~3 sd.
	test("spawns about 10 riders per minute", () => {
		const { outputs } = runTicks(6000, 42);
		expect(Math.abs(outputs.length - 1000)).toBeLessThanOrEqual(100);
	});

	test("every waiting rider has patience between 120 and 300 ticks", () => {
		const { state } = runTicks(6000, 42);
		const outOfRange = state.riders.filter(
			(rider) => rider.patience < 120 || rider.patience > 300,
		);
		expect(outOfRange).toEqual([]);
	});

	test("same seed gives identical outputs", () => {
		expect(runTicks(600, 7).outputs).toEqual(runTicks(600, 7).outputs);
	});
});
