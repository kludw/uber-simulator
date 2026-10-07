import { describe, expect, test } from "bun:test";
import { DriverIndex, driverIdAt } from "../shared/fleet.ts";
import { type Cell, cellIn, type Grid } from "../shared/grid.ts";
import {
	type DriverId,
	driversMoved,
	driversWentOnline,
	type RequestTrip,
	RiderId,
	Tick,
	TripId,
} from "../shared/messages.ts";
import { createRandom } from "../shared/random.ts";
import { Region, RegionLayout } from "../shared/regions.ts";
import {
	type DispatchInput,
	type DispatchState,
	decideDispatch,
	type Matching,
	startDispatch,
} from "./brain.ts";

const grid: Grid = { width: 10, height: 10 };
// Drivers 1, 2 and 10 of a fleet of 12: IDs d-01, d-02 and index 10 (ADR 0052).
const fleetSize = 12;
const i1 = DriverIndex.parse(1);
const i2 = DriverIndex.parse(2);
const i10 = DriverIndex.parse(10);
const d1 = driverIdAt(fleetSize, i1);
const d2 = driverIdAt(fleetSize, i2);
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
		region: Region.parse(0),
	};
}

function requestTripAt(tripId: TripId, pickup: Cell): DispatchInput {
	return { ...requestTrip(tripId, 1), pickup };
}

function wentOnline(driverIndex: DriverIndex, at: Cell): DispatchInput {
	return driversWentOnline(tick(0), Region.parse(0), fleetSize, [
		{ driverIndex, cell: at },
	]);
}

function wentOffline(driverId: DriverId, at: Cell): DispatchInput {
	return {
		type: "driver.went_offline",
		tick: tick(0),
		driverId,
		cell: at,
		region: Region.parse(0),
	};
}

function ticked(n: number): DispatchInput {
	return { type: "clock.ticked", tick: tick(n) };
}

// Feeds inputs in order from a fresh dispatch; returns the last input's outputs.
function run(inputs: DispatchInput[], matching?: Matching) {
	let state: DispatchState = startDispatch({
		grid,
		fleetSize,
		tick: tick(0),
		matching,
	});
	let outputs: unknown[] = [];
	for (const input of inputs) {
		({ state, outputs } = decideDispatch(state, input, random));
	}
	return { outputs };
}

describe("decideDispatch request_trip", () => {
	test("accepts a new trip request and announces it requested", () => {
		const { outputs } = decideDispatch(
			startDispatch({ grid, fleetSize, tick: tick(0) }),
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
			startDispatch({ grid, fleetSize, tick: tick(0) }),
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
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(9, 9)),
			wentOnline(i2, cell(2, 2)),
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

	test("breaks a distance tie by lowest driver ID", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(i10, cell(3, 2)),
			wentOnline(i2, cell(1, 4)),
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

	test("offers a driver only the first of two queued trips in a tick", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			requestTrip(t2, 1),
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
			ticked(2),
			wentOnline(i2, cell(4, 4)),
			ticked(3),
		]);

		expect(outputs).toEqual([]);
	});

	test("does not offer another trip to a driver with a pending offer", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
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

	test("offers by the cell each driver last moved to", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(i1, cell(9, 9)),
			wentOnline(i2, cell(5, 5)),
			driversMoved(tick(1), Region.parse(0), fleetSize, [
				{ driverIndex: i2, cell: cell(5, 6) },
				{ driverIndex: i1, cell: cell(1, 3) },
			]),
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

	test("offers to the nearest of the drivers one message announces online", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			driversWentOnline(tick(0), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(9, 9) },
				{ driverIndex: i2, cell: cell(1, 3) },
			]),
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

	// Over NATS, dispatch can subscribe after a shard published its start-up
	// drivers.went_online (ADR 0043).
	test("offers a trip to a driver first seen moving", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			driversMoved(tick(1), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(1, 3) },
			]),
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
			wentOnline(i1, cell(3, 3)),
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
	return { type: "offer_accepted", tripId, driverId, region: Region.parse(0) };
}

// idleAt: the driver's cell if it is idle, null if offline or on a trip.
function declined(
	tripId: TripId,
	driverId: DriverId,
	idleAt: Cell | null,
): DispatchInput {
	return {
		type: "offer_declined",
		tripId,
		driverId,
		region: Region.parse(0),
		idleAt,
	};
}

// ADR 0052: dispatch knows its fleet's size from its own config; a message
// from a fleet of another size (a misconfigured or stale shard) is rejected
// whole.
describe("decideDispatch fleet size", () => {
	const otherFleet = 13;

	test.each([
		driversMoved(tick(1), Region.parse(0), otherFleet, [
			{ driverIndex: i1, cell: cell(1, 3) },
		]),
		driversWentOnline(tick(1), Region.parse(0), otherFleet, [
			{ driverIndex: i1, cell: cell(1, 3) },
		]),
	])("rejects $type from a fleet of another size", (message) => {
		const { outputs } = run([message]);

		expect(outputs).toEqual([
			{ type: "input_rejected", reason: "fleet_size_mismatch", input: message },
		]);
	});

	test("does not offer a trip to a driver only a fleet of another size reported", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			driversMoved(tick(1), Region.parse(0), otherFleet, [
				{ driverIndex: i1, cell: cell(1, 3) },
			]),
			ticked(2),
		]);

		expect(outputs).toEqual([]);
	});
});

describe("decideDispatch offer replies", () => {
	test("matches the trip when the driver accepts its offer", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
			ticked(2),
			declined(t1, d1, cell(3, 3)),
		]);

		expect(outputs).toEqual([
			{ type: "trip.offer_declined", tick: tick(2), tripId: t1, driverId: d1 },
		]);
	});

	test("offers a declined trip next tick to the nearest other driver", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(i1, cell(3, 3)),
			wentOnline(i2, cell(9, 9)),
			ticked(2),
			declined(t1, d1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
			ticked(2),
			declined(t1, d1, cell(3, 3)),
			wentOnline(i2, cell(9, 9)),
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
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
			ticked(2),
			ticked(3),
			ticked(4),
		]);

		expect(outputs).toEqual([]);
	});

	test("offers an expired trip next tick to the nearest other driver", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(i1, cell(3, 3)),
			wentOnline(i2, cell(9, 9)),
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
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
			ticked(2),
			declined(t1, d2, cell(9, 9)),
		]);

		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "no_pending_offer",
				input: declined(t1, d2, cell(9, 9)),
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
		region: Region.parse(0),
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
		region: Region.parse(0),
	};
}

describe("decideDispatch driver arrivals", () => {
	test("picks up a matched trip when its driver arrives at the pickup", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
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

	// Overload: dispatch expires the offer before the driver's accept reaches
	// it; the driver drives to the pickup until trip.offer_expired frees it.
	test("ignores a pickup arrival by a driver whose offer expired", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(i1, cell(3, 3)),
			ticked(2),
			ticked(5),
			accepted(t1, d1),
			arrivedAtPickup(t1, d1, cell(1, 2)),
		]);

		expect(outputs).toEqual([]);
	});

	test("ignores a pickup arrival by a driver whose offer expired after the trip matched another driver", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(i1, cell(3, 3)),
			wentOnline(i2, cell(9, 9)),
			ticked(2),
			ticked(5),
			ticked(6),
			accepted(t1, d2),
			arrivedAtPickup(t1, d1, cell(1, 2)),
		]);

		expect(outputs).toEqual([]);
	});
});

function cancelTrip(tripId: TripId): DispatchInput {
	return { type: "cancel_trip", tripId, region: Region.parse(0) };
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
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
			ticked(2),
			cancelTrip(t1),
			accepted(t1, d1),
		]);

		expect(outputs).toEqual([]);
	});

	test("cancels a matched trip and names its driver", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
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
			wentOnline(i1, cell(3, 3)),
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
			[requestTrip(t1, 1), wentOnline(i1, cell(3, 3)), ticked(3)],
			batched,
		);

		expect(outputs).toEqual([]);
	});

	// d-1 at (1,0) is nearest both pickups. Greedy gives it to t-1 (FIFO) and
	// sends d-2 four cells to t-2: total 1 + 4 = 5. Batched swaps: 2 + 1 = 3.
	const contested: DispatchInput[] = [
		requestTripAt(t1, cell(2, 0)),
		requestTripAt(t2, cell(0, 0)),
		wentOnline(i1, cell(1, 0)),
		wentOnline(i2, cell(4, 0)),
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

	test("with more trips than idle drivers, offers the pairs with least total pickup distance", () => {
		// As contested, plus t-3 far from both drivers: it waits.
		const { outputs } = run(
			[requestTripAt(TripId.parse("t-3"), cell(9, 9)), ...contested],
			batched,
		);

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
				wentOnline(i1, cell(3, 3)),
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
				wentOnline(i1, cell(3, 3)),
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
				wentOnline(i1, cell(3, 3)),
				wentOnline(i2, cell(9, 9)),
				ticked(2),
				declined(t1, d1, cell(3, 3)),
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
				wentOnline(i1, cell(3, 3)),
				wentOnline(i2, cell(9, 9)),
				ticked(2),
				declined(t1, d1, cell(3, 3)),
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
				wentOnline(i1, cell(3, 3)),
				ticked(2),
				declined(t1, d1, cell(3, 3)),
				ticked(4),
			],
			batched,
		);

		expect(outputs).toEqual([]);
	});

	test("with more trips than idle drivers, a driver is never offered a trip it declined", () => {
		// d-1 is 1 cell from t-1 and 5 from t-2; it declined t-1.
		const { outputs } = run(
			[
				requestTripAt(t1, cell(2, 0)),
				requestTripAt(t2, cell(6, 0)),
				wentOnline(i1, cell(1, 0)),
				ticked(2),
				declined(t1, d1, cell(1, 0)),
				ticked(4),
			],
			batched,
		);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t2,
				driverId: d1,
				pickup: cell(6, 0),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(4), tripId: t2, driverId: d1 },
		]);
	});

	test("expires a batched offer on a tick outside the window", () => {
		const { outputs } = run(
			[
				requestTrip(t1, 1),
				wentOnline(i1, cell(3, 3)),
				wentOnline(i2, cell(9, 9)),
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
				wentOnline(i1, cell(3, 3)),
				wentOnline(i2, cell(9, 9)),
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
				wentOnline(i1, cell(3, 3)),
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
				wentOnline(i1, cell(3, 3)),
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
					fleetSize,
					tick: tick(0),
					matching: { type: "batched", windowTicks },
				}),
			).toThrow();
		},
	);
});

// ADR 0032. Ticks are even so the batched window (2) is open on each.
describe.each<Matching>([
	{ type: "greedy" },
	{ type: "batched", windowTicks: 2 },
])("decideDispatch driver shifts ($type)", (matching) => {
	test("does not offer a trip to a driver that went offline", () => {
		const { outputs } = run(
			[
				requestTrip(t1, 1),
				wentOnline(i1, cell(3, 3)),
				wentOffline(d1, cell(3, 3)),
				ticked(2),
			],
			matching,
		);

		expect(outputs).toEqual([]);
	});

	test("offers a trip to an offline driver once it is back online", () => {
		const { outputs } = run(
			[
				requestTrip(t1, 1),
				wentOnline(i1, cell(3, 3)),
				wentOffline(d1, cell(3, 3)),
				ticked(2),
				wentOnline(i1, cell(3, 3)),
				ticked(4),
			],
			matching,
		);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t1,
				driverId: d1,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(4), tripId: t1, driverId: d1 },
		]);
	});
});

// Dispatch keeps its idle drivers across ticks (ADR 0048): a driver freed
// by its trip is idle again from its latest cell, if still online. Ticks are
// even so the batched window (2) is open on each.
describe.each<Matching>([
	{ type: "greedy" },
	{ type: "batched", windowTicks: 2 },
])("decideDispatch drivers freed by their trip ($type)", (matching) => {
	test("offers a trip to a freed driver by the cell it moved to while matched", () => {
		const { outputs } = run(
			[
				requestTrip(t1, 1),
				wentOnline(i1, cell(9, 9)),
				ticked(2),
				accepted(t1, d1),
				wentOnline(i2, cell(5, 5)),
				driversMoved(tick(2), Region.parse(0), fleetSize, [
					{ driverIndex: i1, cell: cell(1, 3) },
				]),
				requestTrip(t2, 3),
				cancelTrip(t1),
				ticked(4),
			],
			matching,
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

	test("does not offer a trip to a driver that went offline while matched once its trip is cancelled", () => {
		const { outputs } = run(
			[
				requestTrip(t1, 1),
				wentOnline(i1, cell(3, 3)),
				ticked(2),
				accepted(t1, d1),
				wentOffline(d1, cell(3, 3)),
				requestTrip(t2, 3),
				cancelTrip(t1),
				ticked(4),
			],
			matching,
		);

		expect(outputs).toEqual([]);
	});

	test("offers a trip to a driver back online after its offer expired while offline", () => {
		const { outputs } = run(
			[
				requestTrip(t1, 1),
				wentOnline(i1, cell(3, 3)),
				ticked(2),
				wentOffline(d1, cell(3, 3)),
				ticked(6),
				requestTrip(t2, 7),
				wentOnline(i1, cell(4, 4)),
				ticked(8),
			],
			matching,
		);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t2,
				driverId: d1,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(8), tripId: t2, driverId: d1 },
		]);
	});
});

// Ended trips (completed, cancelled) still answer late and duplicate inputs.
describe("decideDispatch ended trips", () => {
	const completedT1: DispatchInput[] = [
		requestTrip(t1, 1),
		wentOnline(i1, cell(3, 3)),
		wentOnline(i2, cell(9, 9)),
		ticked(2),
		ticked(5),
		ticked(6),
		accepted(t1, d2),
		arrivedAtPickup(t1, d2, cell(1, 2)),
		arrivedAtDropoff(t1, d2, cell(7, 8)),
		ticked(7),
	];

	test("rejects a request reusing the ID of a completed trip", () => {
		const { outputs } = run([...completedT1, requestTrip(t1, 8)]);

		expect(outputs).toEqual([
			{
				type: "request_trip_rejected",
				tripId: t1,
				error: { type: "duplicate_trip_id" },
			},
		]);
	});

	test("rejects a request reusing the ID of a cancelled trip", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			cancelTrip(t1),
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

	test("rejects cancelling a cancelled trip without announcing it", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			cancelTrip(t1),
			ticked(2),
			cancelTrip(t1),
		]);

		expect(outputs).toEqual([
			{
				type: "cancel_trip_rejected",
				tripId: t1,
				error: { type: "invalid_transition", from: "cancelled" },
			},
		]);
	});

	test("ignores a late accept from a driver whose offer expired", () => {
		const { outputs } = run([...completedT1, accepted(t1, d1)]);

		expect(outputs).toEqual([]);
	});

	test("rejects an accept from the driver who completed the trip", () => {
		const { outputs } = run([...completedT1, accepted(t1, d2)]);

		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "no_pending_offer",
				input: accepted(t1, d2),
			},
		]);
	});

	test("rejects a pickup arrival for a completed trip", () => {
		const { outputs } = run([
			...completedT1,
			arrivedAtPickup(t1, d2, cell(1, 2)),
		]);

		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "invalid_transition",
				input: arrivedAtPickup(t1, d2, cell(1, 2)),
			},
		]);
	});

	test("ignores a dropoff arrival for a cancelled trip", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			cancelTrip(t1),
			ticked(2),
			arrivedAtDropoff(t1, d1, cell(7, 8)),
		]);

		expect(outputs).toEqual([]);
	});
});

function confirmTrip(
	tripId: TripId,
	driverId: DriverId,
	stage: "pickup" | "dropoff",
	at: Cell,
): DispatchInput {
	return {
		type: "confirm_trip",
		tripId,
		driverId,
		stage,
		cell: at,
		region: Region.parse(0),
	};
}

function tripStatus(
	tripId: TripId,
	driverId: DriverId,
	stage: "pickup" | "dropoff",
	status: "picked_up" | "completed" | "released",
) {
	return { type: "trip_status", tripId, driverId, stage, status };
}

// ADR 0041's table, row by row.
describe("decideDispatch confirm_trip", () => {
	test("releases a driver confirming an unknown trip", () => {
		const { outputs } = run([confirmTrip(t1, d1, "pickup", cell(1, 2))]);

		expect(outputs).toEqual([tripStatus(t1, d1, "pickup", "released")]);
	});

	const matchedT1: DispatchInput[] = [
		requestTrip(t1, 1),
		wentOnline(i1, cell(3, 3)),
		ticked(2),
		accepted(t1, d1),
		ticked(4),
	];

	test("picks up a trip matched to the driver confirming at its pickup", () => {
		const { outputs } = run([
			...matchedT1,
			confirmTrip(t1, d1, "pickup", cell(1, 2)),
		]);

		expect(outputs).toEqual([
			{ type: "trip.picked_up", tick: tick(4), tripId: t1, driverId: d1 },
		]);
	});

	test("rejects a pickup confirm away from the matched trip's pickup cell", () => {
		const { outputs } = run([
			...matchedT1,
			confirmTrip(t1, d1, "pickup", cell(2, 2)),
		]);

		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "wrong_cell",
				input: confirmTrip(t1, d1, "pickup", cell(2, 2)),
			},
		]);
	});

	test("rejects a dropoff confirm for a trip matched to the driver", () => {
		const { outputs } = run([
			...matchedT1,
			confirmTrip(t1, d1, "dropoff", cell(7, 8)),
		]);

		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "invalid_transition",
				input: confirmTrip(t1, d1, "dropoff", cell(7, 8)),
			},
		]);
	});

	const pickedUpT1: DispatchInput[] = [
		...matchedT1,
		arrivedAtPickup(t1, d1, cell(1, 2)),
		ticked(5),
	];

	test("tells the driver carrying the trip it was picked up when it confirms the pickup", () => {
		const { outputs } = run([
			...pickedUpT1,
			confirmTrip(t1, d1, "pickup", cell(1, 2)),
		]);

		expect(outputs).toEqual([tripStatus(t1, d1, "pickup", "picked_up")]);
	});

	test("completes a picked-up trip when its driver confirms at the dropoff", () => {
		const { outputs } = run([
			...pickedUpT1,
			confirmTrip(t1, d1, "dropoff", cell(7, 8)),
		]);

		expect(outputs).toEqual([
			{ type: "trip.completed", tick: tick(5), tripId: t1, driverId: d1 },
		]);
	});

	const completedT1: DispatchInput[] = [
		...pickedUpT1,
		arrivedAtDropoff(t1, d1, cell(7, 8)),
		ticked(6),
	];

	test("tells the driver who completed the trip it was completed when it confirms the dropoff", () => {
		const { outputs } = run([
			...completedT1,
			confirmTrip(t1, d1, "dropoff", cell(7, 8)),
		]);

		expect(outputs).toEqual([tripStatus(t1, d1, "dropoff", "completed")]);
	});

	test("tells the driver who completed the trip it was completed when it confirms the pickup", () => {
		const { outputs } = run([
			...completedT1,
			confirmTrip(t1, d1, "pickup", cell(1, 2)),
		]);

		expect(outputs).toEqual([tripStatus(t1, d1, "pickup", "completed")]);
	});

	const offeredT1: DispatchInput[] = [
		requestTrip(t1, 1),
		wentOnline(i1, cell(3, 3)),
		ticked(2),
	];

	// The offer's accept or trip.offer_expired resolves it.
	test("stays silent to a pickup confirm from the driver holding the trip's offer", () => {
		const { outputs } = run([
			...offeredT1,
			confirmTrip(t1, d1, "pickup", cell(1, 2)),
		]);

		expect(outputs).toEqual([]);
	});

	test("rejects a dropoff confirm from the driver holding the trip's offer", () => {
		const { outputs } = run([
			...offeredT1,
			confirmTrip(t1, d1, "dropoff", cell(7, 8)),
		]);

		expect(outputs).toEqual([
			{
				type: "input_rejected",
				reason: "invalid_transition",
				input: confirmTrip(t1, d1, "dropoff", cell(7, 8)),
			},
		]);
	});

	// d1's offer expires at tick 5; d2 is offered t1 at tick 6.
	const matchedToD2: DispatchInput[] = [
		...offeredT1,
		ticked(5),
		wentOnline(i2, cell(9, 9)),
		ticked(6),
		accepted(t1, d2),
	];

	// What t1 is to d1 after each history.
	const releasedCases: [string, DispatchInput[]][] = [
		["is waiting without an offer", [requestTrip(t1, 1)]],
		[
			"is offered to another driver",
			[requestTrip(t1, 1), wentOnline(i2, cell(1, 1)), ticked(2)],
		],
		["was cancelled", [requestTrip(t1, 1), cancelTrip(t1)]],
		["was cancelled while matched to it", [...matchedT1, cancelTrip(t1)]],
		["expired its offer to it", [...offeredT1, ticked(5)]],
		["was declined by it", [...offeredT1, declined(t1, d1, cell(3, 3))]],
		["is matched to another driver", matchedToD2],
		[
			"is picked up by another driver",
			[...matchedToD2, arrivedAtPickup(t1, d2, cell(1, 2))],
		],
		[
			"is completed by another driver",
			[
				...matchedToD2,
				arrivedAtPickup(t1, d2, cell(1, 2)),
				arrivedAtDropoff(t1, d2, cell(7, 8)),
			],
		],
	];

	describe.each(["pickup", "dropoff"] as const)("at stage %s", (stage) => {
		test.each(releasedCases)(
			"releases the driver when the trip %s",
			(_case, history) => {
				const { outputs } = run([
					...history,
					confirmTrip(t1, d1, stage, cell(1, 2)),
				]);

				expect(outputs).toEqual([tripStatus(t1, d1, stage, "released")]);
			},
		);
	});
});

// ADR 0050: an instance of a 2x1 layout owning region 0 (x 0-4); trips'
// pickups (1, 2) are in it, their dropoffs (7, 8) outside. Ticks are even so
// the batched window (2) is open on each.
describe.each<Matching>([
	{ type: "greedy" },
	{ type: "batched", windowTicks: 2 },
])("decideDispatch in a region ($type)", (matching) => {
	const region0 = Region.parse(0);

	function runInRegion(inputs: DispatchInput[]) {
		let state = startDispatch({
			grid,
			fleetSize,
			tick: tick(0),
			matching,
			regions: RegionLayout.parse("2x1"),
			region: region0,
		});
		let outputs: unknown[] = [];
		for (const input of inputs) {
			({ state, outputs } = decideDispatch(state, input, random));
		}
		return { outputs };
	}

	test("does not offer a trip to a driver that moved out of the region", () => {
		const { outputs } = runInRegion([
			requestTrip(t1, 1),
			wentOnline(i1, cell(4, 2)),
			driversMoved(tick(1), region0, fleetSize, [
				{ driverIndex: i1, cell: cell(5, 2) },
			]),
			ticked(2),
		]);

		expect(outputs).toEqual([]);
	});

	// d1's move from (3, 2) to (5, 2) was lost: dispatch still has it at
	// (3, 2), a ghost (ADR 0050, item 6).
	test("does not offer a trip to a driver whose decline says it is idle outside the region", () => {
		const { outputs } = runInRegion([
			requestTrip(t1, 1),
			wentOnline(i1, cell(3, 2)),
			ticked(2),
			declined(t1, d1, cell(5, 2)),
			requestTrip(t2, 3),
			ticked(4),
		]);

		expect(outputs).toEqual([]);
	});

	// d1 is on another region's trip, passing through.
	test("does not offer a trip to a driver whose decline says it is not idle", () => {
		const { outputs } = runInRegion([
			requestTrip(t1, 1),
			wentOnline(i1, cell(3, 2)),
			ticked(2),
			declined(t1, d1, null),
			requestTrip(t2, 3),
			ticked(4),
		]);

		expect(outputs).toEqual([]);
	});

	test("offers a trip to a declining driver by the cell its decline says it is idle at", () => {
		const { outputs } = runInRegion([
			requestTrip(t1, 1),
			wentOnline(i1, cell(4, 9)),
			ticked(2),
			declined(t1, d1, cell(1, 3)),
			cancelTrip(t1),
			wentOnline(i2, cell(3, 2)),
			requestTrip(t2, 3),
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

	// d1's moves to the dropoff were lost: dispatch last saw it at the pickup.
	test.each<[string, DispatchInput]>([
		["arrival", arrivedAtDropoff(t1, d1, cell(7, 8))],
		["confirm", confirmTrip(t1, d1, "dropoff", cell(7, 8))],
	])(
		"does not offer a trip to a driver whose dropoff %s is outside the region",
		(_case, atDropoff) => {
			const { outputs } = runInRegion([
				requestTrip(t1, 1),
				wentOnline(i1, cell(4, 2)),
				ticked(2),
				accepted(t1, d1),
				arrivedAtPickup(t1, d1, cell(1, 2)),
				atDropoff,
				requestTrip(t2, 3),
				ticked(4),
			]);

			expect(outputs).toEqual([]);
		},
	);

	test("offers a trip to an idle driver named by a rejected arrival outside the region", () => {
		const { outputs } = runInRegion([
			requestTrip(t1, 1),
			wentOnline(i1, cell(4, 2)),
			ticked(2),
			accepted(t1, d1),
			arrivedAtPickup(t1, d1, cell(1, 2)),
			wentOnline(i2, cell(3, 2)),
			arrivedAtDropoff(t1, d2, cell(7, 8)),
			requestTrip(t2, 3),
			ticked(4),
		]);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: t2,
				driverId: d2,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(4), tripId: t2, driverId: d2 },
		]);
	});

	test("does not offer a trip to a driver freed outside the region", () => {
		const { outputs } = runInRegion([
			requestTrip(t1, 1),
			wentOnline(i1, cell(4, 2)),
			ticked(2),
			accepted(t1, d1),
			driversMoved(tick(2), region0, fleetSize, [
				{ driverIndex: i1, cell: cell(5, 2) },
			]),
			cancelTrip(t1),
			requestTrip(t2, 3),
			ticked(4),
		]);

		expect(outputs).toEqual([]);
	});

	test("offers a trip to a driver freed back inside the region", () => {
		const { outputs } = runInRegion([
			requestTrip(t1, 1),
			wentOnline(i1, cell(4, 2)),
			ticked(2),
			accepted(t1, d1),
			driversMoved(tick(2), region0, fleetSize, [
				{ driverIndex: i1, cell: cell(5, 2) },
			]),
			driversMoved(tick(3), region0, fleetSize, [
				{ driverIndex: i1, cell: cell(4, 2) },
			]),
			cancelTrip(t1),
			requestTrip(t2, 3),
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
});
