import { describe, expect, test } from "bun:test";
import { DriverIndex, driverIdAt } from "../shared/fleet.ts";
import {
	type Cell,
	type Coordinate,
	cellAt,
	cellIn,
	type Grid,
} from "../shared/grid.ts";
import {
	DriverId,
	driversMoved,
	driversWentOnline,
	type RequestTrip,
	RiderId,
	type RiderRatedDriver,
	Tick,
	TripId,
} from "../shared/messages.ts";
import { createRandom } from "../shared/random.ts";
import { Stars } from "../shared/rating.ts";
import { Region, RegionLayout } from "../shared/regions.ts";
import { Surge } from "../shared/surge.ts";
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
	])(
		"rejects $type from a fleet of another size, naming its own",
		(message) => {
			const { outputs } = run([message]);

			expect(outputs).toEqual([
				{
					type: "input_rejected",
					reason: "fleet_size_mismatch",
					input: message,
					expectedFleetSize: 12,
				},
			]);
		},
	);

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

function rated(driverId: DriverId, stars: number): RiderRatedDriver {
	return {
		type: "rider.rated_driver",
		tick: tick(1),
		riderId: RiderId.parse("r-9"),
		tripId: TripId.parse("t-9"),
		driverId,
		stars: Stars.parse(stars),
	};
}

// ADR 0057: greedy takes the idle driver of least match cost, pickup
// distance + 10 cells per star of average rating below 5. Trips' pickup is
// (1, 2).
describe("decideDispatch ratings (greedy)", () => {
	function offeredTo(driverId: DriverId) {
		return [
			{
				type: "offer",
				tripId: t1,
				driverId,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
			{ type: "trip.offered", tick: tick(2), tripId: t1, driverId },
		];
	}

	test("offers a trip to a driver rated one star better 9 cells farther", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(i1, cell(1, 3)),
			wentOnline(i2, cell(9, 4)),
			rated(d1, 4),
			rated(d2, 5),
			ticked(2),
		]);

		expect(outputs).toEqual(offeredTo(d2));
	});

	test("offers a trip to the nearer driver when one rated one star better is 11 cells farther", () => {
		const { outputs } = run([
			requestTrip(t1, 1),
			wentOnline(i1, cell(1, 3)),
			wentOnline(i2, cell(9, 6)),
			rated(d1, 4),
			rated(d2, 5),
			ticked(2),
		]);

		expect(outputs).toEqual(offeredTo(d1));
	});

	// Region 0 of 2x1 is x 0-4: d2 is rated before this dispatch knows it.
	test("uses the rating of a driver from another region once it crosses in", () => {
		let state = startDispatch({
			grid,
			fleetSize,
			tick: tick(0),
			regions: RegionLayout.parse("2x1"),
			region: Region.parse(0),
		});
		let outputs: unknown[] = [];
		for (const input of [
			requestTrip(t1, 1),
			wentOnline(i1, cell(1, 5)),
			rated(d2, 4),
			driversMoved(tick(1), Region.parse(0), fleetSize, [
				{ driverIndex: i2, cell: cell(1, 3) },
			]),
			ticked(2),
		]) {
			({ state, outputs } = decideDispatch(state, input, random));
		}

		expect(outputs).toEqual(offeredTo(d1));
	});

	test.each([
		DriverId.parse("d-12"),
		DriverId.parse("d-2"),
		DriverId.parse("x-01"),
	])("rejects a rating of %s, no driver of the fleet", (driverId) => {
		const rating = rated(driverId, 4);

		const { outputs } = run([rating]);

		expect(outputs).toEqual([
			{ type: "input_rejected", reason: "driver_not_in_fleet", input: rating },
		]);
	});
});

// ADR 0054: a 150 x 100 grid is 3 x 2 surge zones of 50 x 50 cells, zone 0
// top left, zone 4 bottom middle.
describe("decideDispatch pricing", () => {
	const zonedGrid: Grid = { width: 150, height: 100 };

	function at(x: number, y: number): Cell {
		return cellAt(x as Coordinate, y as Coordinate);
	}

	function request(n: number, pickup: Cell, surge?: number): DispatchInput {
		return {
			type: "request_trip",
			tick: tick(1),
			tripId: TripId.parse(`t-${n}`),
			riderId: RiderId.parse(`r-${n}`),
			pickup,
			dropoff: at(140, 90),
			region: Region.parse(0),
			...(surge === undefined ? {} : { surge: Surge.parse(surge) }),
		};
	}

	function online(index: number, cell: Cell): DispatchInput {
		return driversWentOnline(tick(0), Region.parse(0), fleetSize, [
			{ driverIndex: DriverIndex.parse(index), cell },
		]);
	}

	type Options = {
		surge: boolean;
		matching?: Matching;
		regions?: RegionLayout;
		region?: Region;
	};

	// The last input's outputs of one type.
	function outputsOf(type: string, inputs: DispatchInput[], options: Options) {
		let state = startDispatch({
			grid: zonedGrid,
			fleetSize,
			tick: tick(0),
			...options,
		});
		let outputs: unknown[] = [];
		for (const input of inputs) {
			({ state, outputs } = decideDispatch(state, input, random));
		}
		return outputs.filter(
			(output) => (output as { type: string }).type === type,
		);
	}

	function priced(inputs: DispatchInput[], options: Options = { surge: true }) {
		return outputsOf("zones.priced", inputs, options);
	}

	function requested(inputs: DispatchInput[], surge: boolean) {
		return outputsOf("trip.requested", inputs, { surge });
	}

	test("prices zones after matching: offered trips are still unmatched, their drivers busy", () => {
		const outputs = priced([
			request(1, at(10, 10)),
			request(2, at(20, 10)),
			online(1, at(11, 10)),
			online(2, at(21, 10)),
			ticked(30),
		]);

		expect(outputs).toEqual([
			{
				type: "zones.priced",
				tick: tick(30),
				region: Region.parse(0),
				zones: [{ zone: 0, surge: 2 }],
			},
		]);
	});

	// d1 takes t-1 on tick 1: one unmatched trip against no idle driver is
	// 1.0, where counting the matched trip too would be 2.0.
	test("never counts matched trips as unmatched", () => {
		const outputs = priced([
			request(1, at(10, 10)),
			request(2, at(20, 10)),
			online(1, at(11, 10)),
			ticked(1),
			accepted(TripId.parse("t-1"), d1),
			ticked(30),
		]);

		expect(outputs).toEqual([
			{
				type: "zones.priced",
				tick: tick(30),
				region: Region.parse(0),
				zones: [],
			},
		]);
	});

	// Batched with a 7-tick window: nothing is matched on tick 30.
	test("prices each zone from its own unmatched trips and idle drivers, in zone order", () => {
		const outputs = priced(
			[
				request(1, at(60, 60)),
				request(2, at(70, 60)),
				request(3, at(80, 60)),
				request(4, at(90, 60)),
				online(1, at(60, 70)),
				online(2, at(70, 70)),
				online(3, at(80, 70)),
				request(5, at(60, 10)),
				request(6, at(70, 10)),
				request(7, at(80, 10)),
				request(8, at(90, 10)),
				request(9, at(95, 10)),
				online(4, at(60, 20)),
				online(5, at(70, 20)),
				request(10, at(10, 10)),
				online(6, at(10, 20)),
				online(7, at(20, 20)),
				online(8, at(30, 20)),
				ticked(30),
			],
			{ surge: true, matching: { type: "batched", windowTicks: 7 } },
		);

		expect(outputs).toEqual([
			{
				type: "zones.priced",
				tick: tick(30),
				region: Region.parse(0),
				zones: [
					{ zone: 1, surge: 2 },
					{ zone: 4, surge: 1.3 },
				],
			},
		]);
	});

	test("publishes an empty price list when no zone surges", () => {
		const outputs = priced([
			request(1, at(10, 10)),
			online(1, at(140, 90)),
			ticked(30),
		]);

		expect(outputs).toEqual([
			{
				type: "zones.priced",
				tick: tick(30),
				region: Region.parse(0),
				zones: [],
			},
		]);
	});

	test("prices only every 30 ticks", () => {
		const outputs = priced([
			request(1, at(10, 10)),
			request(2, at(20, 10)),
			ticked(29),
		]);

		expect(outputs).toEqual([]);
	});

	// 2x1 regions split zone 1 (x 50-99) at x 75: region 1 prices its part
	// from its own trips and drivers, never region 0's idle drivers.
	test("prices a zone cut by a region border from the region's part only", () => {
		const outputs = priced(
			[
				request(1, at(80, 10)),
				request(2, at(90, 10)),
				online(1, at(60, 10)),
				online(2, at(70, 10)),
				ticked(30),
			],
			{
				surge: true,
				regions: RegionLayout.parse("2x1"),
				region: Region.parse(1),
			},
		);

		expect(outputs).toEqual([
			{
				type: "zones.priced",
				tick: tick(30),
				region: Region.parse(1),
				zones: [{ zone: 1, surge: 2 }],
			},
		]);
	});

	// Distance (10, 10) to (140, 90): 210 cells, so a base fare of
	// 250 + 2 * 210 = 670 cents.
	test("prices a requested trip at its rider's quote", () => {
		const outputs = requested([request(1, at(10, 10), 1.4)], true);

		expect(outputs).toEqual([
			{
				type: "trip.requested",
				tick: tick(1),
				tripId: TripId.parse("t-1"),
				riderId: RiderId.parse("r-1"),
				pickup: at(10, 10),
				dropoff: at(140, 90),
				surge: 1.4,
				fare: 938,
			},
		]);
	});

	test("prices a requested trip without a quote at 1.0", () => {
		const outputs = requested([request(1, at(10, 10))], true);

		expect(outputs).toEqual([
			{
				type: "trip.requested",
				tick: tick(1),
				tripId: TripId.parse("t-1"),
				riderId: RiderId.parse("r-1"),
				pickup: at(10, 10),
				dropoff: at(140, 90),
				surge: 1,
				fare: 670,
			},
		]);
	});

	test("prices no requested trip with surge off, even one with a quote", () => {
		const outputs = requested([request(1, at(10, 10), 1.4)], false);

		expect(outputs).toEqual([
			{
				type: "trip.requested",
				tick: tick(1),
				tripId: TripId.parse("t-1"),
				riderId: RiderId.parse("r-1"),
				pickup: at(10, 10),
				dropoff: at(140, 90),
			},
		]);
	});

	test("publishes no prices with surge off", () => {
		const outputs = priced(
			[request(1, at(10, 10)), request(2, at(20, 10)), ticked(30)],
			{ surge: false },
		);

		expect(outputs).toEqual([]);
	});
});

// ADR 0056. A 300 × 300 grid so joins can be up to 120 ticks away; cells on
// row 0 unless noted, so distances are differences of x.
describe("decideDispatch pooling", () => {
	const poolGrid: Grid = { width: 300, height: 300 };

	function at(x: number, y = 0): Cell {
		return cellAt(x as Coordinate, y as Coordinate);
	}

	function trip(n: number): TripId {
		return TripId.parse(`t-${n}`);
	}

	function pooled(n: number, pickup: Cell, dropoff: Cell): RequestTrip {
		return {
			type: "request_trip",
			tick: tick(1),
			tripId: trip(n),
			riderId: RiderId.parse(`r-${n}`),
			pickup,
			dropoff,
			region: Region.parse(0),
			pooled: true,
		};
	}

	function online(driverIndex: DriverIndex, cell: Cell): DispatchInput {
		return driversWentOnline(tick(0), Region.parse(0), fleetSize, [
			{ driverIndex, cell },
		]);
	}

	// The last input's outputs of one type.
	function outputsOf(
		type: string,
		inputs: DispatchInput[],
		options: { matching?: Matching; surge?: boolean } = {},
	) {
		let state = startDispatch({
			grid: poolGrid,
			fleetSize,
			tick: tick(0),
			...options,
		});
		let outputs: unknown[] = [];
		for (const input of inputs) {
			({ state, outputs } = decideDispatch(state, input, random));
		}
		return outputs.filter(
			(output) => (output as { type: string }).type === type,
		);
	}

	function offers(inputs: DispatchInput[], matching?: Matching) {
		return outputsOf("offer", inputs, { matching });
	}

	test("announces a pooled trip requested as pooled", () => {
		const outputs = outputsOf("trip.requested", [pooled(1, at(10), at(110))]);

		expect(outputs).toEqual([
			{
				type: "trip.requested",
				tick: tick(1),
				tripId: trip(1),
				riderId: RiderId.parse("r-1"),
				pickup: at(10),
				dropoff: at(110),
				pooled: true,
			},
		]);
	});

	// Distance 100: base fare 250 + 2 × 100 = 450 cents; × 1.2 surge × 0.75
	// pooled = 405.
	test("prices a pooled trip at the pooled fare of its rider's quote", () => {
		const outputs = outputsOf(
			"trip.requested",
			[{ ...pooled(1, at(10), at(110)), surge: Surge.parse(1.2) }],
			{ surge: true },
		);

		expect(outputs).toEqual([
			{
				type: "trip.requested",
				tick: tick(1),
				tripId: trip(1),
				riderId: RiderId.parse("r-1"),
				pickup: at(10),
				dropoff: at(110),
				surge: 1.2,
				fare: 405,
				pooled: true,
			},
		]);
	});

	test("offers a pooled trip as pooled", () => {
		const outputs = offers([
			pooled(1, at(10), at(110)),
			online(i1, at(0)),
			ticked(1),
		]);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: trip(1),
				driverId: d1,
				pickup: at(10),
				dropoff: at(110),
				pooled: true,
			},
		]);
	});

	// t-1 (10 → 110) matched to d-01 at 0. t-2 (20 → 100) joins: join ETA
	// 10 + 10 = 20; t-1 rides 10 + 80 + 10 = 100 of its 150, t-2 its direct 80.
	const partnerMatched: DispatchInput[] = [
		pooled(1, at(10), at(110)),
		online(i1, at(0)),
		ticked(1),
		accepted(trip(1), d1),
	];

	function joinOffer(
		n: number,
		driverId: DriverId,
		pickup: Cell,
		dropoff: Cell,
	) {
		return {
			type: "offer",
			tripId: trip(n),
			driverId,
			pickup,
			dropoff,
			pooled: true,
		};
	}

	test("offers a queued pooled trip to its partner's driver before a nearer idle driver", () => {
		const outputs = offers([
			...partnerMatched,
			online(i2, at(20)),
			pooled(2, at(20), at(100)),
			ticked(2),
		]);

		expect(outputs).toEqual([joinOffer(2, d1, at(20), at(100))]);
	});

	function unpooled(n: number, pickup: Cell, dropoff: Cell): RequestTrip {
		const { pooled: _pooled, ...request } = pooled(n, pickup, dropoff);
		return request;
	}

	function moved(driverIndex: DriverIndex, cell: Cell): DispatchInput {
		return driversMoved(tick(1), Region.parse(0), fleetSize, [
			{ driverIndex, cell },
		]);
	}

	test("never offers an unpooled trip to a pooled trip's driver", () => {
		const outputs = offers([
			...partnerMatched,
			unpooled(2, at(20), at(100)),
			ticked(2),
		]);

		expect(outputs).toEqual([]);
	});

	test("joins a pooled trip after an earlier pooled trip was cancelled", () => {
		const outputs = offers([
			pooled(5, at(200), at(250)),
			cancelTrip(trip(5)),
			...partnerMatched,
			pooled(2, at(20), at(100)),
			ticked(2),
		]);

		expect(outputs).toEqual([joinOffer(2, d1, at(20), at(100))]);
	});

	test("joins a pooled trip to a partner offered earlier in the same tick", () => {
		const outputs = offers([
			pooled(1, at(10), at(110)),
			pooled(2, at(20), at(100)),
			online(i1, at(0)),
			ticked(1),
		]);

		expect(outputs).toEqual([
			joinOffer(1, d1, at(10), at(110)),
			joinOffer(2, d1, at(20), at(100)),
		]);
	});

	// t-1 (0 → 100) picked up at tick 1, its driver since moved to 50. t-2
	// (60 → 100): t-1 rides its ride so far + 10 + 40, at most 150, so a ride
	// so far of at most 100 ticks; by distance from its pickup it is only 50.
	const partnerAboard: DispatchInput[] = [
		pooled(1, at(0), at(100)),
		online(i1, at(0)),
		ticked(1),
		accepted(trip(1), d1),
		arrivedAtPickup(trip(1), d1, at(0)),
		moved(i1, at(50)),
	];

	test("joins a partner aboard whose ride so far keeps it within its detour limit", () => {
		const outputs = offers([
			...partnerAboard,
			ticked(101),
			pooled(2, at(60), at(100)),
			ticked(102),
		]);

		expect(outputs).toEqual([joinOffer(2, d1, at(60), at(100))]);
	});

	test("does not join a partner aboard whose ride so far in ticks breaks its detour limit", () => {
		const outputs = offers([
			...partnerAboard,
			ticked(102),
			pooled(2, at(60), at(100)),
			ticked(103),
		]);

		expect(outputs).toEqual([]);
	});

	// t-1 (60 → 260) matched to d-01 at 0: a join at x reaches t-1's pickup in
	// 60 ticks, then x - 60 more.
	test.each([
		[120, [joinOffer(2, d1, at(120), at(260))]],
		[121, []],
	])(
		"joins a partner within a join ETA of 120 (pickup at %d)",
		(x, expected) => {
			const outputs = offers([
				pooled(1, at(60), at(260)),
				online(i1, at(0)),
				ticked(1),
				accepted(trip(1), d1),
				pooled(2, at(x), at(260)),
				ticked(2),
			]);

			expect(outputs).toEqual(expected);
		},
	);

	// Partners' pickups more than 120 apart, so neither joins the other. From
	// the joining pickup at 110, t-1's driver is 110 ticks away, t-2's 20.
	test("joins the partner with the least join ETA", () => {
		const outputs = offers([
			pooled(1, at(0), at(110, 200)),
			pooled(2, at(130), at(110, 200)),
			online(i1, at(0)),
			online(i2, at(130)),
			ticked(1),
			pooled(3, at(110), at(110, 200)),
			ticked(2),
		]);

		expect(outputs).toEqual([joinOffer(3, d2, at(110), at(110, 200))]);
	});

	// t-9, requested first, declined by d-10 and offered d-02 at 40 in the
	// joining tick, after t-10 on d-01 at 222: each driver 60 from its
	// partner's pickup (100, 162), each pickup 31 from the joining pickup at
	// 131 (and 62 apart, so neither joins the other). Not offer order, nor ID
	// order of trips or drivers.
	test("breaks a join ETA tie to the partner requested earlier", () => {
		const outputs = offers([
			pooled(9, at(100), at(131, 200)),
			pooled(10, at(162), at(131, 200)),
			online(i10, at(40)),
			online(i1, at(222)),
			ticked(1),
			declined(trip(9), driverIdAt(fleetSize, i10), null),
			online(i2, at(40)),
			pooled(3, at(131), at(131, 200)),
			ticked(2),
		]);

		expect(outputs).toEqual([
			joinOffer(9, d2, at(100), at(131, 200)),
			joinOffer(3, d2, at(131), at(131, 200)),
		]);
	});

	test("never offers a join to a driver whose join offer for the trip expired", () => {
		const outputs = offers([
			...partnerMatched,
			pooled(2, at(20), at(100)),
			ticked(2),
			ticked(3),
			ticked(4),
			ticked(5),
			ticked(6),
		]);

		expect(outputs).toEqual([]);
	});

	test("keeps a driver busy with its first trip once a join offer to it expires", () => {
		const outputs = offers([
			...partnerMatched,
			pooled(2, at(20), at(100)),
			ticked(2),
			ticked(3),
			ticked(4),
			ticked(5),
			unpooled(3, at(0), at(80)),
			ticked(6),
		]);

		expect(outputs).toEqual([]);
	});

	test("offers no join to a partner's driver held offline after declining a join", () => {
		const outputs = offers([
			...partnerMatched,
			pooled(2, at(20), at(100)),
			ticked(2),
			declined(trip(2), d1, null),
			pooled(3, at(20), at(100)),
			ticked(3),
		]);

		expect(outputs).toEqual([]);
	});

	// t-1 (0 → 40) picked up at tick 1; t-2 (0 → 50) joins at tick 2 and is
	// picked up there: t-1 rides 40 of its 60, t-2 40 + 10 = 50 of its 75.
	const pool: DispatchInput[] = [
		pooled(1, at(0), at(40)),
		online(i1, at(0)),
		ticked(1),
		accepted(trip(1), d1),
		arrivedAtPickup(trip(1), d1, at(0)),
		pooled(2, at(0), at(50)),
		ticked(2),
		accepted(trip(2), d1),
		arrivedAtPickup(trip(2), d1, at(0)),
	];

	test("offers no third trip to a driver holding two", () => {
		const outputs = offers([...pool, pooled(3, at(0), at(40)), ticked(3)]);

		expect(outputs).toEqual([]);
	});

	// After t-1's dropoff at 40, t-3 (45 → 50) joins t-2: t-2 rides its ride
	// so far + 5 + 5, at most 75, so a ride so far of at most 65 ticks.
	const firstDroppedOff: DispatchInput[] = [
		...pool,
		arrivedAtDropoff(trip(1), d1, at(40)),
	];

	test("joins the remaining trip of a pool once the other is dropped off", () => {
		const outputs = offers([
			...firstDroppedOff,
			ticked(42),
			pooled(3, at(45), at(50)),
			ticked(43),
		]);

		expect(outputs).toEqual([joinOffer(3, d1, at(45), at(50))]);
	});

	test("does not join a chained pool's partner once its ride so far uses up its detour limit", () => {
		const outputs = offers([
			...firstDroppedOff,
			ticked(68),
			pooled(3, at(45), at(50)),
			ticked(69),
		]);

		expect(outputs).toEqual([]);
	});

	test("keeps a driver busy while one of its two trips is left", () => {
		const outputs = offers([
			...firstDroppedOff,
			unpooled(3, at(40), at(80)),
			ticked(3),
		]);

		expect(outputs).toEqual([]);
	});

	const batched: Matching = { type: "batched", windowTicks: 2 };

	// One idle driver, d-02 at 30, for t-2 (10 away) and t-3 (15 away): batched
	// matching alone gives it t-2; joining t-1 first leaves it to t-3.
	test("batched joins pooled trips to partners before matching the rest", () => {
		const outputs = offers(
			[
				pooled(1, at(10), at(110)),
				online(i1, at(0)),
				ticked(2),
				accepted(trip(1), d1),
				online(i2, at(30)),
				pooled(2, at(20), at(100)),
				unpooled(3, at(45), at(100)),
				ticked(4),
			],
			batched,
		);

		expect(outputs).toEqual([
			joinOffer(2, d1, at(20), at(100)),
			{
				type: "offer",
				tripId: trip(3),
				driverId: d2,
				pickup: at(45),
				dropoff: at(100),
			},
		]);
	});

	// One idle driver for two pooled trips: batched matching gives it t-1 (0
	// away, t-2 10), then t-2 joins t-1.
	test("batched joins pooled trips left without a driver to partners it just matched", () => {
		const outputs = offers(
			[
				pooled(1, at(0), at(100)),
				pooled(2, at(10), at(100)),
				online(i1, at(0)),
				ticked(2),
			],
			batched,
		);

		expect(outputs).toEqual([
			joinOffer(1, d1, at(0), at(100)),
			joinOffer(2, d1, at(10), at(100)),
		]);
	});

	test("frees a driver once both its trips are dropped off", () => {
		const outputs = offers([
			...firstDroppedOff,
			arrivedAtDropoff(trip(2), d1, at(50)),
			unpooled(3, at(40), at(80)),
			ticked(3),
		]);

		expect(outputs).toEqual([
			{
				type: "offer",
				tripId: trip(3),
				driverId: d1,
				pickup: at(40),
				dropoff: at(80),
			},
		]);
	});

	// No open pooled trip: matching skips the join passes (ADR 0056 rule 4).
	function openPooledAfter(inputs: DispatchInput[]): number {
		let state = startDispatch({ grid: poolGrid, fleetSize, tick: tick(0) });
		for (const input of inputs) {
			({ state } = decideDispatch(state, input, random));
		}
		return state.pooledOpen;
	}

	test("counts no open pooled trip once its pooled trips are cancelled", () => {
		const open = openPooledAfter([
			...partnerMatched,
			pooled(5, at(200), at(250)),
			cancelTrip(trip(5)),
			cancelTrip(trip(1)),
		]);

		expect(open).toBe(0);
	});

	test("counts no open pooled trip once both trips of a pool are completed", () => {
		const open = openPooledAfter([
			...firstDroppedOff,
			arrivedAtDropoff(trip(2), d1, at(50)),
		]);

		expect(open).toBe(0);
	});
});
