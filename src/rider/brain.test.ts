import { describe, expect, test } from "bun:test";
import { type Cell, cellIn, type Grid } from "../shared/grid.ts";
import { DriverId, RiderId, Tick, TripId } from "../shared/messages.ts";
import { createRandom, type Random } from "../shared/random.ts";
import {
	decideRiders,
	type RidersInput,
	type RidersState,
	startRiders,
} from "./brain.ts";

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

type Decision = ReturnType<typeof decideRiders>;

function runTicks(ticks: number, seed: number): Decision {
	const random = createRandom(seed);
	let state = startRiders({ grid, requestsPerMinute: 10 });
	const outputs: Decision["outputs"] = [];
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
		const requests = outputs.filter((output) => output.type === "request_trip");
		expect(Math.abs(requests.length - 1000)).toBeLessThanOrEqual(100);
	});

	test("every waiting rider has patience between 120 and 300 ticks", () => {
		const { state } = runTicks(6000, 42);
		const outOfRange = state.riders.filter(
			(rider) =>
				rider.state === "waiting" &&
				(rider.patience < 120 || rider.patience > 300),
		);
		expect(outOfRange).toEqual([]);
	});

	test("same seed gives identical outputs", () => {
		expect(runTicks(600, 7).outputs).toEqual(runTicks(600, 7).outputs);
	});
});

const r1 = RiderId.parse("r-1");
const t1 = TripId.parse("t-1");

// r-1 requested t-1 at tick 1 with patience 150: gives up at tick 151.
function waitingRider(): RidersState {
	return {
		...startRiders({ grid, requestsPerMinute: 10 }),
		spawned: 1,
		riders: [
			{
				state: "waiting",
				id: r1,
				tripId: t1,
				requestedAt: tick(1),
				patience: 150,
			},
		],
	};
}

// Tick whose demand draw spawns nobody.
function quietTick(state: RidersState, n: number) {
	return decideRiders(
		state,
		{ type: "clock.ticked", tick: tick(n) },
		scriptedRandom({
			[`demand:${n}`]: { floats: [0.5] },
			[`patience:${n}`]: {},
		}),
	);
}

describe("decideRiders patience", () => {
	test("waiting rider whose patience runs out cancels the trip", () => {
		expect(quietTick(waitingRider(), 151).outputs).toEqual([
			{ type: "cancel_trip", tripId: t1 },
		]);
	});

	test("waiting rider with patience left does not cancel", () => {
		expect(quietTick(waitingRider(), 150).outputs).toEqual([]);
	});

	// r-9 (patience 150 from tick 1) and r-10 (spawned at tick 2, patience 149)
	// both give up at tick 151; plain string order puts r-10 first.
	test("riders out of patience on the same tick cancel ordered by ID", () => {
		const r9: RidersState = {
			...startRiders({ grid, requestsPerMinute: 10 }),
			spawned: 9,
			riders: [
				{
					state: "waiting",
					id: RiderId.parse("r-9"),
					tripId: TripId.parse("t-9"),
					requestedAt: tick(1),
					patience: 150,
				},
			],
		};
		const r10 = decideRiders(
			r9,
			{ type: "clock.ticked", tick: tick(2) },
			scriptedRandom({
				"demand:2": { floats: [0.9, 0.5], ints: [2, 3, 7, 8] },
				"patience:2": { ints: [149] },
			}),
		);
		expect(quietTick(r10.state, 151).outputs).toEqual([
			{ type: "cancel_trip", tripId: TripId.parse("t-10") },
			{ type: "cancel_trip", tripId: TripId.parse("t-9") },
		]);
	});

	test("rider cancels a trip only once", () => {
		const cancelled = quietTick(waitingRider(), 151);
		expect(quietTick(cancelled.state, 152).outputs).toEqual([]);
	});
});

const d1 = DriverId.parse("d-1");

function pickedUp(state: RidersState, n: number) {
	return decideRiders(
		state,
		{ type: "trip.picked_up", tick: tick(n), tripId: t1, driverId: d1 },
		scriptedRandom({}),
	);
}

describe("decideRiders trip outcomes", () => {
	test("picked-up rider does not cancel when patience runs out", () => {
		const riding = pickedUp(waitingRider(), 100);
		expect(quietTick(riding.state, 151).outputs).toEqual([]);
	});

	test("rider whose trip completes is removed", () => {
		const riding = pickedUp(waitingRider(), 100);
		const completed = decideRiders(
			riding.state,
			{ type: "trip.completed", tick: tick(200), tripId: t1, driverId: d1 },
			scriptedRandom({}),
		);
		expect(completed).toEqual({
			state: { ...waitingRider(), riders: [] },
			outputs: [],
		});
	});

	test("rider whose trip is cancelled is removed", () => {
		const cancelling = quietTick(waitingRider(), 151);
		const cancelled = decideRiders(
			cancelling.state,
			{ type: "trip.cancelled", tick: tick(152), tripId: t1, driverId: null },
			scriptedRandom({}),
		);
		expect(cancelled).toEqual({
			state: { ...waitingRider(), riders: [] },
			outputs: [],
		});
	});
});

function cancelRejected(state: RidersState) {
	return decideRiders(
		state,
		{
			type: "cancel_trip_rejected",
			tripId: t1,
			error: { type: "invalid_transition", from: "picked_up" },
		},
		scriptedRandom({}),
	);
}

describe("decideRiders cancel rejected", () => {
	test("rider whose cancel is rejected after pickup stays", () => {
		const cancelling = quietTick(waitingRider(), 151);
		expect(cancelRejected(cancelling.state)).toEqual({
			state: cancelling.state,
			outputs: [],
		});
	});

	test("rider whose cancel is rejected does not cancel again", () => {
		const cancelling = quietTick(waitingRider(), 151);
		const rejected = cancelRejected(cancelling.state);
		expect(quietTick(rejected.state, 152).outputs).toEqual([]);
	});

	test("riding rider whose cancel rejection arrives after the pickup stays", () => {
		const cancelling = quietTick(waitingRider(), 151);
		const riding = pickedUp(cancelling.state, 152);
		expect(cancelRejected(riding.state)).toEqual({
			state: riding.state,
			outputs: [],
		});
	});

	// Dispatch never knew the trip (e.g. request_trip lost): nothing else ends it.
	test("rider whose cancel is rejected as an unknown trip is removed", () => {
		const cancelling = quietTick(waitingRider(), 151);
		const rejected = decideRiders(
			cancelling.state,
			{
				type: "cancel_trip_rejected",
				tripId: t1,
				error: { type: "unknown_trip" },
			},
			scriptedRandom({}),
		);
		expect(rejected).toEqual({
			state: { ...waitingRider(), riders: [] },
			outputs: [],
		});
	});
});

describe("decideRiders other riders' trips", () => {
	test("trip events for trips of unknown riders are ignored", () => {
		const t2 = TripId.parse("t-2");
		const inputs: RidersInput[] = [
			{ type: "trip.picked_up", tick: tick(2), tripId: t2, driverId: d1 },
			{ type: "trip.completed", tick: tick(2), tripId: t2, driverId: d1 },
			{ type: "trip.cancelled", tick: tick(2), tripId: t2, driverId: null },
			{
				type: "cancel_trip_rejected",
				tripId: t2,
				error: { type: "unknown_trip" },
			},
		];
		const decisions = inputs.map((input) =>
			decideRiders(waitingRider(), input, scriptedRandom({})),
		);
		expect(decisions).toEqual(
			inputs.map(() => ({ state: waitingRider(), outputs: [] })),
		);
	});
});

describe("decideRiders invalid inputs", () => {
	test("pickup of a rider already riding is rejected, state unchanged", () => {
		const riding = pickedUp(waitingRider(), 100);
		const again: RidersInput = {
			type: "trip.picked_up",
			tick: tick(101),
			tripId: t1,
			driverId: d1,
		};
		expect(decideRiders(riding.state, again, scriptedRandom({}))).toEqual({
			state: riding.state,
			outputs: [
				{
					type: "input_rejected",
					reason: "rider_already_riding",
					input: again,
				},
			],
		});
	});

	test("completion of a trip whose rider was not picked up is rejected, state unchanged", () => {
		const completed: RidersInput = {
			type: "trip.completed",
			tick: tick(100),
			tripId: t1,
			driverId: d1,
		};
		expect(decideRiders(waitingRider(), completed, scriptedRandom({}))).toEqual(
			{
				state: waitingRider(),
				outputs: [
					{
						type: "input_rejected",
						reason: "rider_not_riding",
						input: completed,
					},
				],
			},
		);
	});

	test("cancellation of a trip whose rider is riding is rejected, state unchanged", () => {
		const riding = pickedUp(waitingRider(), 100);
		const cancelled: RidersInput = {
			type: "trip.cancelled",
			tick: tick(101),
			tripId: t1,
			driverId: d1,
		};
		expect(decideRiders(riding.state, cancelled, scriptedRandom({}))).toEqual({
			state: riding.state,
			outputs: [
				{
					type: "input_rejected",
					reason: "rider_already_riding",
					input: cancelled,
				},
			],
		});
	});

	test("cancel rejection for a rider that never cancelled is rejected, state unchanged", () => {
		expect(cancelRejected(waitingRider())).toEqual({
			state: waitingRider(),
			outputs: [
				{
					type: "input_rejected",
					reason: "cancel_not_requested",
					input: {
						type: "cancel_trip_rejected",
						tripId: t1,
						error: { type: "invalid_transition", from: "picked_up" },
					},
				},
			],
		});
	});
});
