import { describe, expect, test } from "bun:test";
import { type Cell, cellIn, type Grid } from "../shared/grid.ts";
import { DriverId, type Offer, Tick, TripId } from "../shared/messages.ts";
import { createRandom, type Random } from "../shared/random.ts";
import {
	type DriverShardInput,
	type DriverShardState,
	decideDriverShard,
	type Preferences,
	type Shifts,
	startDriverShard,
} from "./brain.ts";

const grid: Grid = { width: 10, height: 10 };
const d1 = DriverId.parse("d-1");
const d2 = DriverId.parse("d-2");
const t1 = TripId.parse("t-1");
const t2 = TripId.parse("t-2");

function cell(x: number, y: number): Cell {
	const result = cellIn(grid, x, y);
	if (!result.ok) throw new Error(`test cell (${x}, ${y}) outside grid`);
	return result.value;
}

function tick(n: number): Tick {
	return Tick.parse(n);
}

function offer(driverId: DriverId): Offer {
	return {
		type: "offer",
		tripId: t1,
		driverId,
		pickup: cell(5, 5),
		dropoff: cell(8, 2),
	};
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

// Shift streams: each child(label) replays its own script, as a real child
// depends only on seed and label. Ints must fall in the requested range.
function shiftRandom(
	draws: number[],
	streams: Record<string, number[]>,
): Random {
	return {
		...scriptedRandom(draws),
		child: (label) => {
			const script = streams[label];
			if (script === undefined) throw new Error(`unexpected stream ${label}`);
			const queue = [...script];
			const next = () => {
				const value = queue.shift();
				if (value === undefined) throw new Error(`${label} exhausted`);
				return value;
			};
			return {
				int: (min, maxInclusive) => {
					const value = next();
					if (value < min || value > maxInclusive) {
						throw new Error(
							`${label} draw ${value} outside [${min}, ${maxInclusive}]`,
						);
					}
					return value;
				},
				float: next,
				child: () => {
					throw new Error("unexpected grandchild stream");
				},
			};
		},
	};
}

const shifts: Shifts = {
	type: "shifts",
	onlineTicks: { min: 2, max: 10 },
	offlineTicks: { min: 3, max: 6 },
	startOnlineShare: 0.5,
};

describe("startDriverShard", () => {
	test("places each driver at a random cell and announces it online, in driver ID order", () => {
		const { outputs } = startDriverShard(
			{ grid, driverIds: [d2, d1], tick: tick(5) },
			scriptedRandom([3, 4, 7, 8]),
		);
		expect(outputs).toEqual([
			{
				type: "driver.went_online",
				tick: tick(5),
				driverId: d1,
				cell: cell(3, 4),
			},
			{
				type: "driver.went_online",
				tick: tick(5),
				driverId: d2,
				cell: cell(7, 8),
			},
		]);
	});
});

describe("startDriverShard with shifts", () => {
	test("announces only drivers whose start coin lands under the online share", () => {
		const { outputs } = startDriverShard(
			{ grid, driverIds: [d1, d2], tick: tick(5), shifts },
			shiftRandom([3, 4, 7, 8], {
				"shift:d-1:0": [0.7, 4],
				"shift:d-2:0": [0.2, 9],
			}),
		);
		expect(outputs).toEqual([
			{
				type: "driver.went_online",
				tick: tick(5),
				driverId: d2,
				cell: cell(7, 8),
			},
		]);
	});
});

describe("decideDriverShard with shifts", () => {
	// Feeds ticks from..to (inclusive), returning the last state and all outputs.
	function runTicks(
		state: DriverShardState,
		from: number,
		to: number,
		random: Random,
	) {
		const outputs: unknown[] = [];
		for (let n = from; n <= to; n++) {
			const decided = decideDriverShard(
				state,
				{ type: "clock.ticked", tick: tick(n) },
				random,
			);
			state = decided.state;
			outputs.push(...decided.outputs);
		}
		return { state, outputs };
	}

	test("driver offline at start stays put, then comes online at its cell when the offline period ends", () => {
		const random = shiftRandom([3, 4], {
			"shift:d-1:0": [0.7, 4],
			"shift:d-1:1": [5],
		});
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0), shifts },
			random,
		);
		const { outputs } = runTicks(started.state, 1, 4, random);
		expect(outputs).toEqual([
			{
				type: "driver.went_online",
				tick: tick(4),
				driverId: d1,
				cell: cell(3, 4),
			},
		]);
	});

	test("idle driver goes offline at its cell when the online period ends", () => {
		const random = shiftRandom([0, 0, 3, 0], {
			"shift:d-1:0": [0.2, 2],
			"shift:d-1:1": [3],
		});
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0), shifts },
			random,
		);
		const { outputs } = runTicks(started.state, 1, 2, random);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(1), driverId: d1, cell: cell(1, 0) },
			{
				type: "driver.went_offline",
				tick: tick(2),
				driverId: d1,
				cell: cell(1, 0),
			},
		]);
	});

	test("driver on a trip when the online period ends finishes it, goes offline once idle, and its offline period counts from then", () => {
		const random = shiftRandom([0, 0], {
			"shift:d-1:0": [0.2, 2],
			"shift:d-1:1": [3],
			"shift:d-1:2": [5],
		});
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0), shifts },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const enRoute = runTicks(accepted.state, 1, 2, random);
		const cancelled = decideDriverShard(
			enRoute.state,
			{ type: "trip.cancelled", tick: tick(2), tripId: t1, driverId: d1 },
			random,
		);
		const { outputs } = runTicks(cancelled.state, 3, 6, random);
		expect([...enRoute.outputs, ...outputs]).toEqual([
			{ type: "driver.moved", tick: tick(1), driverId: d1, cell: cell(1, 0) },
			{ type: "driver.moved", tick: tick(2), driverId: d1, cell: cell(1, 1) },
			{
				type: "driver.went_offline",
				tick: tick(3),
				driverId: d1,
				cell: cell(1, 1),
			},
			{
				type: "driver.went_online",
				tick: tick(6),
				driverId: d1,
				cell: cell(1, 1),
			},
		]);
	});

	test("driver at dropoff when the online period ends goes offline on the first tick after the trip completes", () => {
		const random = shiftRandom([0, 0], {
			"shift:d-1:0": [0.2, 2],
			"shift:d-1:1": [3],
		});
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0), shifts },
			random,
		);
		const accepted = decideDriverShard(
			started.state,
			{ ...offer(d1), pickup: cell(1, 0), dropoff: cell(2, 0) },
			random,
		);
		const atPickup = runTicks(accepted.state, 1, 1, random);
		const pickedUp = decideDriverShard(
			atPickup.state,
			{ type: "trip.picked_up", tick: tick(1), tripId: t1, driverId: d1 },
			random,
		);
		const atDropoff = runTicks(pickedUp.state, 2, 3, random);
		const completed = decideDriverShard(
			atDropoff.state,
			{ type: "trip.completed", tick: tick(3), tripId: t1, driverId: d1 },
			random,
		);
		const { outputs } = runTicks(completed.state, 4, 4, random);
		expect([...atDropoff.outputs, ...completed.outputs, ...outputs]).toEqual([
			{ type: "driver.moved", tick: tick(2), driverId: d1, cell: cell(2, 0) },
			{
				type: "driver.arrived_at_dropoff",
				tick: tick(2),
				driverId: d1,
				tripId: t1,
				cell: cell(2, 0),
			},
			{
				type: "driver.went_offline",
				tick: tick(4),
				driverId: d1,
				cell: cell(2, 0),
			},
		]);
	});

	function offlineAtStart() {
		const random = shiftRandom([3, 4], { "shift:d-1:0": [0.7, 4] });
		const { state } = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0), shifts },
			random,
		);
		return { state, random };
	}

	test("offline driver declines an offer", () => {
		const { state, random } = offlineAtStart();
		const { outputs } = decideDriverShard(state, offer(d1), random);
		expect(outputs).toEqual([
			{ type: "offer_declined", tripId: t1, driverId: d1 },
		]);
	});

	test("offline driver stays offline when a trip naming it is cancelled", () => {
		const { state, random } = offlineAtStart();
		const cancelled = decideDriverShard(
			state,
			{ type: "trip.cancelled", tick: tick(1), tripId: t1, driverId: d1 },
			random,
		);
		const { outputs } = runTicks(cancelled.state, 2, 3, random);
		expect([...cancelled.outputs, ...outputs]).toEqual([]);
	});
});

describe("startDriverShard shift config", () => {
	test("always_online takes no shift streams", () => {
		const { outputs } = startDriverShard(
			{
				grid,
				driverIds: [d1],
				tick: tick(0),
				shifts: { type: "always_online" },
			},
			scriptedRandom([3, 4]),
		);
		expect(outputs).toEqual([
			{
				type: "driver.went_online",
				tick: tick(0),
				driverId: d1,
				cell: cell(3, 4),
			},
		]);
	});

	const invalid: [string, Partial<Extract<Shifts, { type: "shifts" }>>][] = [
		["online min above max", { onlineTicks: { min: 5, max: 4 } }],
		["offline min above max", { offlineTicks: { min: 5, max: 4 } }],
		["zero-length online period", { onlineTicks: { min: 0, max: 4 } }],
		["negative offline period", { offlineTicks: { min: -1, max: 4 } }],
		["fractional period length", { onlineTicks: { min: 1.5, max: 4 } }],
		["online share below 0", { startOnlineShare: -0.1 }],
		["online share above 1", { startOnlineShare: 1.1 }],
		["online share NaN", { startOnlineShare: Number.NaN }],
	];

	test.each(invalid)("%s throws", (_case, override) => {
		expect(() =>
			startDriverShard(
				{
					grid,
					driverIds: [d1],
					tick: tick(0),
					shifts: { ...shifts, ...override } as Shifts,
				},
				createRandom(1),
			),
		).toThrow();
	});
});

describe("startDriverShard preferences config", () => {
	const picky: Extract<Preferences, { type: "picky" }> = {
		type: "picky",
		maxPickupDistance: { min: 2, max: 12 },
		declineShare: 0.25,
	};

	test("accept_all takes no preference streams and accepts an idle driver's offer", () => {
		const random = scriptedRandom([0, 0]);
		const { state } = startDriverShard(
			{
				grid,
				driverIds: [d1],
				tick: tick(0),
				preferences: { type: "accept_all" },
			},
			random,
		);
		const { outputs } = decideDriverShard(state, offer(d1), random);
		expect(outputs).toEqual([
			{ type: "offer_accepted", tripId: t1, driverId: d1 },
		]);
	});

	const invalid: [string, Partial<typeof picky>][] = [
		["min above max", { maxPickupDistance: { min: 5, max: 4 } }],
		["negative distance", { maxPickupDistance: { min: -1, max: 4 } }],
		["fractional distance", { maxPickupDistance: { min: 1, max: 4.5 } }],
		["decline share below 0", { declineShare: -0.1 }],
		["decline share above 1", { declineShare: 1.1 }],
		["decline share NaN", { declineShare: Number.NaN }],
	];

	test.each(invalid)("%s throws", (_case, override) => {
		expect(() =>
			startDriverShard(
				{
					grid,
					driverIds: [d1],
					tick: tick(0),
					preferences: { ...picky, ...override },
				},
				createRandom(1),
			),
		).toThrow();
	});
});

describe("decideDriverShard on tick", () => {
	test("idle driver without a wander target picks one and moves one step toward it", () => {
		const random = scriptedRandom([0, 0, 3, 1]);
		const { state } = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const { outputs } = decideDriverShard(
			state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(1), driverId: d1, cell: cell(1, 0) },
		]);
	});

	test("each idle driver moves, in driver ID order", () => {
		const random = scriptedRandom([0, 0, 9, 9, 3, 0, 9, 5]);
		const { state } = startDriverShard(
			{ grid, driverIds: [d2, d1], tick: tick(0) },
			random,
		);
		const { outputs } = decideDriverShard(
			state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(1), driverId: d1, cell: cell(1, 0) },
			{ type: "driver.moved", tick: tick(1), driverId: d2, cell: cell(9, 8) },
		]);
	});

	test("drivers still move in driver ID order after the first one accepts an offer", () => {
		const random = scriptedRandom([0, 0, 9, 9, 9, 5]);
		const started = startDriverShard(
			{ grid, driverIds: [d1, d2], tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const { outputs } = decideDriverShard(
			accepted.state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(1), driverId: d1, cell: cell(1, 0) },
			{ type: "driver.moved", tick: tick(1), driverId: d2, cell: cell(9, 8) },
		]);
	});

	test("driver keeps its wander target until it reaches it", () => {
		const random = scriptedRandom([0, 0, 3, 0]);
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const first = decideDriverShard(
			started.state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		const { outputs } = decideDriverShard(
			first.state,
			{ type: "clock.ticked", tick: tick(2) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(2), driverId: d1, cell: cell(2, 0) },
		]);
	});

	test("driver whose new wander target is its own cell does not move", () => {
		const random = scriptedRandom([2, 2, 2, 2]);
		const { state } = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const { outputs } = decideDriverShard(
			state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		expect(outputs).toEqual([]);
	});

	test("en route driver moves one step toward the pickup", () => {
		const random = scriptedRandom([0, 0]);
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const { outputs } = decideDriverShard(
			accepted.state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(1), driverId: d1, cell: cell(1, 0) },
		]);
	});

	test("en route driver reaching the pickup reports arrival after the move", () => {
		const random = scriptedRandom([5, 4]);
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const { outputs } = decideDriverShard(
			accepted.state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(1), driverId: d1, cell: cell(5, 5) },
			{
				type: "driver.arrived_at_pickup",
				tick: tick(1),
				driverId: d1,
				tripId: t1,
				cell: cell(5, 5),
			},
		]);
	});

	test("driver that accepts while on the pickup cell reports arrival on the next tick", () => {
		const random = scriptedRandom([5, 5]);
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const { outputs } = decideDriverShard(
			accepted.state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		expect(outputs).toEqual([
			{
				type: "driver.arrived_at_pickup",
				tick: tick(1),
				driverId: d1,
				tripId: t1,
				cell: cell(5, 5),
			},
		]);
	});

	test("driver waiting at the pickup stays put without reporting arrival again", () => {
		const random = scriptedRandom([5, 4]);
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const arrived = decideDriverShard(
			accepted.state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		const { outputs } = decideDriverShard(
			arrived.state,
			{ type: "clock.ticked", tick: tick(2) },
			random,
		);
		expect(outputs).toEqual([]);
	});

	test("driver that reached its wander target picks a new one on the next tick", () => {
		const random = scriptedRandom([0, 0, 1, 0, 1, 2]);
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const arrived = decideDriverShard(
			started.state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		const { outputs } = decideDriverShard(
			arrived.state,
			{ type: "clock.ticked", tick: tick(2) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(2), driverId: d1, cell: cell(1, 1) },
		]);
	});
});

describe("decideDriverShard on offer", () => {
	test("idle driver accepts the offer", () => {
		const random = scriptedRandom([0, 0]);
		const { state } = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const { outputs } = decideDriverShard(state, offer(d1), random);
		expect(outputs).toEqual([
			{ type: "offer_accepted", tripId: t1, driverId: d1 },
		]);
	});

	test("driver that accepts heads to the pickup instead of its wander target", () => {
		const random = scriptedRandom([0, 0, 9, 0]);
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const wandering = decideDriverShard(
			started.state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		const accepted = decideDriverShard(wandering.state, offer(d1), random);
		const { outputs } = decideDriverShard(
			accepted.state,
			{ type: "clock.ticked", tick: tick(2) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(2), driverId: d1, cell: cell(1, 1) },
		]);
	});

	test("en route driver declines another offer", () => {
		const random = scriptedRandom([0, 0]);
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const { outputs } = decideDriverShard(
			accepted.state,
			{ ...offer(d1), tripId: t2 },
			random,
		);
		expect(outputs).toEqual([
			{ type: "offer_declined", tripId: t2, driverId: d1 },
		]);
	});

	test("declining leaves the shard state unchanged", () => {
		const random = scriptedRandom([0, 0]);
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const { state } = decideDriverShard(
			accepted.state,
			{ ...offer(d1), tripId: t2 },
			random,
		);
		expect(state).toEqual(accepted.state);
	});

	test("offer for a driver outside the shard is a bug", () => {
		const random = scriptedRandom([0, 0]);
		const { state } = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		expect(() => decideDriverShard(state, offer(d2), random)).toThrow();
	});
});

describe("decideDriverShard with picky preferences", () => {
	const picky: Preferences = {
		type: "picky",
		maxPickupDistance: { min: 2, max: 12 },
		declineShare: 0.25,
	};

	// d-1 starts at (0, 0); offers pick up at (5, 5), distance 10.
	function pickyAtOrigin(streams: Record<string, number[]>) {
		const random = shiftRandom([0, 0], streams);
		const { state } = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0), preferences: picky },
			random,
		);
		return { state, random };
	}

	test("idle driver declines a pickup farther than its max pickup distance", () => {
		const { state, random } = pickyAtOrigin({ "preference:d-1": [9] });
		const { outputs } = decideDriverShard(state, offer(d1), random);
		expect(outputs).toEqual([
			{ type: "offer_declined", tripId: t1, driverId: d1 },
		]);
	});

	test("idle driver within range declines when the offer draw lands under the decline share", () => {
		const { state, random } = pickyAtOrigin({
			"preference:d-1": [10],
			"offer:t-1:d-1": [0.2],
		});
		const { outputs } = decideDriverShard(state, offer(d1), random);
		expect(outputs).toEqual([
			{ type: "offer_declined", tripId: t1, driverId: d1 },
		]);
	});

	test("idle driver within range accepts when the offer draw reaches the decline share", () => {
		const { state, random } = pickyAtOrigin({
			"preference:d-1": [12],
			"offer:t-1:d-1": [0.25],
		});
		const { outputs } = decideDriverShard(state, offer(d1), random);
		expect(outputs).toEqual([
			{ type: "offer_accepted", tripId: t1, driverId: d1 },
		]);
	});

	// No stream for t-2: a preference check would throw.
	test("en route driver declines another offer before any preference check", () => {
		const { state, random } = pickyAtOrigin({
			"preference:d-1": [10],
			"offer:t-1:d-1": [0.9],
		});
		const accepted = decideDriverShard(state, offer(d1), random);
		const { outputs } = decideDriverShard(
			accepted.state,
			{ ...offer(d1), tripId: t2, pickup: cell(9, 9) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "offer_declined", tripId: t2, driverId: d1 },
		]);
	});
});

describe("decideDriverShard on trip ended", () => {
	test("driver whose trip is cancelled goes back to wandering", () => {
		const random = scriptedRandom([0, 0, 0, 3]);
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const cancelled = decideDriverShard(
			accepted.state,
			{ type: "trip.cancelled", tick: tick(1), tripId: t1, driverId: d1 },
			random,
		);
		const { outputs } = decideDriverShard(
			cancelled.state,
			{ type: "clock.ticked", tick: tick(2) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(2), driverId: d1, cell: cell(0, 1) },
		]);
	});

	test("driver waiting at the pickup goes back to wandering when its trip is cancelled", () => {
		const random = scriptedRandom([5, 4, 5, 9]);
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const arrived = decideDriverShard(
			accepted.state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		const cancelled = decideDriverShard(
			arrived.state,
			{ type: "trip.cancelled", tick: tick(2), tripId: t1, driverId: d1 },
			random,
		);
		const { outputs } = decideDriverShard(
			cancelled.state,
			{ type: "clock.ticked", tick: tick(3) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(3), driverId: d1, cell: cell(5, 6) },
		]);
	});

	test("driver that accepted an expired offer goes back to wandering", () => {
		const random = scriptedRandom([0, 0, 0, 3]);
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const expired = decideDriverShard(
			accepted.state,
			{ type: "trip.offer_expired", tick: tick(1), tripId: t1, driverId: d1 },
			random,
		);
		const { outputs } = decideDriverShard(
			expired.state,
			{ type: "clock.ticked", tick: tick(2) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(2), driverId: d1, cell: cell(0, 1) },
		]);
	});

	test("driver keeps heading to its pickup when another trip of its ends", () => {
		const random = scriptedRandom([0, 0]);
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const expired = decideDriverShard(
			accepted.state,
			{ type: "trip.offer_expired", tick: tick(1), tripId: t2, driverId: d1 },
			random,
		);
		const { outputs } = decideDriverShard(
			expired.state,
			{ type: "clock.ticked", tick: tick(2) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(2), driverId: d1, cell: cell(1, 0) },
		]);
	});

	test("driver keeps heading to its pickup when another driver's offer for the same trip expires", () => {
		const random = scriptedRandom([0, 0]);
		const started = startDriverShard(
			{ grid, driverIds: [d2], tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d2), random);
		const expired = decideDriverShard(
			accepted.state,
			{ type: "trip.offer_expired", tick: tick(1), tripId: t1, driverId: d1 },
			random,
		);
		const { outputs } = decideDriverShard(
			expired.state,
			{ type: "clock.ticked", tick: tick(2) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(2), driverId: d2, cell: cell(1, 0) },
		]);
	});
});

describe("decideDriverShard carrying the rider", () => {
	// Driver starts next to the pickup (5, 5) and arrives on tick 1.
	function waitingAtPickup(random: Random, dropoff = cell(8, 2)) {
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(
			started.state,
			{ ...offer(d1), dropoff },
			random,
		);
		return decideDriverShard(
			accepted.state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		).state;
	}

	test("driver picked up at the pickup moves one step toward the dropoff", () => {
		const random = scriptedRandom([5, 4]);
		const pickedUp = decideDriverShard(
			waitingAtPickup(random),
			{ type: "trip.picked_up", tick: tick(2), tripId: t1, driverId: d1 },
			random,
		);
		const { outputs } = decideDriverShard(
			pickedUp.state,
			{ type: "clock.ticked", tick: tick(3) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(3), driverId: d1, cell: cell(6, 5) },
		]);
	});

	test("driver reaching the dropoff reports arrival after the move", () => {
		const random = scriptedRandom([5, 4]);
		const pickedUp = decideDriverShard(
			waitingAtPickup(random, cell(6, 5)),
			{ type: "trip.picked_up", tick: tick(2), tripId: t1, driverId: d1 },
			random,
		);
		const { outputs } = decideDriverShard(
			pickedUp.state,
			{ type: "clock.ticked", tick: tick(3) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(3), driverId: d1, cell: cell(6, 5) },
			{
				type: "driver.arrived_at_dropoff",
				tick: tick(3),
				driverId: d1,
				tripId: t1,
				cell: cell(6, 5),
			},
		]);
	});

	test("driver picked up on its dropoff cell reports arrival without moving", () => {
		const random = scriptedRandom([5, 4]);
		const pickedUp = decideDriverShard(
			waitingAtPickup(random, cell(5, 5)),
			{ type: "trip.picked_up", tick: tick(2), tripId: t1, driverId: d1 },
			random,
		);
		const { outputs } = decideDriverShard(
			pickedUp.state,
			{ type: "clock.ticked", tick: tick(3) },
			random,
		);
		expect(outputs).toEqual([
			{
				type: "driver.arrived_at_dropoff",
				tick: tick(3),
				driverId: d1,
				tripId: t1,
				cell: cell(5, 5),
			},
		]);
	});

	test("driver waiting at the dropoff stays put without reporting arrival again", () => {
		const random = scriptedRandom([5, 4]);
		const pickedUp = decideDriverShard(
			waitingAtPickup(random, cell(6, 5)),
			{ type: "trip.picked_up", tick: tick(2), tripId: t1, driverId: d1 },
			random,
		);
		const arrived = decideDriverShard(
			pickedUp.state,
			{ type: "clock.ticked", tick: tick(3) },
			random,
		);
		const { outputs } = decideDriverShard(
			arrived.state,
			{ type: "clock.ticked", tick: tick(4) },
			random,
		);
		expect(outputs).toEqual([]);
	});

	test("cancellation of the trip a driver is carrying is rejected, state unchanged", () => {
		const random = scriptedRandom([5, 4]);
		const pickedUp = decideDriverShard(
			waitingAtPickup(random),
			{ type: "trip.picked_up", tick: tick(2), tripId: t1, driverId: d1 },
			random,
		);
		const cancelled: DriverShardInput = {
			type: "trip.cancelled",
			tick: tick(3),
			tripId: t1,
			driverId: d1,
		};
		expect(decideDriverShard(pickedUp.state, cancelled, random)).toEqual({
			state: pickedUp.state,
			outputs: [
				{
					type: "input_rejected",
					reason: "trip_already_picked_up",
					input: cancelled,
				},
			],
		});
	});

	test("driver carrying the rider ignores a cancellation of another trip", () => {
		const random = scriptedRandom([5, 4]);
		const pickedUp = decideDriverShard(
			waitingAtPickup(random),
			{ type: "trip.picked_up", tick: tick(2), tripId: t1, driverId: d1 },
			random,
		);
		const cancelled = decideDriverShard(
			pickedUp.state,
			{ type: "trip.cancelled", tick: tick(3), tripId: t2, driverId: d1 },
			random,
		);
		expect(cancelled).toEqual({ state: pickedUp.state, outputs: [] });
	});

	test("offer expiry of the trip a driver is waiting at the dropoff for is rejected, state unchanged", () => {
		const random = scriptedRandom([5, 4]);
		const pickedUp = decideDriverShard(
			waitingAtPickup(random, cell(6, 5)),
			{ type: "trip.picked_up", tick: tick(2), tripId: t1, driverId: d1 },
			random,
		);
		const arrived = decideDriverShard(
			pickedUp.state,
			{ type: "clock.ticked", tick: tick(3) },
			random,
		);
		const expired: DriverShardInput = {
			type: "trip.offer_expired",
			tick: tick(4),
			tripId: t1,
			driverId: d1,
		};
		expect(decideDriverShard(arrived.state, expired, random)).toEqual({
			state: arrived.state,
			outputs: [
				{
					type: "input_rejected",
					reason: "trip_already_picked_up",
					input: expired,
				},
			],
		});
	});

	test("driver whose trip is completed goes back to wandering from the dropoff", () => {
		const random = scriptedRandom([5, 4, 6, 9]);
		const pickedUp = decideDriverShard(
			waitingAtPickup(random, cell(6, 5)),
			{ type: "trip.picked_up", tick: tick(2), tripId: t1, driverId: d1 },
			random,
		);
		const arrived = decideDriverShard(
			pickedUp.state,
			{ type: "clock.ticked", tick: tick(3) },
			random,
		);
		const completed = decideDriverShard(
			arrived.state,
			{ type: "trip.completed", tick: tick(4), tripId: t1, driverId: d1 },
			random,
		);
		const { outputs } = decideDriverShard(
			completed.state,
			{ type: "clock.ticked", tick: tick(5) },
			random,
		);
		expect(outputs).toEqual([
			{ type: "driver.moved", tick: tick(5), driverId: d1, cell: cell(6, 6) },
		]);
	});
});

describe("decideDriverShard rejecting inputs", () => {
	test("pickup for a driver still heading to the pickup is rejected", () => {
		const random = scriptedRandom([0, 0]);
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const pickedUp: DriverShardInput = {
			type: "trip.picked_up",
			tick: tick(1),
			tripId: t1,
			driverId: d1,
		};
		const { outputs } = decideDriverShard(accepted.state, pickedUp, random);
		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "driver_not_at_pickup",
				input: pickedUp,
			},
		]);
	});

	test("pickup of another trip for a driver waiting at its pickup is rejected", () => {
		const random = scriptedRandom([5, 4]);
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const arrived = decideDriverShard(
			accepted.state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		const pickedUp: DriverShardInput = {
			type: "trip.picked_up",
			tick: tick(2),
			tripId: t2,
			driverId: d1,
		};
		const { outputs } = decideDriverShard(arrived.state, pickedUp, random);
		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "driver_on_another_trip",
				input: pickedUp,
			},
		]);
	});

	test("completion for a driver still carrying the rider is rejected", () => {
		const random = scriptedRandom([5, 4]);
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const arrived = decideDriverShard(
			accepted.state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		const pickedUp = decideDriverShard(
			arrived.state,
			{ type: "trip.picked_up", tick: tick(2), tripId: t1, driverId: d1 },
			random,
		);
		const completed: DriverShardInput = {
			type: "trip.completed",
			tick: tick(3),
			tripId: t1,
			driverId: d1,
		};
		const { outputs } = decideDriverShard(pickedUp.state, completed, random);
		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "driver_not_at_dropoff",
				input: completed,
			},
		]);
	});

	test("completion of another trip for a driver waiting at its dropoff is rejected", () => {
		const random = scriptedRandom([5, 4]);
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(
			started.state,
			{ ...offer(d1), dropoff: cell(6, 5) },
			random,
		);
		const atPickup = decideDriverShard(
			accepted.state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		const pickedUp = decideDriverShard(
			atPickup.state,
			{ type: "trip.picked_up", tick: tick(2), tripId: t1, driverId: d1 },
			random,
		);
		const atDropoff = decideDriverShard(
			pickedUp.state,
			{ type: "clock.ticked", tick: tick(3) },
			random,
		);
		const completed: DriverShardInput = {
			type: "trip.completed",
			tick: tick(4),
			tripId: t2,
			driverId: d1,
		};
		const { outputs } = decideDriverShard(atDropoff.state, completed, random);
		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "driver_on_another_trip",
				input: completed,
			},
		]);
	});

	test("pickup and completion for drivers outside the shard are ignored", () => {
		const random = scriptedRandom([0, 0]);
		const { state } = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const pickedUp = decideDriverShard(
			state,
			{ type: "trip.picked_up", tick: tick(1), tripId: t1, driverId: d2 },
			random,
		);
		const completed = decideDriverShard(
			pickedUp.state,
			{ type: "trip.completed", tick: tick(2), tripId: t1, driverId: d2 },
			random,
		);
		expect([...pickedUp.outputs, ...completed.outputs]).toEqual([]);
	});
});

describe("driver shard trip scenario", () => {
	test("driver takes a trip from offer to completion and goes back to wandering", () => {
		const random = scriptedRandom([3, 5, 8, 4]);
		const started = startDriverShard(
			{ grid, driverIds: [d1], tick: tick(0) },
			random,
		);
		const inputs: DriverShardInput[] = [
			offer(d1),
			{ type: "clock.ticked", tick: tick(1) },
			{ type: "clock.ticked", tick: tick(2) },
			{ type: "clock.ticked", tick: tick(3) },
			{ type: "trip.picked_up", tick: tick(3), tripId: t1, driverId: d1 },
			...[4, 5, 6, 7, 8, 9, 10].map(
				(n): DriverShardInput => ({ type: "clock.ticked", tick: tick(n) }),
			),
			{ type: "trip.completed", tick: tick(10), tripId: t1, driverId: d1 },
			{ type: "clock.ticked", tick: tick(11) },
		];
		let state = started.state;
		const outputs: unknown[] = [];
		for (const input of inputs) {
			const decided = decideDriverShard(state, input, random);
			state = decided.state;
			outputs.push(...decided.outputs);
		}
		const moved = (n: number, x: number, y: number) => ({
			type: "driver.moved",
			tick: tick(n),
			driverId: d1,
			cell: cell(x, y),
		});
		expect(outputs).toEqual([
			{ type: "offer_accepted", tripId: t1, driverId: d1 },
			moved(1, 4, 5),
			moved(2, 5, 5),
			{
				type: "driver.arrived_at_pickup",
				tick: tick(2),
				driverId: d1,
				tripId: t1,
				cell: cell(5, 5),
			},
			moved(4, 6, 5),
			moved(5, 6, 4),
			moved(6, 7, 4),
			moved(7, 7, 3),
			moved(8, 8, 3),
			moved(9, 8, 2),
			{
				type: "driver.arrived_at_dropoff",
				tick: tick(9),
				driverId: d1,
				tripId: t1,
				cell: cell(8, 2),
			},
			moved(11, 8, 3),
		]);
	});
});

describe("driver shard determinism", () => {
	function run(seed: number, shifts?: Shifts) {
		const random = createRandom(seed);
		const started = startDriverShard(
			{ grid, driverIds: [d1, d2], tick: tick(0), shifts },
			random,
		);
		const outputs: unknown[] = [...started.outputs];
		let state = started.state;
		for (let n = 1; n <= 30; n++) {
			const decided = decideDriverShard(
				state,
				{ type: "clock.ticked", tick: tick(n) },
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

	test("same seed and inputs give identical outputs with shifts", () => {
		expect(run(42, shifts)).toEqual(run(42, shifts));
	});
});
