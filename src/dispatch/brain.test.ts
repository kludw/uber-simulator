import { describe, expect, test } from "bun:test";
import { type Cell, cellIn, type Grid } from "../shared/grid.ts";
import {
	DriverId,
	type RequestTrip,
	RiderId,
	Tick,
	TripId,
} from "../shared/messages.ts";
import { createRandom } from "../shared/random.ts";
import {
	type DispatchInput,
	type DispatchState,
	decideDispatch,
	type Matching,
	startDispatch,
} from "./brain.ts";

const grid: Grid = { width: 10, height: 10 };
const d1 = DriverId.parse("d-1");
const d2 = DriverId.parse("d-2");
const t1 = TripId.parse("t-1");
const t2 = TripId.parse("t-2");
const r1 = RiderId.parse("r-1");
const random = createRandom(1);

function cell(x: number, y: number): Cell {
	const result = cellIn(grid, x, y);
	if (!result.ok) throw new Error(`test cell (${x}, ${y}) outside grid`);
	return result.value;
}

function tick(n: number): Tick {
	return Tick.parse(n);
}

function requestTrip(tripId: TripId, at: number): RequestTrip {
	return {
		type: "request_trip",
		tick: tick(at),
		tripId,
		riderId: r1,
		pickup: cell(1, 2),
		dropoff: cell(7, 8),
	};
}

function requestTripAt(tripId: TripId, pickup: Cell): DispatchInput {
	return { ...requestTrip(tripId, 1), pickup };
}

function wentOnline(driverId: DriverId, at: Cell): DispatchInput {
	return { type: "driver.went_online", tick: tick(0), driverId, cell: at };
}

function ticked(n: number): DispatchInput {
	return { type: "clock.ticked", tick: tick(n) };
}

// Feeds inputs in order from a fresh dispatch; returns the last input's outputs.
function run(inputs: DispatchInput[], matching?: Matching) {
	let state: DispatchState = startDispatch({ grid, tick: tick(0), matching });
	let outputs: unknown[] = [];
	for (const input of inputs) {
		({ state, outputs } = decideDispatch(state, input, random));
	}
	return { outputs };
}

describe("decideDispatch request_trip", () => {
	test("accepts a new trip request and announces it requested", () => {
		const { outputs } = decideDispatch(
			startDispatch({ grid, tick: tick(0) }),
			requestTrip(t1, 4),
			random,
		);

		expect(outputs).toEqual([
			{ type: "request_trip_accepted", tripId: t1 },
			{
				type: "trip.requested",
				tick: tick(4),
				tripId: t1,
				riderId: r1,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
		]);
	});

	test("rejects a request reusing a known trip ID without announcing it", () => {
		const first = decideDispatch(
			startDispatch({ grid, tick: tick(0) }),
			requestTrip(t1, 4),
			random,
		);

		const { outputs } = decideDispatch(first.state, requestTrip(t1, 6), random);

		expect(outputs).toEqual([
			{
				type: "request_trip_rejected",
				tripId: t1,
				error: { type: "duplicate_trip_id" },
			},
		]);
	});
});

describe("decideDispatch clock.ticked", () => {
	test("offers a queued trip to an online driver", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
		]);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t1,
				driverId: d1,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(2), tripId: t1, driverId: d1 },
		]);
	});

	test("offers the trip to the driver nearest its pickup", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(9, 9)),
			wentOnline(d2, cell(2, 2)),
			ticked(2),
		]);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t1,
				driverId: d2,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(2), tripId: t1, driverId: d2 },
		]);
	});

	test("breaks a distance tie by lowest driver ID in string order", () => {
		const d10 = DriverId.parse("d-10");
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d2, cell(1, 4)),
			wentOnline(d10, cell(3, 2)),
			ticked(2),
		]);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t1,
				driverId: d10,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(2), tripId: t1, driverId: d10 },
		]);
	});

	test("offers a driver only the first of two queued trips in a tick", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			requestTrip(t2, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
		]);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t1,
				driverId: d1,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(2), tripId: t1, driverId: d1 },
		]);
	});

	test("does not offer a trip again while its offer is pending", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			wentOnline(d2, cell(4, 4)),
			ticked(3),
		]);

		expect(outputs).toEqual([]);
	});

	test("does not offer another trip to a driver with a pending offer", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			requestTrip(t2, 2),
			ticked(3),
		]);

		expect(outputs).toEqual([]);
	});

	test("outputs nothing when no driver is online", () => {
		const { outputs } = run([requestTrip(t1, 1), ticked(2)]);

		expect(outputs).toEqual([]);
	});

	test("keeps an unoffered trip queued until a driver comes online", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			ticked(2),
			wentOnline(d1, cell(3, 3)),
			ticked(3),
		]);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t1,
				driverId: d1,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(3), tripId: t1, driverId: d1 },
		]);
	});

	test("offers by the cell a driver last moved to", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(9, 9)),
			wentOnline(d2, cell(5, 5)),
			{ type: "driver.moved", tick: tick(1), driverId: d1, cell: cell(1, 3) },
			ticked(2),
		]);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t1,
				driverId: d1,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(2), tripId: t1, driverId: d1 },
		]);
	});

	test("rejects a duplicate request for a trip already offered", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			requestTrip(t1, 3),
		]);

		expect(outputs).toEqual([
			{
				type: "request_trip_rejected",
				tripId: t1,
				error: { type: "duplicate_trip_id" },
			},
		]);
	});
});

function accepted(tripId: TripId, driverId: DriverId): DispatchInput {
	return { type: "offer_accepted", tripId, driverId };
}

function declined(tripId: TripId, driverId: DriverId): DispatchInput {
	return { type: "offer_declined", tripId, driverId };
}

describe("decideDispatch offer replies", () => {
	test("matches the trip when the driver accepts its offer", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			accepted(t1, d1),
		]);

		expect(outputs).toEqual([
			{ type: "trip.matched", tick: tick(2), tripId: t1, driverId: d1 },
		]);
	});

	test("does not offer another trip to a driver matched to a trip", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			accepted(t1, d1),
			requestTrip(t2, 2),
			ticked(3),
		]);

		expect(outputs).toEqual([]);
	});

	test("announces the offer declined when the driver declines", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			declined(t1, d1),
		]);

		expect(outputs).toEqual([
			{ type: "trip.offer_declined", tick: tick(2), tripId: t1, driverId: d1 },
		]);
	});

	test("offers a declined trip next tick to the nearest other driver", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			wentOnline(d2, cell(9, 9)),
			ticked(2),
			declined(t1, d1),
			ticked(3),
		]);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t1,
				driverId: d2,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(3), tripId: t1, driverId: d2 },
		]);
	});

	test("keeps a declined trip ahead of trips requested after it", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			requestTrip(t2, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			declined(t1, d1),
			wentOnline(d2, cell(9, 9)),
			ticked(3),
		]);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t1,
				driverId: d2,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(3), tripId: t1, driverId: d2 },
			{
				type: "offer",
				tripId: t2,
				driverId: d1,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(3), tripId: t2, driverId: d1 },
		]);
	});
});

describe("decideDispatch offer expiry", () => {
	test("expires an offer with no reply three ticks after it was made", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			ticked(3),
			ticked(4),
			ticked(5),
		]);

		expect(outputs).toEqual([
			{ type: "trip.offer_expired", tick: tick(5), tripId: t1, driverId: d1 },
		]);
	});

	test("keeps an offer pending two ticks after it was made", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			ticked(3),
			ticked(4),
		]);

		expect(outputs).toEqual([]);
	});

	test("offers an expired trip next tick to the nearest other driver", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			wentOnline(d2, cell(9, 9)),
			ticked(2),
			ticked(5),
			ticked(6),
		]);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t1,
				driverId: d2,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(6), tripId: t1, driverId: d2 },
		]);
	});
});

describe("decideDispatch stale and invalid offer replies", () => {
	test("ignores an accept arriving after its offer expired", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			ticked(5),
			accepted(t1, d1),
		]);

		expect(outputs).toEqual([]);
	});

	test("ignores a reply for an unknown trip", () => {
		const { outputs } = run([accepted(t1, d1)]);

		expect(outputs).toEqual([]);
	});

	test("rejects a second accept for an already matched trip", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			accepted(t1, d1),
			accepted(t1, d1),
		]);

		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "no_pending_offer",
				input: accepted(t1, d1),
			},
		]);
	});

	test("rejects a reply from a driver never offered the trip", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			declined(t1, d2),
		]);

		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "no_pending_offer",
				input: declined(t1, d2),
			},
		]);
	});
});

// Arrivals carry the driver's tick (9); dispatch stamps its last tick.
function arrivedAtPickup(
	tripId: TripId,
	driverId: DriverId,
	at: Cell,
): DispatchInput {
	return {
		type: "driver.arrived_at_pickup",
		tick: tick(9),
		driverId,
		tripId,
		cell: at,
	};
}

function arrivedAtDropoff(
	tripId: TripId,
	driverId: DriverId,
	at: Cell,
): DispatchInput {
	return {
		type: "driver.arrived_at_dropoff",
		tick: tick(9),
		driverId,
		tripId,
		cell: at,
	};
}

describe("decideDispatch driver arrivals", () => {
	test("picks up a matched trip when its driver arrives at the pickup", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			accepted(t1, d1),
			ticked(4),
			arrivedAtPickup(t1, d1, cell(1, 2)),
		]);

		expect(outputs).toEqual([
			{ type: "trip.picked_up", tick: tick(4), tripId: t1, driverId: d1 },
		]);
	});

	test("rejects a pickup arrival by a driver not matched to the trip", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			accepted(t1, d1),
			arrivedAtPickup(t1, d2, cell(1, 2)),
		]);

		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "wrong_driver",
				input: arrivedAtPickup(t1, d2, cell(1, 2)),
			},
		]);
	});

	test("rejects a pickup arrival away from the trip's pickup cell", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			accepted(t1, d1),
			arrivedAtPickup(t1, d1, cell(2, 2)),
		]);

		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "wrong_cell",
				input: arrivedAtPickup(t1, d1, cell(2, 2)),
			},
		]);
	});

	test("rejects a pickup arrival for a trip not yet matched", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			arrivedAtPickup(t1, d1, cell(1, 2)),
		]);

		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "invalid_transition",
				input: arrivedAtPickup(t1, d1, cell(1, 2)),
			},
		]);
	});

	test("does not offer another trip to a driver carrying a rider", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			accepted(t1, d1),
			arrivedAtPickup(t1, d1, cell(1, 2)),
			requestTrip(t2, 3),
			ticked(3),
		]);

		expect(outputs).toEqual([]);
	});

	test("completes a picked-up trip when its driver arrives at the dropoff", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			accepted(t1, d1),
			arrivedAtPickup(t1, d1, cell(1, 2)),
			ticked(5),
			arrivedAtDropoff(t1, d1, cell(7, 8)),
		]);

		expect(outputs).toEqual([
			{ type: "trip.completed", tick: tick(5), tripId: t1, driverId: d1 },
		]);
	});

	test("offers a queued trip to a driver whose trip completed", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			accepted(t1, d1),
			arrivedAtPickup(t1, d1, cell(1, 2)),
			requestTrip(t2, 3),
			arrivedAtDropoff(t1, d1, cell(7, 8)),
			ticked(4),
		]);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t2,
				driverId: d1,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(4), tripId: t2, driverId: d1 },
		]);
	});

	test("rejects a dropoff arrival for a trip not yet picked up", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			accepted(t1, d1),
			arrivedAtDropoff(t1, d1, cell(7, 8)),
		]);

		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "invalid_transition",
				input: arrivedAtDropoff(t1, d1, cell(7, 8)),
			},
		]);
	});

	test("rejects a dropoff arrival by a driver not carrying the trip", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			accepted(t1, d1),
			arrivedAtPickup(t1, d1, cell(1, 2)),
			arrivedAtDropoff(t1, d2, cell(7, 8)),
		]);

		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "wrong_driver",
				input: arrivedAtDropoff(t1, d2, cell(7, 8)),
			},
		]);
	});

	test("rejects a dropoff arrival away from the trip's dropoff cell", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			accepted(t1, d1),
			arrivedAtPickup(t1, d1, cell(1, 2)),
			arrivedAtDropoff(t1, d1, cell(7, 7)),
		]);

		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "wrong_cell",
				input: arrivedAtDropoff(t1, d1, cell(7, 7)),
			},
		]);
	});

	test("rejects a second dropoff arrival for a completed trip", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			accepted(t1, d1),
			arrivedAtPickup(t1, d1, cell(1, 2)),
			arrivedAtDropoff(t1, d1, cell(7, 8)),
			arrivedAtDropoff(t1, d1, cell(7, 8)),
		]);

		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "invalid_transition",
				input: arrivedAtDropoff(t1, d1, cell(7, 8)),
			},
		]);
	});

	test("ignores an arrival for an unknown trip", () => {
		const { outputs } = run([arrivedAtPickup(t1, d1, cell(1, 2))]);

		expect(outputs).toEqual([]);
	});
});

function cancelTrip(tripId: TripId): DispatchInput {
	return { type: "cancel_trip", tripId };
}

describe("decideDispatch cancel_trip", () => {
	test("cancels a queued trip with no driver", () => {
		const { outputs } = run([requestTrip(t1, 1), ticked(3), cancelTrip(t1)]);

		expect(outputs).toEqual([
			{ type: "cancel_trip_accepted", tripId: t1 },
			{ type: "trip.cancelled", tick: tick(3), tripId: t1, driverId: null },
		]);
	});

	// Names the offered driver so one that accepted concurrently is freed.
	test("cancels a trip with a pending offer and names the offered driver", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			cancelTrip(t1),
		]);

		expect(outputs).toEqual([
			{ type: "cancel_trip_accepted", tripId: t1 },
			{ type: "trip.cancelled", tick: tick(2), tripId: t1, driverId: d1 },
		]);
	});

	test("ignores an accept arriving after its trip was cancelled", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			cancelTrip(t1),
			accepted(t1, d1),
		]);

		expect(outputs).toEqual([]);
	});

	test("cancels a matched trip and names its driver", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			accepted(t1, d1),
			ticked(3),
			cancelTrip(t1),
		]);

		expect(outputs).toEqual([
			{ type: "cancel_trip_accepted", tripId: t1 },
			{ type: "trip.cancelled", tick: tick(3), tripId: t1, driverId: d1 },
		]);
	});

	test("offers a queued trip to a driver whose matched trip was cancelled", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			accepted(t1, d1),
			requestTrip(t2, 3),
			cancelTrip(t1),
			ticked(4),
		]);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t2,
				driverId: d1,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(4), tripId: t2, driverId: d1 },
		]);
	});

	test("rejects cancelling a picked-up trip without announcing it", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			accepted(t1, d1),
			arrivedAtPickup(t1, d1, cell(1, 2)),
			cancelTrip(t1),
		]);

		expect(outputs).toEqual([
			{
				type: "cancel_trip_rejected",
				tripId: t1,
				error: { type: "invalid_transition", from: "picked_up" },
			},
		]);
	});

	test("rejects cancelling a completed trip without announcing it", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			accepted(t1, d1),
			arrivedAtPickup(t1, d1, cell(1, 2)),
			arrivedAtDropoff(t1, d1, cell(7, 8)),
			cancelTrip(t1),
		]);

		expect(outputs).toEqual([
			{
				type: "cancel_trip_rejected",
				tripId: t1,
				error: { type: "invalid_transition", from: "completed" },
			},
		]);
	});

	test("rejects cancelling an unknown trip without announcing it", () => {
		const { outputs } = run([cancelTrip(t1)]);

		expect(outputs).toEqual([
			{
				type: "cancel_trip_rejected",
				tripId: t1,
				error: { type: "unknown_trip" },
			},
		]);
	});

	test("ignores a pickup arrival losing the race to a cancel", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(d1, cell(3, 3)),
			ticked(2),
			accepted(t1, d1),
			cancelTrip(t1),
			arrivedAtPickup(t1, d1, cell(1, 2)),
		]);

		expect(outputs).toEqual([]);
	});
});

describe("decideDispatch batched matching", () => {
	const batched: Matching = { type: "batched", windowTicks: 2 };

	test("makes no offer on a tick outside the batch window", () => {
		const { outputs } = run(
			[requestTrip(t1, 1), wentOnline(d1, cell(3, 3)), ticked(3)],
			batched,
		);

		expect(outputs).toEqual([]);
	});

	// d-1 at (1,0) is nearest both pickups. Greedy gives it to t-1 (FIFO) and
	// sends d-2 four cells to t-2: total 1 + 4 = 5. Batched swaps: 2 + 1 = 3.
	const contested: DispatchInput[] = [
		requestTripAt(t1, cell(2, 0)),
		requestTripAt(t2, cell(0, 0)),
		wentOnline(d1, cell(1, 0)),
		wentOnline(d2, cell(4, 0)),
		ticked(2),
	];

	test("greedy gives the first trip its nearest driver", () => {
		const { outputs } = run(contested);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t1,
				driverId: d1,
				pickup: cell(2, 0),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(2), tripId: t1, driverId: d1 },
			{
				type: "offer",
				tripId: t2,
				driverId: d2,
				pickup: cell(0, 0),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(2), tripId: t2, driverId: d2 },
		]);
	});

	test("batched offers the pairs with least total pickup distance", () => {
		const { outputs } = run(contested, batched);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t1,
				driverId: d2,
				pickup: cell(2, 0),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(2), tripId: t1, driverId: d2 },
			{
				type: "offer",
				tripId: t2,
				driverId: d1,
				pickup: cell(0, 0),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(2), tripId: t2, driverId: d1 },
		]);
	});

	test("matches the trip when the driver accepts a batched offer", () => {
		const { outputs } = run(
			[
				requestTrip(t1, 1),
				wentOnline(d1, cell(3, 3)),
				ticked(2),
				accepted(t1, d1),
			],
			batched,
		);

		expect(outputs).toEqual([
			{ type: "trip.matched", tick: tick(2), tripId: t1, driverId: d1 },
		]);
	});

	test("does not offer a batch trip to a driver matched to a trip", () => {
		const { outputs } = run(
			[
				requestTrip(t1, 1),
				wentOnline(d1, cell(3, 3)),
				ticked(2),
				accepted(t1, d1),
				requestTrip(t2, 3),
				ticked(4),
			],
			batched,
		);

		expect(outputs).toEqual([]);
	});

	test("offers a declined trip at the next window to another driver", () => {
		const { outputs } = run(
			[
				requestTrip(t1, 1),
				wentOnline(d1, cell(3, 3)),
				wentOnline(d2, cell(9, 9)),
				ticked(2),
				declined(t1, d1),
				ticked(3),
				ticked(4),
			],
			batched,
		);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t1,
				driverId: d2,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(4), tripId: t1, driverId: d2 },
		]);
	});

	test("does not offer a declined trip again before the next window", () => {
		const { outputs } = run(
			[
				requestTrip(t1, 1),
				wentOnline(d1, cell(3, 3)),
				wentOnline(d2, cell(9, 9)),
				ticked(2),
				declined(t1, d1),
				ticked(3),
			],
			batched,
		);

		expect(outputs).toEqual([]);
	});

	test("never offers a trip again to a driver who declined it", () => {
		const { outputs } = run(
			[
				requestTrip(t1, 1),
				wentOnline(d1, cell(3, 3)),
				ticked(2),
				declined(t1, d1),
				ticked(4),
			],
			batched,
		);

		expect(outputs).toEqual([]);
	});

	test("expires a batched offer on a tick outside the window", () => {
		const { outputs } = run(
			[
				requestTrip(t1, 1),
				wentOnline(d1, cell(3, 3)),
				wentOnline(d2, cell(9, 9)),
				ticked(2),
				ticked(5),
			],
			batched,
		);

		expect(outputs).toEqual([
			{ type: "trip.offer_expired", tick: tick(5), tripId: t1, driverId: d1 },
		]);
	});

	test("offers an expired trip at the next window to another driver", () => {
		const { outputs } = run(
			[
				requestTrip(t1, 1),
				wentOnline(d1, cell(3, 3)),
				wentOnline(d2, cell(9, 9)),
				ticked(2),
				ticked(5),
				ticked(6),
			],
			batched,
		);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t1,
				driverId: d2,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(6), tripId: t1, driverId: d2 },
		]);
	});

	test("cancels a trip with a pending batched offer and names the driver", () => {
		const { outputs } = run(
			[
				requestTrip(t1, 1),
				wentOnline(d1, cell(3, 3)),
				ticked(2),
				cancelTrip(t1),
			],
			batched,
		);

		expect(outputs).toEqual([
			{ type: "cancel_trip_accepted", tripId: t1 },
			{ type: "trip.cancelled", tick: tick(2), tripId: t1, driverId: d1 },
		]);
	});

	test("offers a batch trip to a driver whose matched trip was cancelled", () => {
		const { outputs } = run(
			[
				requestTrip(t1, 1),
				wentOnline(d1, cell(3, 3)),
				ticked(2),
				accepted(t1, d1),
				requestTrip(t2, 3),
				cancelTrip(t1),
				ticked(4),
			],
			batched,
		);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t2,
				driverId: d1,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(4), tripId: t2, driverId: d1 },
		]);
	});

	test.each([0, -2, 1.5])(
		"rejects a batch window of %p ticks as a bug",
		(windowTicks) => {
			expect(() =>
				startDispatch({
					grid,
					tick: tick(0),
					matching: { type: "batched", windowTicks },
				}),
			).toThrow();
		},
	);
});
