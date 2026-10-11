import { describe, expect, test } from "bun:test";
import { DriverIndex, driverIdAt } from "../shared/fleet.ts";
import { type Cell, cellIn, type Grid } from "../shared/grid.ts";
import {
	type DriverId,
	driversMoved,
	driversWentOnline,
	forEachMove,
	forEachWentOnline,
	type Offer,
	Tick,
	TripId,
	type TripStatus,
} from "../shared/messages.ts";
import { createRandom, type Random } from "../shared/random.ts";
import { Region, RegionLayout } from "../shared/regions.ts";
import { Surge, Zone } from "../shared/surge.ts";
import {
	type DriverShardInput,
	type DriverShardState,
	decideDriverShard,
	type Preferences,
	type Shifts,
	startDriverShard,
} from "./brain.ts";

const grid: Grid = { width: 10, height: 10 };
// Drivers 1 and 2 of a fleet of 10: IDs d-1 and d-2 (ADR 0052).
const fleetSize = 10;
const i1 = DriverIndex.parse(1);
const i2 = DriverIndex.parse(2);
const d1 = driverIdAt(fleetSize, i1);
const d2 = driverIdAt(fleetSize, i2);

// A shard of driverCount drivers from firstIndex on.
function shard(firstIndex: DriverIndex, driverCount: number) {
	return { fleetSize, firstIndex, driverCount };
}
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
			{ grid, ...shard(i1, 2), tick: tick(5) },
			scriptedRandom([3, 4, 7, 8]),
		);
		expect(outputs).toEqual([
			driversWentOnline(tick(5), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(3, 4) },
				{ driverIndex: i2, cell: cell(7, 8) },
			]),
		]);
	});

	test("announces drivers online in messages of at most 5,000 drivers", () => {
		const { outputs } = startDriverShard(
			{
				grid: { width: 500, height: 500 },
				fleetSize: 5001,
				firstIndex: DriverIndex.parse(0),
				driverCount: 5001,
				tick: tick(0),
			},
			createRandom(1),
		);
		const driversPerMessage = outputs.map((output) => {
			let drivers = 0;
			forEachWentOnline(output, () => drivers++);
			return drivers;
		});

		expect(driversPerMessage).toEqual([5000, 1]);
	});
});

describe("startDriverShard with shifts", () => {
	test("announces only drivers whose start coin lands under the online share", () => {
		const { outputs } = startDriverShard(
			{ grid, ...shard(i1, 2), tick: tick(5), shifts },
			shiftRandom([3, 4, 7, 8], {
				"shift:d-1:0": [0.7, 4],
				"shift:d-2:0": [0.2, 9],
			}),
		);
		expect(outputs).toEqual([
			driversWentOnline(tick(5), Region.parse(0), fleetSize, [
				{ driverIndex: i2, cell: cell(7, 8) },
			]),
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
			{ grid, ...shard(i1, 1), tick: tick(0), shifts },
			random,
		);
		const { outputs } = runTicks(started.state, 1, 4, random);
		expect(outputs).toEqual([
			driversWentOnline(tick(4), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(3, 4) },
			]),
		]);
	});

	test("drivers going online come before the shard's moves of that tick", () => {
		const random = shiftRandom([3, 4, 7, 8, 0, 8], {
			"shift:d-1:0": [0.7, 3],
			"shift:d-1:1": [5],
			"shift:d-2:0": [0.2, 9],
		});
		const started = startDriverShard(
			{ grid, ...shard(i1, 2), tick: tick(0), shifts },
			random,
		);
		const before = runTicks(started.state, 1, 2, random);
		const { outputs } = runTicks(before.state, 3, 3, random);
		expect(outputs).toEqual([
			driversWentOnline(tick(3), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(3, 4) },
			]),
			driversMoved(tick(3), Region.parse(0), fleetSize, [
				{ driverIndex: i2, cell: cell(4, 8) },
			]),
		]);
	});

	test("idle driver goes offline at its cell when the online period ends", () => {
		const random = shiftRandom([0, 0, 3, 0], {
			"shift:d-1:0": [0.2, 2],
			"shift:d-1:1": [3],
		});
		const started = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0), shifts },
			random,
		);
		const { outputs } = runTicks(started.state, 1, 2, random);
		expect(outputs).toEqual([
			driversMoved(tick(1), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(1, 0) },
			]),
			{
				type: "driver.went_offline",
				tick: tick(2),
				driverId: d1,
				cell: cell(1, 0),
				region: Region.parse(0),
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
			{ grid, ...shard(i1, 1), tick: tick(0), shifts },
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
			driversMoved(tick(1), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(1, 0) },
			]),
			driversMoved(tick(2), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(1, 1) },
			]),
			{
				type: "driver.went_offline",
				tick: tick(3),
				driverId: d1,
				cell: cell(1, 1),
				region: Region.parse(0),
			},
			driversWentOnline(tick(6), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(1, 1) },
			]),
		]);
	});

	test("driver at dropoff when the online period ends goes offline on the first tick after the trip completes", () => {
		const random = shiftRandom([0, 0], {
			"shift:d-1:0": [0.2, 2],
			"shift:d-1:1": [3],
		});
		const started = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0), shifts },
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
			driversMoved(tick(2), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(2, 0) },
			]),
			{
				type: "driver.arrived_at_dropoff",
				tick: tick(2),
				driverId: d1,
				tripId: t1,
				cell: cell(2, 0),
				region: Region.parse(0),
			},
			{
				type: "driver.went_offline",
				tick: tick(4),
				driverId: d1,
				cell: cell(2, 0),
				region: Region.parse(0),
			},
		]);
	});

	function offlineAtStart() {
		const random = shiftRandom([3, 4], { "shift:d-1:0": [0.7, 4] });
		const { state } = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0), shifts },
			random,
		);
		return { state, random };
	}

	test("offline driver declines an offer", () => {
		const { state, random } = offlineAtStart();
		const { outputs } = decideDriverShard(state, offer(d1), random);
		expect(outputs).toEqual([
			{
				type: "offer_declined",
				tripId: t1,
				driverId: d1,
				region: Region.parse(0),
				idleAt: null,
			},
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
				...shard(i1, 1),
				tick: tick(0),
				shifts: { type: "always_online" },
			},
			scriptedRandom([3, 4]),
		);
		expect(outputs).toEqual([
			driversWentOnline(tick(0), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(3, 4) },
			]),
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
					...shard(i1, 1),
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
				...shard(i1, 1),
				tick: tick(0),
				preferences: { type: "accept_all" },
			},
			random,
		);
		const { outputs } = decideDriverShard(state, offer(d1), random);
		expect(outputs).toEqual([
			{
				type: "offer_accepted",
				tripId: t1,
				driverId: d1,
				region: Region.parse(0),
			},
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
					...shard(i1, 1),
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
			{ grid, ...shard(i1, 1), tick: tick(0) },
			random,
		);
		const { outputs } = decideDriverShard(
			state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		expect(outputs).toEqual([
			driversMoved(tick(1), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(1, 0) },
			]),
		]);
	});

	test("a tick's moves come before the shard's other events of that tick", () => {
		const random = scriptedRandom([5, 4, 0, 0, 3, 0]);
		const started = startDriverShard(
			{ grid, ...shard(i1, 2), tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const { outputs } = decideDriverShard(
			accepted.state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		expect(outputs).toEqual([
			driversMoved(tick(1), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(5, 5) },
				{ driverIndex: i2, cell: cell(1, 0) },
			]),
			{
				type: "driver.arrived_at_pickup",
				tick: tick(1),
				driverId: d1,
				tripId: t1,
				cell: cell(5, 5),
				region: Region.parse(0),
			},
		]);
	});

	test("a tick's moves go out in messages of at most 5,000 moves", () => {
		const random = createRandom(1);
		const { state } = startDriverShard(
			{
				grid: { width: 500, height: 500 },
				fleetSize: 5001,
				firstIndex: DriverIndex.parse(0),
				driverCount: 5001,
				tick: tick(0),
			},
			random,
		);
		const { outputs } = decideDriverShard(
			state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		const movesPerMessage = outputs.map((output) => {
			if (output.type !== "drivers.moved") return output.type;
			let moves = 0;
			forEachMove(output, () => moves++);
			return moves;
		});

		expect(movesPerMessage).toEqual([5000, 1]);
	});

	test("each idle driver moves, in driver ID order", () => {
		const random = scriptedRandom([0, 0, 9, 9, 3, 0, 9, 5]);
		const { state } = startDriverShard(
			{ grid, ...shard(i1, 2), tick: tick(0) },
			random,
		);
		const { outputs } = decideDriverShard(
			state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		expect(outputs).toEqual([
			driversMoved(tick(1), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(1, 0) },
				{ driverIndex: i2, cell: cell(9, 8) },
			]),
		]);
	});

	test("drivers still move in driver ID order after the first one accepts an offer", () => {
		const random = scriptedRandom([0, 0, 9, 9, 9, 5]);
		const started = startDriverShard(
			{ grid, ...shard(i1, 2), tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const { outputs } = decideDriverShard(
			accepted.state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		expect(outputs).toEqual([
			driversMoved(tick(1), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(1, 0) },
				{ driverIndex: i2, cell: cell(9, 8) },
			]),
		]);
	});

	test("driver keeps its wander target until it reaches it", () => {
		const random = scriptedRandom([0, 0, 3, 0]);
		const started = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0) },
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
			driversMoved(tick(2), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(2, 0) },
			]),
		]);
	});

	test("driver whose new wander target is its own cell does not move", () => {
		const random = scriptedRandom([2, 2, 2, 2]);
		const { state } = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0) },
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
			{ grid, ...shard(i1, 1), tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const { outputs } = decideDriverShard(
			accepted.state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		expect(outputs).toEqual([
			driversMoved(tick(1), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(1, 0) },
			]),
		]);
	});

	test("en route driver reaching the pickup reports arrival after the move", () => {
		const random = scriptedRandom([5, 4]);
		const started = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const { outputs } = decideDriverShard(
			accepted.state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		expect(outputs).toEqual([
			driversMoved(tick(1), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(5, 5) },
			]),
			{
				type: "driver.arrived_at_pickup",
				tick: tick(1),
				driverId: d1,
				tripId: t1,
				cell: cell(5, 5),
				region: Region.parse(0),
			},
		]);
	});

	test("driver that accepts while on the pickup cell reports arrival on the next tick", () => {
		const random = scriptedRandom([5, 5]);
		const started = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0) },
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
				region: Region.parse(0),
			},
		]);
	});

	test("driver waiting at the pickup stays put without reporting arrival again", () => {
		const random = scriptedRandom([5, 4]);
		const started = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0) },
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
			{ grid, ...shard(i1, 1), tick: tick(0) },
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
			driversMoved(tick(2), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(1, 1) },
			]),
		]);
	});
});

describe("decideDriverShard confirming its trip", () => {
	// Driver starts next to the pickup (5, 5) and arrives on tick 1.
	function arrivedOnTick1(random: Random, dropoff = cell(8, 2)) {
		const started = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0) },
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

	// Ticks from..to inclusive, collecting every output.
	function runTicks(
		state: DriverShardState,
		from: number,
		to: number,
		random: Random,
	) {
		const outputs: unknown[] = [];
		let current = state;
		for (let n = from; n <= to; n++) {
			const decided = decideDriverShard(
				current,
				{ type: "clock.ticked", tick: tick(n) },
				random,
			);
			current = decided.state;
			outputs.push(...decided.outputs);
		}
		return { state: current, outputs };
	}

	test("driver waiting at the pickup confirms its trip on ticks 11 and 21 after arriving on tick 1", () => {
		const random = scriptedRandom([5, 4]);
		const { outputs } = runTicks(arrivedOnTick1(random), 2, 21, random);
		const confirm = {
			type: "confirm_trip",
			tripId: t1,
			driverId: d1,
			stage: "pickup",
			cell: cell(5, 5),
			region: Region.parse(0),
		};
		expect(outputs).toEqual([confirm, confirm]);
	});

	// Picked up on tick 2, one step from the dropoff (6, 5): arrives on tick 3.
	function arrivedAtDropoffOnTick3(random: Random) {
		const pickedUp = decideDriverShard(
			arrivedOnTick1(random, cell(6, 5)),
			{ type: "trip.picked_up", tick: tick(2), tripId: t1, driverId: d1 },
			random,
		);
		return runTicks(pickedUp.state, 3, 3, random).state;
	}

	test("driver waiting at the dropoff confirms its trip on ticks 13 and 23 after arriving on tick 3", () => {
		const random = scriptedRandom([5, 4]);
		const { outputs } = runTicks(
			arrivedAtDropoffOnTick3(random),
			4,
			23,
			random,
		);
		const confirm = {
			type: "confirm_trip",
			tripId: t1,
			driverId: d1,
			stage: "dropoff",
			cell: cell(6, 5),
			region: Region.parse(0),
		};
		expect(outputs).toEqual([confirm, confirm]);
	});

	test("driver at the pickup told its trip is picked up moves toward the dropoff", () => {
		const random = scriptedRandom([5, 4]);
		const told = decideDriverShard(
			arrivedOnTick1(random),
			{
				type: "trip_status",
				tripId: t1,
				driverId: d1,
				stage: "pickup",
				status: "picked_up",
			},
			random,
		);
		const { outputs } = runTicks(told.state, 12, 12, random);
		expect(outputs).toEqual([
			driversMoved(tick(12), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(6, 5) },
			]),
		]);
	});

	test("driver at the dropoff told its trip is completed goes back to wandering from the dropoff", () => {
		const random = scriptedRandom([5, 4, 6, 9]);
		const told = decideDriverShard(
			arrivedAtDropoffOnTick3(random),
			{
				type: "trip_status",
				tripId: t1,
				driverId: d1,
				stage: "dropoff",
				status: "completed",
			},
			random,
		);
		const { outputs } = runTicks(told.state, 14, 14, random);
		expect(outputs).toEqual([
			driversMoved(tick(14), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(6, 6) },
			]),
		]);
	});

	test("driver at the pickup told its trip is released goes back to wandering from the pickup", () => {
		const random = scriptedRandom([5, 4, 5, 9]);
		const told = decideDriverShard(
			arrivedOnTick1(random),
			{
				type: "trip_status",
				tripId: t1,
				driverId: d1,
				stage: "pickup",
				status: "released",
			},
			random,
		);
		const { outputs } = runTicks(told.state, 12, 12, random);
		expect(outputs).toEqual([
			driversMoved(tick(12), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(5, 6) },
			]),
		]);
	});

	test("driver at the dropoff told its trip is released goes back to wandering from the dropoff", () => {
		const random = scriptedRandom([5, 4, 6, 9]);
		const told = decideDriverShard(
			arrivedAtDropoffOnTick3(random),
			{
				type: "trip_status",
				tripId: t1,
				driverId: d1,
				stage: "dropoff",
				status: "released",
			},
			random,
		);
		const { outputs } = runTicks(told.state, 14, 14, random);
		expect(outputs).toEqual([
			driversMoved(tick(14), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(6, 6) },
			]),
		]);
	});

	// The reply's outputs, then tick n's: a driver still waiting since tick
	// n - 10 confirms again.
	function replyThenTick(
		state: DriverShardState,
		status: Omit<TripStatus, "type">,
		n: number,
		random: Random,
	) {
		const told = decideDriverShard(
			state,
			{ type: "trip_status", ...status },
			random,
		);
		const next = decideDriverShard(
			told.state,
			{ type: "clock.ticked", tick: tick(n) },
			random,
		);
		return [...told.outputs, ...next.outputs];
	}

	const pickupConfirm = {
		type: "confirm_trip",
		tripId: t1,
		driverId: d1,
		stage: "pickup",
		cell: cell(5, 5),
		region: Region.parse(0),
	} as const;

	test("driver at the pickup keeps waiting when another trip is released", () => {
		const random = scriptedRandom([5, 4]);
		const outputs = replyThenTick(
			arrivedOnTick1(random),
			{ tripId: t2, driverId: d1, stage: "pickup", status: "released" },
			11,
			random,
		);
		expect(outputs).toEqual([pickupConfirm]);
	});

	test("driver at the pickup keeps waiting when its trip is released at the dropoff stage", () => {
		const random = scriptedRandom([5, 4]);
		const outputs = replyThenTick(
			arrivedOnTick1(random),
			{ tripId: t1, driverId: d1, stage: "dropoff", status: "released" },
			11,
			random,
		);
		expect(outputs).toEqual([pickupConfirm]);
	});

	test("driver at the dropoff keeps waiting on a late picked up reply to its pickup confirm", () => {
		const random = scriptedRandom([5, 4]);
		const pickedUp = decideDriverShard(
			arrivedOnTick1(random, cell(6, 5)),
			{ type: "trip.picked_up", tick: tick(2), tripId: t1, driverId: d1 },
			random,
		);
		const arrived = decideDriverShard(
			pickedUp.state,
			{ type: "clock.ticked", tick: tick(3) },
			random,
		);
		const outputs = replyThenTick(
			arrived.state,
			{ tripId: t1, driverId: d1, stage: "pickup", status: "picked_up" },
			13,
			random,
		);
		expect(outputs).toEqual([
			{ ...pickupConfirm, stage: "dropoff", cell: cell(6, 5) },
		]);
	});

	test("driver carrying the rider keeps heading to the dropoff when its trip is released", () => {
		const random = scriptedRandom([5, 4]);
		const pickedUp = decideDriverShard(
			arrivedOnTick1(random),
			{ type: "trip.picked_up", tick: tick(2), tripId: t1, driverId: d1 },
			random,
		);
		const outputs = replyThenTick(
			pickedUp.state,
			{ tripId: t1, driverId: d1, stage: "pickup", status: "released" },
			11,
			random,
		);
		expect(outputs).toEqual([
			driversMoved(tick(11), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(6, 5) },
			]),
		]);
	});

	test("trip status for a driver outside the shard is ignored", () => {
		const random = scriptedRandom([5, 4]);
		const { outputs } = decideDriverShard(
			arrivedOnTick1(random),
			{
				type: "trip_status",
				tripId: t1,
				driverId: d2,
				stage: "pickup",
				status: "released",
			},
			random,
		);
		expect(outputs).toEqual([]);
	});
});

describe("decideDriverShard on offer", () => {
	test("idle driver accepts the offer", () => {
		const random = scriptedRandom([0, 0]);
		const { state } = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0) },
			random,
		);
		const { outputs } = decideDriverShard(state, offer(d1), random);
		expect(outputs).toEqual([
			{
				type: "offer_accepted",
				tripId: t1,
				driverId: d1,
				region: Region.parse(0),
			},
		]);
	});

	test("driver that accepts heads to the pickup instead of its wander target", () => {
		const random = scriptedRandom([0, 0, 9, 0]);
		const started = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0) },
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
			driversMoved(tick(2), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(1, 1) },
			]),
		]);
	});

	test("en route driver declines another offer", () => {
		const random = scriptedRandom([0, 0]);
		const started = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		const { outputs } = decideDriverShard(
			accepted.state,
			{ ...offer(d1), tripId: t2 },
			random,
		);
		expect(outputs).toEqual([
			{
				type: "offer_declined",
				tripId: t2,
				driverId: d1,
				region: Region.parse(0),
				idleAt: null,
			},
		]);
	});

	test("declining leaves the shard state unchanged", () => {
		const random = scriptedRandom([0, 0]);
		const started = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0) },
			random,
		);
		const accepted = decideDriverShard(started.state, offer(d1), random);
		// decide updates state in place (ADR 0033): compare with a snapshot.
		const before = structuredClone(accepted.state);
		const { state } = decideDriverShard(
			accepted.state,
			{ ...offer(d1), tripId: t2 },
			random,
		);
		expect(state).toEqual(before);
	});

	test("offer for a driver outside the shard is a bug", () => {
		const random = scriptedRandom([0, 0]);
		const { state } = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0) },
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
			{ grid, ...shard(i1, 1), tick: tick(0), preferences: picky },
			random,
		);
		return { state, random };
	}

	test("idle driver declines a pickup farther than its max pickup distance", () => {
		const { state, random } = pickyAtOrigin({ "preference:d-1": [9] });
		const { outputs } = decideDriverShard(state, offer(d1), random);
		expect(outputs).toEqual([
			{
				type: "offer_declined",
				tripId: t1,
				driverId: d1,
				region: Region.parse(0),
				idleAt: cell(0, 0),
			},
		]);
	});

	test("idle driver within range declines when the offer draw lands under the decline share", () => {
		const { state, random } = pickyAtOrigin({
			"preference:d-1": [10],
			"offer:t-1:d-1": [0.2],
		});
		const { outputs } = decideDriverShard(state, offer(d1), random);
		expect(outputs).toEqual([
			{
				type: "offer_declined",
				tripId: t1,
				driverId: d1,
				region: Region.parse(0),
				idleAt: cell(0, 0),
			},
		]);
	});

	test("idle driver within range accepts when the offer draw reaches the decline share", () => {
		const { state, random } = pickyAtOrigin({
			"preference:d-1": [12],
			"offer:t-1:d-1": [0.25],
		});
		const { outputs } = decideDriverShard(state, offer(d1), random);
		expect(outputs).toEqual([
			{
				type: "offer_accepted",
				tripId: t1,
				driverId: d1,
				region: Region.parse(0),
			},
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
			{
				type: "offer_declined",
				tripId: t2,
				driverId: d1,
				region: Region.parse(0),
				idleAt: null,
			},
		]);
	});
});

describe("decideDriverShard on trip ended", () => {
	test("driver whose trip is cancelled goes back to wandering", () => {
		const random = scriptedRandom([0, 0, 0, 3]);
		const started = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0) },
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
			driversMoved(tick(2), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(0, 1) },
			]),
		]);
	});

	test("driver waiting at the pickup goes back to wandering when its trip is cancelled", () => {
		const random = scriptedRandom([5, 4, 5, 9]);
		const started = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0) },
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
			driversMoved(tick(3), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(5, 6) },
			]),
		]);
	});

	test("driver that accepted an expired offer goes back to wandering", () => {
		const random = scriptedRandom([0, 0, 0, 3]);
		const started = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0) },
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
			driversMoved(tick(2), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(0, 1) },
			]),
		]);
	});

	test("driver keeps heading to its pickup when another trip of its ends", () => {
		const random = scriptedRandom([0, 0]);
		const started = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0) },
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
			driversMoved(tick(2), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(1, 0) },
			]),
		]);
	});

	test("driver keeps heading to its pickup when another driver's offer for the same trip expires", () => {
		const random = scriptedRandom([0, 0]);
		const started = startDriverShard(
			{ grid, ...shard(i2, 1), tick: tick(0) },
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
			driversMoved(tick(2), Region.parse(0), fleetSize, [
				{ driverIndex: i2, cell: cell(1, 0) },
			]),
		]);
	});
});

describe("decideDriverShard carrying the rider", () => {
	// Driver starts next to the pickup (5, 5) and arrives on tick 1.
	function waitingAtPickup(random: Random, dropoff = cell(8, 2)) {
		const started = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0) },
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
			driversMoved(tick(3), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(6, 5) },
			]),
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
			driversMoved(tick(3), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(6, 5) },
			]),
			{
				type: "driver.arrived_at_dropoff",
				tick: tick(3),
				driverId: d1,
				tripId: t1,
				cell: cell(6, 5),
				region: Region.parse(0),
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
				region: Region.parse(0),
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
		const before = structuredClone(pickedUp.state);
		expect(decideDriverShard(pickedUp.state, cancelled, random)).toEqual({
			state: before,
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
		const before = structuredClone(pickedUp.state);
		const cancelled = decideDriverShard(
			pickedUp.state,
			{ type: "trip.cancelled", tick: tick(3), tripId: t2, driverId: d1 },
			random,
		);
		expect(cancelled).toEqual({ state: before, outputs: [] });
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
		const before = structuredClone(arrived.state);
		expect(decideDriverShard(arrived.state, expired, random)).toEqual({
			state: before,
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
			driversMoved(tick(5), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(6, 6) },
			]),
		]);
	});
});

describe("decideDriverShard rejecting inputs", () => {
	test("pickup for a driver still heading to the pickup is rejected", () => {
		const random = scriptedRandom([0, 0]);
		const started = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0) },
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
			{ grid, ...shard(i1, 1), tick: tick(0) },
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
			{ grid, ...shard(i1, 1), tick: tick(0) },
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
			{ grid, ...shard(i1, 1), tick: tick(0) },
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
			{ grid, ...shard(i1, 1), tick: tick(0) },
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
			{ grid, ...shard(i1, 1), tick: tick(0) },
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
		const moved = (n: number, x: number, y: number) =>
			driversMoved(tick(n), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(x, y) },
			]);
		expect(outputs).toEqual([
			{
				type: "offer_accepted",
				tripId: t1,
				driverId: d1,
				region: Region.parse(0),
			},
			moved(1, 4, 5),
			moved(2, 5, 5),
			{
				type: "driver.arrived_at_pickup",
				tick: tick(2),
				driverId: d1,
				tripId: t1,
				cell: cell(5, 5),
				region: Region.parse(0),
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
				region: Region.parse(0),
			},
			moved(11, 8, 3),
		]);
	});
});

// ADR 0050. 2x1 on the 10 x 10 grid: x 0-4 region 0, x 5-9 region 1.
describe("decideDriverShard regions", () => {
	const regions = RegionLayout.parse("2x1");
	const region0 = Region.parse(0);
	const region1 = Region.parse(1);

	function startAt(cells: [number, number][], random?: Random) {
		return startDriverShard(
			{ grid, ...shard(i1, cells.length), tick: tick(0), regions },
			random ?? scriptedRandom(cells.flat()),
		);
	}

	function feed(state: DriverShardState, inputs: DriverShardInput[]) {
		const random = scriptedRandom([]);
		const outputs: unknown[] = [];
		for (const input of inputs) {
			const decided = decideDriverShard(state, input, random);
			state = decided.state;
			outputs.push(...decided.outputs);
		}
		return outputs;
	}

	// Picks up at (5, 5) in region 1, drops off at (4, 5) in region 0.
	const crossingOffer: Offer = { ...offer(d1), dropoff: cell(4, 5) };

	test("drivers go online in one message per region, regions in index order", () => {
		expect(
			startAt([
				[6, 0],
				[1, 0],
			]).outputs,
		).toEqual([
			driversWentOnline(tick(0), region0, fleetSize, [
				{ driverIndex: i2, cell: cell(1, 0) },
			]),
			driversWentOnline(tick(0), region1, fleetSize, [
				{ driverIndex: i1, cell: cell(6, 0) },
			]),
		]);
	});

	test("an idle driver's move goes to the region of the cell it moved from", () => {
		const { state } = startAt([
			[4, 0],
			[5, 0],
		]);
		// Wander targets: d-1 (9, 0), d-2 (0, 0): both cross the border.
		const { outputs } = decideDriverShard(
			state,
			{ type: "clock.ticked", tick: tick(1) },
			scriptedRandom([9, 0, 0, 0]),
		);
		expect(outputs).toEqual([
			driversMoved(tick(1), region0, fleetSize, [
				{ driverIndex: i1, cell: cell(5, 0) },
			]),
			driversMoved(tick(1), region1, fleetSize, [
				{ driverIndex: i2, cell: cell(4, 0) },
			]),
		]);
	});

	test("an idle driver that crossed the border moves in its new region", () => {
		const { state } = startAt([[4, 0]]);
		// Wander target (9, 0).
		const random = scriptedRandom([9, 0]);
		const first = decideDriverShard(
			state,
			{ type: "clock.ticked", tick: tick(1) },
			random,
		);
		const { outputs } = decideDriverShard(
			first.state,
			{ type: "clock.ticked", tick: tick(2) },
			random,
		);
		expect(outputs).toEqual([
			driversMoved(tick(2), region1, fleetSize, [
				{ driverIndex: i1, cell: cell(6, 0) },
			]),
		]);
	});

	test("a driver carrying a rider across the border moves in its trip's region", () => {
		const { state } = startAt([[5, 5]]);
		const outputs = feed(state, [
			crossingOffer,
			{ type: "clock.ticked", tick: tick(1) },
			{ type: "trip.picked_up", tick: tick(1), tripId: t1, driverId: d1 },
			{ type: "clock.ticked", tick: tick(2) },
		]);
		expect(outputs).toContainEqual(
			driversMoved(tick(2), region1, fleetSize, [
				{ driverIndex: i1, cell: cell(4, 5) },
			]),
		);
	});

	test("a driver accepts an offer in its pickup's region", () => {
		const { state } = startAt([[6, 1]]);
		expect(feed(state, [offer(d1)])).toEqual([
			{ type: "offer_accepted", tripId: t1, driverId: d1, region: region1 },
		]);
	});

	test("a driver reports arrivals in its trip's region, even at a dropoff in another", () => {
		const { state } = startAt([[5, 5]]);
		const outputs = feed(state, [
			crossingOffer,
			{ type: "clock.ticked", tick: tick(1) },
			{ type: "trip.picked_up", tick: tick(1), tripId: t1, driverId: d1 },
			{ type: "clock.ticked", tick: tick(2) },
		]);
		expect(
			outputs.filter(
				(output) =>
					typeof output === "object" &&
					output !== null &&
					"type" in output &&
					String(output.type).startsWith("driver.arrived"),
			),
		).toEqual([
			{
				type: "driver.arrived_at_pickup",
				tick: tick(1),
				driverId: d1,
				tripId: t1,
				cell: cell(5, 5),
				region: region1,
			},
			{
				type: "driver.arrived_at_dropoff",
				tick: tick(2),
				driverId: d1,
				tripId: t1,
				cell: cell(4, 5),
				region: region1,
			},
		]);
	});

	test("a driver waiting at a dropoff in another region confirms in its trip's region", () => {
		const { state } = startAt([[5, 5]]);
		const outputs = feed(state, [
			crossingOffer,
			{ type: "clock.ticked", tick: tick(1) },
			{ type: "trip.picked_up", tick: tick(1), tripId: t1, driverId: d1 },
			{ type: "clock.ticked", tick: tick(2) },
			{ type: "clock.ticked", tick: tick(12) },
		]);
		expect(outputs.at(-1)).toEqual({
			type: "confirm_trip",
			tripId: t1,
			driverId: d1,
			stage: "dropoff",
			cell: cell(4, 5),
			region: region1,
		});
	});

	test("an idle driver declines in the offer's region, telling its cell", () => {
		const random = shiftRandom([8, 8], { "preference:d-1": [2] });
		const { state } = startDriverShard(
			{
				grid,
				...shard(i1, 1),
				tick: tick(0),
				regions,
				preferences: {
					type: "picky",
					maxPickupDistance: { min: 2, max: 2 },
					declineShare: 0,
				},
			},
			random,
		);
		const { outputs } = decideDriverShard(state, offer(d1), random);
		expect(outputs).toEqual([
			{
				type: "offer_declined",
				tripId: t1,
				driverId: d1,
				region: region1,
				idleAt: cell(8, 8),
			},
		]);
	});

	test("an idle driver declines an offer from a region other than its cell's, telling its cell", () => {
		const { state } = startAt([[4, 5]]);
		expect(feed(state, [offer(d1)])).toEqual([
			{
				type: "offer_declined",
				tripId: t1,
				driverId: d1,
				region: region1,
				idleAt: cell(4, 5),
			},
		]);
	});

	test("a driver that crossed into the pickup's region accepts its offer", () => {
		const { state } = startAt([[4, 5]]);
		// Wander target (9, 5).
		const { state: crossed } = decideDriverShard(
			state,
			{ type: "clock.ticked", tick: tick(1) },
			scriptedRandom([9, 5]),
		);
		expect(feed(crossed, [offer(d1)])).toEqual([
			{ type: "offer_accepted", tripId: t1, driverId: d1, region: region1 },
		]);
	});

	test("a driver on a trip declines another offer without a cell", () => {
		const { state } = startAt([[6, 1]]);
		const outputs = feed(state, [
			offer(d1),
			{ ...offer(d1), tripId: t2, pickup: cell(0, 9) },
		]);
		expect(outputs.at(-1)).toEqual({
			type: "offer_declined",
			tripId: t2,
			driverId: d1,
			region: region0,
			idleAt: null,
		});
	});

	test("a driver goes offline in its cell's region", () => {
		const random = shiftRandom([6, 0, 9, 0], {
			"shift:d-1:0": [0.2, 2],
			"shift:d-1:1": [3],
		});
		const { state } = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0), regions, shifts },
			random,
		);
		const outputs: unknown[] = [];
		let current = state;
		for (const n of [1, 2]) {
			const decided = decideDriverShard(
				current,
				{ type: "clock.ticked", tick: tick(n) },
				random,
			);
			current = decided.state;
			outputs.push(...decided.outputs);
		}
		expect(outputs.at(-1)).toEqual({
			type: "driver.went_offline",
			tick: tick(2),
			driverId: d1,
			cell: cell(7, 0),
			region: region1,
		});
	});
});

// 2x2 on the 10 x 10 grid: region 0 top left, 1 top right, 2 bottom left,
// 3 bottom right.
describe("decideDriverShard 2x2 regions", () => {
	const regions = RegionLayout.parse("2x2");

	test("idle drivers crossing row and column borders move in the regions they left", () => {
		const { state } = startDriverShard(
			{ grid, ...shard(i1, 2), tick: tick(0), regions },
			scriptedRandom([4, 9, 9, 4]),
		);
		// Wander targets (9, 9): d-1 steps along x, d-2 along y, both into 3.
		const { outputs } = decideDriverShard(
			state,
			{ type: "clock.ticked", tick: tick(1) },
			scriptedRandom([9, 9, 9, 9]),
		);
		expect(outputs).toEqual([
			driversMoved(tick(1), Region.parse(1), fleetSize, [
				{ driverIndex: i2, cell: cell(9, 5) },
			]),
			driversMoved(tick(1), Region.parse(2), fleetSize, [
				{ driverIndex: i1, cell: cell(5, 9) },
			]),
		]);
	});
});

describe("driver shard determinism", () => {
	function run(seed: number, shifts?: Shifts) {
		const random = createRandom(seed);
		const started = startDriverShard(
			{ grid, ...shard(i1, 2), tick: tick(0), shifts },
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

// ADR 0055. 300 x 100 cells: surge zones 0-5 on the top row, 6-11 below.
describe("decideDriverShard chasing surge", () => {
	const surgeGrid: Grid = { width: 300, height: 100 };
	const region0 = Region.parse(0);

	function at(x: number, y: number): Cell {
		const result = cellIn(surgeGrid, x, y);
		if (!result.ok) throw new Error(`test cell (${x}, ${y}) outside grid`);
		return result.value;
	}

	function priced(
		zones: [number, number][],
		region: Region = region0,
	): DriverShardInput {
		return {
			type: "zones.priced",
			tick: tick(0),
			region,
			zones: zones.map(([zone, surge]) => ({
				zone: Zone.parse(zone),
				surge: Surge.parse(surge),
			})),
		};
	}

	// Drivers d-1, d-2, ... idle at cells, given prices, then ticked once on
	// tick 5 with random.
	function tickedWithPrices(
		cells: [number, number][],
		prices: DriverShardInput[],
		random: Random,
		regions?: RegionLayout,
	) {
		let { state } = startDriverShard(
			{
				grid: surgeGrid,
				...shard(i1, cells.length),
				tick: tick(0),
				regions,
			},
			scriptedRandom(cells.flat()),
		);
		for (const input of prices) {
			state = decideDriverShard(state, input, scriptedRandom([])).state;
		}
		return decideDriverShard(
			state,
			{ type: "clock.ticked", tick: tick(5) },
			random,
		).outputs;
	}

	test("an idle driver picking a target heads for a cell of the nearest surge area in reach", () => {
		// d-1 in zone 6 (column 0, row 1): zones 2 and 9 are 3 zones away,
		// zone 8 (cells 100-149, 50-99) 2: target (120, 60).
		const outputs = tickedWithPrices(
			[[10, 60]],
			[
				priced([
					[2, 2],
					[8, 1.3],
					[9, 1.2],
				]),
			],
			shiftRandom([], { "chase:5": [120, 60] }),
		);
		expect(outputs).toEqual([
			driversMoved(tick(5), region0, fleetSize, [
				{ driverIndex: i1, cell: at(11, 60) },
			]),
		]);
	});

	test("an idle driver with no surge area in reach wanders to a random cell", () => {
		// d-1 in zone 0; zone 11 is 6 zones away. Wander target (0, 99).
		const outputs = tickedWithPrices(
			[[0, 0]],
			[priced([[11, 2]])],
			scriptedRandom([0, 99]),
		);
		expect(outputs).toEqual([
			driversMoved(tick(5), region0, fleetSize, [
				{ driverIndex: i1, cell: at(0, 1) },
			]),
		]);
	});

	test("a surge area 4 zones away is in reach", () => {
		// d-1 in zone 0; zone 10 (cells 200-249, 50-99) is 4 + 1 = 5 away, zone
		// 4 (200-249, 0-49) 4.
		const outputs = tickedWithPrices(
			[[0, 0]],
			[
				priced([
					[4, 1.1],
					[10, 2],
				]),
			],
			shiftRandom([], { "chase:5": [200, 0] }),
		);
		expect(outputs).toEqual([
			driversMoved(tick(5), region0, fleetSize, [
				{ driverIndex: i1, cell: at(1, 0) },
			]),
		]);
	});

	test("of surge areas equally near, a driver heads for the higher surge", () => {
		// d-1 in zone 7: zones 6 and 8 1 away, 8 (100-149, 50-99) higher.
		const outputs = tickedWithPrices(
			[[75, 75]],
			[
				priced([
					[6, 1.5],
					[8, 1.6],
				]),
			],
			shiftRandom([], { "chase:5": [100, 75] }),
		);
		expect(outputs).toEqual([
			driversMoved(tick(5), region0, fleetSize, [
				{ driverIndex: i1, cell: at(76, 75) },
			]),
		]);
	});

	test("of surge areas equally near and surging, a driver heads for the lower zone", () => {
		// d-1 in zone 7: zones 1 (50-99, 0-49) and 8 1 away, same surge.
		const outputs = tickedWithPrices(
			[[75, 75]],
			[
				priced([
					[1, 1.5],
					[8, 1.5],
				]),
			],
			shiftRandom([], { "chase:5": [75, 49] }),
		);
		expect(outputs).toEqual([
			driversMoved(tick(5), region0, fleetSize, [
				{ driverIndex: i1, cell: at(75, 74) },
			]),
		]);
	});

	test("an idle driver in a surging zone picks its next cell in that zone", () => {
		// d-1 in zone 7, surging less than zone 8 next to it.
		const outputs = tickedWithPrices(
			[[75, 75]],
			[
				priced([
					[7, 1.1],
					[8, 2],
				]),
			],
			shiftRandom([], { "chase:5": [50, 75] }),
		);
		expect(outputs).toEqual([
			driversMoved(tick(5), region0, fleetSize, [
				{ driverIndex: i1, cell: at(74, 75) },
			]),
		]);
	});

	// 3x1 regions: borders at x = 100 and 200, inside no zone; 6x1 would cut
	// none either, so 4x1 on a 300-cell grid: borders at 75, 150, 225 cut
	// zones 1 and 4 (and 7, 10).
	describe("with a zone cut by a region border", () => {
		const regions = RegionLayout.parse("4x1");

		test("a driver heads for the cut zone's part in the lower region on equal surge", () => {
			// d-1 in zone 0; zone 1 priced by regions 0 (50-74) and 1 (75-99).
			const outputs = tickedWithPrices(
				[[10, 10]],
				[priced([[1, 1.5]], Region.parse(1)), priced([[1, 1.5]])],
				shiftRandom([], { "chase:5": [74, 10] }),
				regions,
			);
			expect(outputs).toEqual([
				driversMoved(tick(5), region0, fleetSize, [
					{ driverIndex: i1, cell: at(11, 10) },
				]),
			]);
		});

		test("a driver heads for the cut zone's part that surges higher", () => {
			const outputs = tickedWithPrices(
				[[10, 10]],
				[priced([[1, 1.5]]), priced([[1, 1.6]], Region.parse(1))],
				shiftRandom([], { "chase:5": [75, 10] }),
				regions,
			);
			expect(outputs).toEqual([
				driversMoved(tick(5), region0, fleetSize, [
					{ driverIndex: i1, cell: at(11, 10) },
				]),
			]);
		});
	});

	test("drivers chasing in one tick draw their cells in turn from the tick's chase stream", () => {
		// d-1 and d-2 in zone 0, zone 1 surging: targets (50, 0) and (99, 49).
		const outputs = tickedWithPrices(
			[
				[0, 0],
				[49, 49],
			],
			[priced([[1, 1.5]])],
			shiftRandom([], { "chase:5": [50, 0, 99, 49] }),
		);
		expect(outputs).toEqual([
			driversMoved(tick(5), region0, fleetSize, [
				{ driverIndex: i1, cell: at(1, 0) },
				{ driverIndex: i2, cell: at(50, 49) },
			]),
		]);
	});

	// d-1 starts at a cell, then takes each input with its random; the last
	// input's outputs.
	function fed(start: [number, number], steps: [DriverShardInput, Random][]) {
		let { state } = startDriverShard(
			{ grid: surgeGrid, ...shard(i1, 1), tick: tick(0) },
			scriptedRandom(start),
		);
		let outputs: unknown[] = [];
		for (const [input, random] of steps) {
			const decided = decideDriverShard(state, input, random);
			state = decided.state;
			outputs = decided.outputs;
		}
		return outputs;
	}

	const ticked = (n: number): DriverShardInput => ({
		type: "clock.ticked",
		tick: tick(n),
	});
	const noDraws = () => scriptedRandom([]);

	test("on the tick after new prices, an idle driver heading outside any surge area chases", () => {
		// Tick 1: wander target (0, 99), d-1 at (0, 1). Zone 1 surges: on tick
		// 2 d-1 heads for (99, 1) instead.
		const outputs = fed(
			[0, 0],
			[
				[ticked(1), scriptedRandom([0, 99])],
				[priced([[1, 1.5]]), noDraws()],
				[ticked(2), shiftRandom([], { "chase:2": [99, 1] })],
			],
		);
		expect(outputs).toEqual([
			driversMoved(tick(2), region0, fleetSize, [
				{ driverIndex: i1, cell: at(1, 1) },
			]),
		]);
	});

	test("on the tick after new prices, an idle driver heading into a surge area keeps its target", () => {
		// Tick 1: wander target (60, 10) in zone 1, which then surges.
		const outputs = fed(
			[0, 0],
			[
				[ticked(1), scriptedRandom([60, 10])],
				[priced([[1, 1.5]]), noDraws()],
				[ticked(2), noDraws()],
			],
		);
		expect(outputs).toEqual([
			driversMoved(tick(2), region0, fleetSize, [
				{ driverIndex: i1, cell: at(2, 0) },
			]),
		]);
	});

	test("on the tick after new prices, an idle driver with no surge area in reach keeps its target", () => {
		const outputs = fed(
			[0, 0],
			[
				[ticked(1), scriptedRandom([0, 99])],
				[priced([[5, 1.5]]), noDraws()],
				[ticked(2), noDraws()],
			],
		);
		expect(outputs).toEqual([
			driversMoved(tick(2), region0, fleetSize, [
				{ driverIndex: i1, cell: at(0, 2) },
			]),
		]);
	});

	test("an idle driver coming into reach of surge later keeps its target until new prices", () => {
		// Zone 11 surges, out of reach from zone 1 (5 zones); d-1 heading for
		// (50, 99) enters zone 7 (4 zones) on tick 3 and keeps going.
		const outputs = fed(
			[50, 47],
			[
				[ticked(1), scriptedRandom([50, 99])],
				[priced([[11, 1.5]]), noDraws()],
				[ticked(2), noDraws()],
				[ticked(3), noDraws()],
				[ticked(4), noDraws()],
			],
		);
		expect(outputs).toEqual([
			driversMoved(tick(4), region0, fleetSize, [
				{ driverIndex: i1, cell: at(50, 51) },
			]),
		]);
	});

	test("prices equal to the last still re-pick targets on the next tick", () => {
		// Zone 11 surges; d-1 comes into reach on tick 3 (see above), then the
		// same prices arrive again: on tick 4 it heads for (250, 99).
		const outputs = fed(
			[50, 47],
			[
				[ticked(1), scriptedRandom([50, 99])],
				[priced([[11, 1.5]]), noDraws()],
				[ticked(2), noDraws()],
				[ticked(3), noDraws()],
				[priced([[11, 1.5]]), noDraws()],
				[ticked(4), shiftRandom([], { "chase:4": [250, 99] })],
			],
		);
		expect(outputs).toEqual([
			driversMoved(tick(4), region0, fleetSize, [
				{ driverIndex: i1, cell: at(51, 50) },
			]),
		]);
	});

	test("same seed, inputs and prices give identical outputs", () => {
		function run() {
			const random = createRandom(42);
			let { state } = startDriverShard(
				{ grid: surgeGrid, ...shard(i1, 2), tick: tick(0) },
				random,
			);
			const outputs: unknown[] = [];
			for (let n = 1; n <= 60; n++) {
				if (n % 30 === 1) {
					state = decideDriverShard(
						state,
						priced([[n % 12, 1.5]]),
						random,
					).state;
				}
				const decided = decideDriverShard(state, ticked(n), random);
				state = decided.state;
				outputs.push(...decided.outputs);
			}
			return outputs;
		}
		expect(run()).toEqual(run());
	});

	test("a chase leaves other drivers' wander draws unshifted", () => {
		// d-1 in zone 6 chases zone 7 at (50, 50); d-2 in zone 5, out of reach,
		// draws wander target (299, 0) from the shard's stream.
		const outputs = tickedWithPrices(
			[
				[0, 50],
				[299, 49],
			],
			[priced([[7, 1.5]])],
			shiftRandom([299, 0], { "chase:5": [50, 50] }),
		);
		expect(outputs).toEqual([
			driversMoved(tick(5), region0, fleetSize, [
				{ driverIndex: i1, cell: at(1, 50) },
				{ driverIndex: i2, cell: at(299, 48) },
			]),
		]);
	});
});

// ADR 0056. d-1 starts at (0, 0) holding pooled trip t-1, (5, 5) to (8, 2).
describe("decideDriverShard taking a second rider", () => {
	function pooledOffer(tripId: TripId, pickup: Cell, dropoff: Cell): Offer {
		return {
			type: "offer",
			tripId,
			driverId: d1,
			pickup,
			dropoff,
			pooled: true,
		};
	}
	const firstOffer = pooledOffer(t1, cell(5, 5), cell(8, 2));

	function holdingPooledTrip(random: Random) {
		const { state } = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0) },
			random,
		);
		return decideDriverShard(state, firstOffer, random).state;
	}

	test("driver heading to a pooled trip's pickup accepts a pooled offer", () => {
		const random = scriptedRandom([0, 0]);
		const { outputs } = decideDriverShard(
			holdingPooledTrip(random),
			pooledOffer(t2, cell(6, 5), cell(9, 2)),
			random,
		);
		expect(outputs).toEqual([
			{
				type: "offer_accepted",
				tripId: t2,
				driverId: d1,
				region: Region.parse(0),
			},
		]);
	});

	const secondOffer = pooledOffer(t2, cell(6, 5), cell(9, 2));
	const t3 = TripId.parse("t-3");
	const declinedSecond = {
		type: "offer_declined" as const,
		tripId: t2,
		driverId: d1,
		region: Region.parse(0),
		idleAt: null,
	};

	test("driver holding a pooled trip declines an offer that is not pooled", () => {
		const random = scriptedRandom([0, 0]);
		const { pooled: _, ...notPooled } = secondOffer;
		const { outputs } = decideDriverShard(
			holdingPooledTrip(random),
			notPooled,
			random,
		);
		expect(outputs).toEqual([declinedSecond]);
	});

	test("driver holding a trip that is not pooled declines a pooled offer", () => {
		const random = scriptedRandom([0, 0]);
		const { state } = startDriverShard(
			{ grid, ...shard(i1, 1), tick: tick(0) },
			random,
		);
		const { pooled: _, ...notPooled } = firstOffer;
		const holding = decideDriverShard(state, notPooled, random).state;
		const { outputs } = decideDriverShard(holding, secondOffer, random);
		expect(outputs).toEqual([declinedSecond]);
	});

	test("driver holding two pooled trips declines a third", () => {
		const random = scriptedRandom([0, 0]);
		const holdingTwo = decideDriverShard(
			holdingPooledTrip(random),
			secondOffer,
			random,
		).state;
		const { outputs } = decideDriverShard(
			holdingTwo,
			pooledOffer(t3, cell(7, 5), cell(9, 3)),
			random,
		);
		expect(outputs).toEqual([{ ...declinedSecond, tripId: t3 }]);
	});

	test("driver holding a pooled trip declines a pooled offer from another region", () => {
		// 2x1: x 0-4 is region 0, x 5-9 region 1.
		const random = scriptedRandom([0, 0]);
		const { state } = startDriverShard(
			{
				grid,
				...shard(i1, 1),
				tick: tick(0),
				regions: RegionLayout.parse("2x1"),
			},
			random,
		);
		const holding = decideDriverShard(
			state,
			pooledOffer(t1, cell(2, 2), cell(4, 4)),
			random,
		).state;
		const { outputs } = decideDriverShard(holding, secondOffer, random);
		expect(outputs).toEqual([{ ...declinedSecond, region: Region.parse(1) }]);
	});

	// Ticks from..to, feeding each tick's scheduled inputs first and answering
	// each arrival as dispatch would (trip.picked_up, trip.completed), except
	// arrivals at unanswered stops ("<stop>:<tripId>"). Arrivals in order.
	function serve(
		state: DriverShardState,
		random: Random,
		ticks: { from: number; to: number },
		scheduled: Record<number, DriverShardInput[]> = {},
		unanswered: string[] = [],
	) {
		const arrivals: { stop: string; tripId: TripId; cell: Cell }[] = [];
		const outputs: unknown[] = [];
		const feed = (input: DriverShardInput) => {
			const decided = decideDriverShard(state, input, random);
			state = decided.state;
			outputs.push(...decided.outputs);
			return decided.outputs;
		};
		for (let n = ticks.from; n <= ticks.to; n++) {
			for (const input of scheduled[n] ?? []) feed(input);
			for (const output of feed({ type: "clock.ticked", tick: tick(n) })) {
				if (output.type === "driver.arrived_at_pickup") {
					arrivals.push({ stop: "pickup", ...output });
					if (unanswered.includes(`pickup:${output.tripId}`)) continue;
					feed({
						type: "trip.picked_up",
						tick: tick(n),
						tripId: output.tripId,
						driverId: d1,
					});
				}
				if (output.type === "driver.arrived_at_dropoff") {
					arrivals.push({ stop: "dropoff", ...output });
					if (unanswered.includes(`dropoff:${output.tripId}`)) continue;
					feed({
						type: "trip.completed",
						tick: tick(n),
						tripId: output.tripId,
						driverId: d1,
					});
				}
			}
		}
		return {
			state,
			outputs,
			arrivals: arrivals.map(({ stop, tripId, cell }) => ({
				stop,
				tripId,
				cell,
			})),
		};
	}

	test("driver joined before its partner's pickup picks both up, then drops the partner first when its dropoff is nearer the joining pickup", () => {
		// From (6, 5): t-1's dropoff (8, 2) is 5 away, t-2's (9, 2) 6.
		const random = scriptedRandom([0, 0, 0, 0]);
		const joined = decideDriverShard(
			holdingPooledTrip(random),
			secondOffer,
			random,
		).state;
		const { arrivals } = serve(joined, random, { from: 1, to: 20 });
		expect(arrivals).toEqual([
			{ stop: "pickup", tripId: t1, cell: cell(5, 5) },
			{ stop: "pickup", tripId: t2, cell: cell(6, 5) },
			{ stop: "dropoff", tripId: t1, cell: cell(8, 2) },
			{ stop: "dropoff", tripId: t2, cell: cell(9, 2) },
		]);
	});

	test("driver joined before its partner's pickup drops the joining rider first when its dropoff is nearer the joining pickup", () => {
		// From (6, 5): t-2's dropoff (7, 4) is 2 away, t-1's (8, 2) 5.
		const random = scriptedRandom([0, 0, 0, 0]);
		const joined = decideDriverShard(
			holdingPooledTrip(random),
			pooledOffer(t2, cell(6, 5), cell(7, 4)),
			random,
		).state;
		const { arrivals } = serve(joined, random, { from: 1, to: 20 });
		expect(arrivals).toEqual([
			{ stop: "pickup", tripId: t1, cell: cell(5, 5) },
			{ stop: "pickup", tripId: t2, cell: cell(6, 5) },
			{ stop: "dropoff", tripId: t2, cell: cell(7, 4) },
			{ stop: "dropoff", tripId: t1, cell: cell(8, 2) },
		]);
	});

	test("driver joined while carrying its partner picks the joining rider up, then drops off in the same order", () => {
		// t-1 picked up at (5, 5) on tick 10; joined before tick 11.
		const random = scriptedRandom([0, 0, 0, 0]);
		const { arrivals } = serve(
			holdingPooledTrip(random),
			random,
			{ from: 1, to: 25 },
			{ 11: [pooledOffer(t2, cell(6, 5), cell(7, 4))] },
		);
		expect(arrivals).toEqual([
			{ stop: "pickup", tripId: t1, cell: cell(5, 5) },
			{ stop: "pickup", tripId: t2, cell: cell(6, 5) },
			{ stop: "dropoff", tripId: t2, cell: cell(7, 4) },
			{ stop: "dropoff", tripId: t1, cell: cell(8, 2) },
		]);
	});

	test("driver joined while waiting at its partner's dropoff drops the partner there, then serves the joining trip", () => {
		// t-1's dropoff reached on tick 16, completed before tick 18.
		const random = scriptedRandom([0, 0, 0, 0]);
		const { arrivals } = serve(
			holdingPooledTrip(random),
			random,
			{ from: 1, to: 30 },
			{
				17: [pooledOffer(t2, cell(6, 5), cell(7, 4))],
				18: [
					{ type: "trip.completed", tick: tick(17), tripId: t1, driverId: d1 },
				],
			},
			["dropoff:t-1"],
		);
		expect(arrivals).toEqual([
			{ stop: "pickup", tripId: t1, cell: cell(5, 5) },
			{ stop: "dropoff", tripId: t1, cell: cell(8, 2) },
			{ stop: "pickup", tripId: t2, cell: cell(6, 5) },
			{ stop: "dropoff", tripId: t2, cell: cell(7, 4) },
		]);
	});

	function joinedBeforePickups(random: Random) {
		return decideDriverShard(holdingPooledTrip(random), secondOffer, random)
			.state;
	}

	test("driver whose partner trip is cancelled before pickup serves the joined trip alone", () => {
		const random = scriptedRandom([0, 0, 0, 0]);
		const { arrivals } = serve(
			joinedBeforePickups(random),
			random,
			{ from: 1, to: 20 },
			{
				1: [
					{ type: "trip.cancelled", tick: tick(0), tripId: t1, driverId: d1 },
				],
			},
		);
		expect(arrivals).toEqual([
			{ stop: "pickup", tripId: t2, cell: cell(6, 5) },
			{ stop: "dropoff", tripId: t2, cell: cell(9, 2) },
		]);
	});

	test("driver whose joined trip is cancelled before pickup serves its partner trip alone", () => {
		const random = scriptedRandom([0, 0, 0, 0]);
		const { arrivals } = serve(
			joinedBeforePickups(random),
			random,
			{ from: 1, to: 20 },
			{
				1: [
					{ type: "trip.cancelled", tick: tick(0), tripId: t2, driverId: d1 },
				],
			},
		);
		expect(arrivals).toEqual([
			{ stop: "pickup", tripId: t1, cell: cell(5, 5) },
			{ stop: "dropoff", tripId: t1, cell: cell(8, 2) },
		]);
	});

	test("driver carrying its partner whose joined offer expires goes on to the partner's dropoff", () => {
		// t-1 picked up on tick 10; joined before tick 11, pickup (5, 8) 3
		// ticks away, expired before 12.
		const random = scriptedRandom([0, 0, 0, 0]);
		const { arrivals } = serve(
			holdingPooledTrip(random),
			random,
			{ from: 1, to: 25 },
			{
				11: [pooledOffer(t2, cell(5, 8), cell(8, 5))],
				12: [
					{
						type: "trip.offer_expired",
						tick: tick(11),
						tripId: t2,
						driverId: d1,
					},
				],
			},
		);
		expect(arrivals).toEqual([
			{ stop: "pickup", tripId: t1, cell: cell(5, 5) },
			{ stop: "dropoff", tripId: t1, cell: cell(8, 2) },
		]);
	});

	test("cancellation of the partner trip a driver is carrying is rejected while it heads to the joined pickup", () => {
		// t-1 picked up on tick 10; joined before tick 11, now heading to (6, 5).
		const random = scriptedRandom([0, 0, 0, 0]);
		const { state } = serve(
			holdingPooledTrip(random),
			random,
			{ from: 1, to: 10 },
			{},
		);
		const heading = decideDriverShard(state, secondOffer, random).state;
		const cancelled = {
			type: "trip.cancelled" as const,
			tick: tick(10),
			tripId: t1,
			driverId: d1,
		};
		const { outputs } = decideDriverShard(heading, cancelled, random);
		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "trip_already_picked_up",
				input: cancelled,
			},
		]);
	});

	function status(
		tripId: TripId,
		stage: TripStatus["stage"],
		status: TripStatus["status"],
	): TripStatus {
		return { type: "trip_status", tripId, driverId: d1, stage, status };
	}

	// t-1 picked up on tick 10; waiting at t-2's pickup (6, 5) from tick 11.
	function waitingAtJoinedPickup(random: Random) {
		return serve(joinedBeforePickups(random), random, { from: 1, to: 11 }, {}, [
			"pickup:t-2",
		]).state;
	}

	test("driver waiting at the joined pickup confirms the joined trip's pickup", () => {
		const random = scriptedRandom([0, 0]);
		const { outputs } = serve(waitingAtJoinedPickup(random), random, {
			from: 12,
			to: 21,
		});
		expect(outputs).toEqual([
			{
				type: "confirm_trip",
				tripId: t2,
				driverId: d1,
				stage: "pickup",
				cell: cell(6, 5),
				region: Region.parse(0),
			},
		]);
	});

	test("driver at the joined pickup told the joined trip is picked up goes on to the first dropoff", () => {
		const random = scriptedRandom([0, 0, 0, 0]);
		const { arrivals } = serve(
			waitingAtJoinedPickup(random),
			random,
			{ from: 12, to: 25 },
			{ 12: [status(t2, "pickup", "picked_up")] },
		);
		expect(arrivals).toEqual([
			{ stop: "dropoff", tripId: t1, cell: cell(8, 2) },
			{ stop: "dropoff", tripId: t2, cell: cell(9, 2) },
		]);
	});

	test("driver at the joined pickup told the joined trip is released goes on to its partner's dropoff alone", () => {
		const random = scriptedRandom([0, 0, 0, 0]);
		const { arrivals } = serve(
			waitingAtJoinedPickup(random),
			random,
			{ from: 12, to: 25 },
			{ 12: [status(t2, "pickup", "released")] },
		);
		expect(arrivals).toEqual([
			{ stop: "dropoff", tripId: t1, cell: cell(8, 2) },
		]);
	});

	// Both picked up; waiting at t-1's dropoff (8, 2) from tick 16.
	function waitingAtFirstDropoff(random: Random) {
		return serve(joinedBeforePickups(random), random, { from: 1, to: 16 }, {}, [
			"dropoff:t-1",
		]).state;
	}

	test("driver at the first dropoff told its trip is completed goes on to the second dropoff", () => {
		const random = scriptedRandom([0, 0, 0, 0]);
		const { arrivals } = serve(
			waitingAtFirstDropoff(random),
			random,
			{ from: 17, to: 25 },
			{ 17: [status(t1, "dropoff", "completed")] },
		);
		expect(arrivals).toEqual([
			{ stop: "dropoff", tripId: t2, cell: cell(9, 2) },
		]);
	});

	test("driver at the first dropoff told its trip is released goes on to the second dropoff", () => {
		const random = scriptedRandom([0, 0, 0, 0]);
		const { arrivals } = serve(
			waitingAtFirstDropoff(random),
			random,
			{ from: 17, to: 25 },
			{ 17: [status(t1, "dropoff", "released")] },
		);
		expect(arrivals).toEqual([
			{ stop: "dropoff", tripId: t2, cell: cell(9, 2) },
		]);
	});

	test("driver goes back to wandering from its last stop once both trips are completed", () => {
		// t-2 completed at (9, 2) on tick 17; wander target (0, 0).
		const random = scriptedRandom([0, 0, 0, 0]);
		const { state } = serve(joinedBeforePickups(random), random, {
			from: 1,
			to: 17,
		});
		const { outputs } = decideDriverShard(
			state,
			{ type: "clock.ticked", tick: tick(18) },
			random,
		);
		expect(outputs).toEqual([
			driversMoved(tick(18), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(8, 2) },
			]),
		]);
	});

	test("same seed and pooled inputs give identical outputs", () => {
		const run = () => {
			const random = createRandom(42);
			return serve(joinedBeforePickups(random), random, { from: 1, to: 40 })
				.outputs;
		};
		expect(run()).toEqual(run());
	});

	test("picky driver holding a pooled trip accepts a pooled offer beyond its max pickup distance, drawing nothing", () => {
		// Max pickup distance 2; t-2's offer stream is not scripted, so a draw
		// would throw.
		const random = shiftRandom([0, 0], {
			"preference:d-1": [2],
			"offer:t-1:d-1": [0.5],
		});
		const { state } = startDriverShard(
			{
				grid,
				...shard(i1, 1),
				tick: tick(0),
				preferences: {
					type: "picky",
					maxPickupDistance: { min: 2, max: 12 },
					declineShare: 0.25,
				},
			},
			random,
		);
		const holding = decideDriverShard(
			state,
			pooledOffer(t1, cell(1, 1), cell(8, 2)),
			random,
		).state;
		const { outputs } = decideDriverShard(holding, secondOffer, random);
		expect(outputs).toEqual([
			{
				type: "offer_accepted",
				tripId: t2,
				driverId: d1,
				region: Region.parse(0),
			},
		]);
	});
});
