import { describe, expect, test } from "bun:test";
import { type Cell, cellIn, type Grid } from "../shared/grid.ts";
import {
	DriverId,
	type Message,
	RiderId,
	Tick,
	TripId,
} from "../shared/messages.ts";
import { summarize } from "./summary.ts";

const grid: Grid = { width: 10, height: 10 };
const d1 = DriverId.parse("d-1");
const r1 = RiderId.parse("r-1");
const t1 = TripId.parse("t-1");
const t2 = TripId.parse("t-2");
const t3 = TripId.parse("t-3");

const config = {
	seed: 42,
	ticks: 20,
	grid,
	driverShards: { count: 2, driversPerShard: 3 },
	requestsPerMinute: 10,
};

function cell(x: number, y: number): Cell {
	const result = cellIn(grid, x, y);
	if (!result.ok) throw new Error(`test cell (${x}, ${y}) outside grid`);
	return result.value;
}

function tick(n: number): Tick {
	return Tick.parse(n);
}

function requested(tripId: TripId, at: number): Message {
	return {
		type: "trip.requested",
		tick: tick(at),
		tripId,
		riderId: r1,
		pickup: cell(1, 0),
		dropoff: cell(2, 0),
	};
}

function tripEvent(
	type: "trip.offered" | "trip.matched" | "trip.picked_up" | "trip.completed",
	tripId: TripId,
	at: number,
): Message {
	return { type, tick: tick(at), tripId, driverId: d1 };
}

// d1 starts at (0,0). t1 requested at 1, picked up at 2 (1 tick), completed.
// t2 requested at 4, cancelled before any offer. t3 requested at 6, still
// waiting at the end.
const eventLog: Message[] = [
	{ type: "driver.went_online", tick: tick(0), driverId: d1, cell: cell(0, 0) },
	requested(t1, 1),
	tripEvent("trip.offered", t1, 1),
	tripEvent("trip.matched", t1, 1),
	{ type: "driver.moved", tick: tick(2), driverId: d1, cell: cell(1, 0) },
	tripEvent("trip.picked_up", t1, 2),
	{ type: "driver.moved", tick: tick(3), driverId: d1, cell: cell(2, 0) },
	tripEvent("trip.completed", t1, 3),
	requested(t2, 4),
	{ type: "trip.cancelled", tick: tick(5), tripId: t2, driverId: null },
	requested(t3, 6),
];

describe("summarize", () => {
	test("counts trips requested, completed, and cancelled", () => {
		const summary = summarize(config, { eventLog, rejected: [] });

		expect(summary.trips).toEqual({ requested: 3, completed: 1, cancelled: 1 });
	});

	// Waits of 1 and 4 ticks; t3 never picked up, so it doesn't count.
	test("averages ticks from request to pickup over picked-up trips", () => {
		const waits: Message[] = [
			requested(t1, 1),
			requested(t2, 3),
			requested(t3, 3),
			tripEvent("trip.picked_up", t1, 2),
			tripEvent("trip.picked_up", t2, 7),
		];

		const summary = summarize(config, { eventLog: waits, rejected: [] });

		expect(summary.meanTicksToPickup).toBe(2.5);
	});

	test("has no mean ticks to pickup when no trip was picked up", () => {
		const summary = summarize(config, {
			eventLog: [requested(t1, 1)],
			rejected: [],
		});

		expect(summary.meanTicksToPickup).toBeNull();
	});

	test("reports seed, ticks, drivers across shards, and rejected inputs", () => {
		const rejected = [
			{
				service: "dispatch",
				rejected: {
					type: "input_rejected" as const,
					reason: "unknown_trip",
					input: eventLog[1] as Message,
				},
			},
		];

		const summary = summarize(config, { eventLog, rejected });

		expect({
			seed: summary.seed,
			ticks: summary.ticks,
			drivers: summary.drivers,
			rejectedInputs: summary.rejectedInputs,
		}).toEqual({ seed: 42, ticks: 20, drivers: 6, rejectedInputs: 1 });
	});

	test("a clean log has no invariant violations", () => {
		expect(summarize(config, { eventLog, rejected: [] }).violations).toEqual(
			[],
		);
	});

	test("reports invariant violations in the log", () => {
		const completedTwice = [...eventLog, tripEvent("trip.completed", t1, 7)];

		const summary = summarize(config, {
			eventLog: completedTwice,
			rejected: [],
		});

		expect(summary.violations).toEqual([
			{
				type: "illegal_trip_transition",
				tick: tick(7),
				tripId: t1,
				from: "completed",
				event: "trip.completed",
			},
		]);
	});
});
