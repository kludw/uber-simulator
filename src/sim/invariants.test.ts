import { describe, expect, test } from "bun:test";
import { DriverIndex, driverIdAt } from "../shared/fleet.ts";
import { type Cell, cellIn, type Grid } from "../shared/grid.ts";
import {
	type DriverId,
	driversMoved,
	driversWentOnline,
	type Message,
	RiderId,
	Tick,
	TripId,
} from "../shared/messages.ts";
import { Stars } from "../shared/rating.ts";
import { Region } from "../shared/regions.ts";
import { Fare, Surge } from "../shared/surge.ts";
import { checkInvariants, createInvariantChecker } from "./invariants.ts";

const grid: Grid = { width: 10, height: 10 };
// Drivers of a fleet of 10: IDs d-0 to d-9 (ADR 0052).
const fleetSize = 10;
const i1 = DriverIndex.parse(1);
const d1 = driverIdAt(fleetSize, i1);
const i2 = DriverIndex.parse(2);
const d2 = driverIdAt(fleetSize, i2);
const t1 = TripId.parse("t-1");
const t2 = TripId.parse("t-2");
const r1 = RiderId.parse("r-1");

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
	type:
		| "trip.offered"
		| "trip.offer_declined"
		| "trip.offer_expired"
		| "trip.matched"
		| "trip.picked_up"
		| "trip.completed",
	tripId: TripId,
	driverId: DriverId,
	at: number,
): Message {
	return { type, tick: tick(at), tripId, driverId };
}

function wentOnline(driverIndex: DriverIndex, at: Cell): Message {
	return driversWentOnline(tick(0), Region.parse(0), fleetSize, [
		{ driverIndex, cell: at },
	]);
}

function wentOffline(driverId: DriverId, at: Cell, when: number): Message {
	return {
		type: "driver.went_offline",
		tick: tick(when),
		driverId,
		cell: at,
		region: Region.parse(0),
	};
}

function moved(driverIndex: DriverIndex, to: Cell, at: number): Message {
	return driversMoved(tick(at), Region.parse(0), fleetSize, [
		{ driverIndex, cell: to },
	]);
}

// d1 starts at (0,0); t1 picks up at (1,0), drops off at (2,0).
const cleanTrip: Message[] = [
	wentOnline(i1, cell(0, 0)),
	{ type: "clock.ticked", tick: tick(1) },
	requested(t1, 1),
	tripEvent("trip.offered", t1, d1, 1),
	tripEvent("trip.matched", t1, d1, 1),
	moved(i1, cell(1, 0), 2),
	tripEvent("trip.picked_up", t1, d1, 2),
	moved(i1, cell(2, 0), 3),
	tripEvent("trip.completed", t1, d1, 3),
];

describe("checkInvariants", () => {
	test("a clean trip log has no violations", () => {
		expect(checkInvariants(cleanTrip, grid)).toEqual([]);
	});

	test("a trip matched without an offer is an illegal transition", () => {
		const log = [requested(t1, 1), tripEvent("trip.matched", t1, d1, 1)];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "illegal_trip_transition",
				tick: tick(1),
				tripId: t1,
				from: "requested",
				event: "trip.matched",
			},
		]);
	});

	test("a completed trip that was never matched or picked up is flagged", () => {
		const log = [requested(t1, 1), tripEvent("trip.completed", t1, d1, 2)];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "illegal_trip_transition",
				tick: tick(2),
				tripId: t1,
				from: "requested",
				event: "trip.completed",
			},
		]);
	});

	test("a matched trip completed without a pickup is flagged", () => {
		const log = [
			wentOnline(i1, cell(2, 0)),
			requested(t1, 1),
			tripEvent("trip.offered", t1, d1, 1),
			tripEvent("trip.matched", t1, d1, 1),
			tripEvent("trip.completed", t1, d1, 2),
		];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "illegal_trip_transition",
				tick: tick(2),
				tripId: t1,
				from: "matched",
				event: "trip.completed",
			},
		]);
	});

	test("a matched trip cancelled without naming its driver is flagged", () => {
		const log: Message[] = [
			requested(t1, 1),
			tripEvent("trip.offered", t1, d1, 1),
			tripEvent("trip.matched", t1, d1, 1),
			{ type: "trip.cancelled", tick: tick(2), tripId: t1, driverId: null },
		];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "cancel_names_wrong_driver",
				tick: tick(2),
				tripId: t1,
				driverId: null,
				expectedDriverId: d1,
			},
		]);
	});

	test("a matched trip cancelled naming an earlier-offered driver is flagged", () => {
		const log: Message[] = [
			requested(t1, 1),
			tripEvent("trip.offered", t1, d2, 1),
			tripEvent("trip.offer_declined", t1, d2, 1),
			tripEvent("trip.offered", t1, d1, 2),
			tripEvent("trip.matched", t1, d1, 2),
			{ type: "trip.cancelled", tick: tick(3), tripId: t1, driverId: d2 },
		];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "cancel_names_wrong_driver",
				tick: tick(3),
				tripId: t1,
				driverId: d2,
				expectedDriverId: d1,
			},
		]);
	});

	test("a trip cancelled with a pending offer without naming the offered driver is flagged", () => {
		const log: Message[] = [
			requested(t1, 1),
			tripEvent("trip.offered", t1, d1, 1),
			{ type: "trip.cancelled", tick: tick(2), tripId: t1, driverId: null },
		];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "cancel_names_wrong_driver",
				tick: tick(2),
				tripId: t1,
				driverId: null,
				expectedDriverId: d1,
			},
		]);
	});

	test("a trip cancelled with no pending offer naming an earlier-offered driver is flagged", () => {
		const log: Message[] = [
			requested(t1, 1),
			tripEvent("trip.offered", t1, d1, 1),
			tripEvent("trip.offer_expired", t1, d1, 4),
			{ type: "trip.cancelled", tick: tick(5), tripId: t1, driverId: d1 },
		];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "cancel_names_wrong_driver",
				tick: tick(5),
				tripId: t1,
				driverId: d1,
				expectedDriverId: null,
			},
		]);
	});

	test("a trip cancelled naming a driver before offering it to that driver is flagged", () => {
		const log: Message[] = [
			requested(t1, 1),
			{ type: "trip.cancelled", tick: tick(1), tripId: t1, driverId: d1 },
		];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "cancelled_before_offer",
				tick: tick(1),
				tripId: t1,
				driverId: d1,
			},
		]);
	});

	test("a driver matched to a second trip while the first is active is flagged", () => {
		const log = [
			requested(t1, 1),
			tripEvent("trip.offered", t1, d1, 1),
			tripEvent("trip.matched", t1, d1, 1),
			requested(t2, 2),
			tripEvent("trip.offered", t2, d1, 2),
			tripEvent("trip.matched", t2, d1, 2),
		];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "driver_has_two_active_trips",
				tick: tick(2),
				driverId: d1,
				activeTripId: t1,
				tripId: t2,
			},
		]);
	});

	test("a driver may be matched again once its trip is completed or cancelled", () => {
		const log = [
			...cleanTrip,
			requested(t2, 4),
			tripEvent("trip.offered", t2, d1, 4),
			tripEvent("trip.matched", t2, d1, 4),
			{ type: "trip.cancelled", tick: tick(5), tripId: t2, driverId: d1 },
			requested(TripId.parse("t-3"), 6),
			tripEvent("trip.offered", TripId.parse("t-3"), d1, 6),
			tripEvent("trip.matched", TripId.parse("t-3"), d1, 6),
		] satisfies Message[];

		expect(checkInvariants(log, grid)).toEqual([]);
	});

	test("a trip picked up while its driver is away from the pickup is flagged", () => {
		const log = [
			wentOnline(i1, cell(0, 0)),
			requested(t1, 1),
			tripEvent("trip.offered", t1, d1, 1),
			tripEvent("trip.matched", t1, d1, 1),
			tripEvent("trip.picked_up", t1, d1, 2),
		];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "driver_not_at_pickup",
				tick: tick(2),
				tripId: t1,
				driverId: d1,
				cell: cell(0, 0),
			},
		]);
	});

	test("a trip completed while its driver is away from the dropoff is flagged", () => {
		const log = [
			wentOnline(i1, cell(1, 0)),
			requested(t1, 1),
			tripEvent("trip.offered", t1, d1, 1),
			tripEvent("trip.matched", t1, d1, 1),
			tripEvent("trip.picked_up", t1, d1, 1),
			tripEvent("trip.completed", t1, d1, 2),
		];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "driver_not_at_dropoff",
				tick: tick(2),
				tripId: t1,
				driverId: d1,
				cell: cell(1, 0),
			},
		]);
	});

	test("a driver moving two cells in one tick is flagged", () => {
		const log = [wentOnline(i1, cell(0, 0)), moved(i1, cell(2, 0), 1)];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "driver_moved_too_fast",
				tick: tick(1),
				driverId: d1,
				from: cell(0, 0),
				to: cell(2, 0),
			},
		]);
	});

	test("a driver moving twice in the same tick is flagged", () => {
		const log = [
			wentOnline(i1, cell(0, 0)),
			moved(i1, cell(1, 0), 1),
			moved(i1, cell(2, 0), 1),
		];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "driver_moved_too_fast",
				tick: tick(1),
				driverId: d1,
				from: cell(1, 0),
				to: cell(2, 0),
			},
		]);
	});

	test("each move in one message is checked", () => {
		const log: Message[] = [
			wentOnline(i1, cell(0, 0)),
			wentOnline(i2, cell(5, 5)),
			driversMoved(tick(1), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(1, 0) },
				{ driverIndex: i2, cell: cell(7, 5) },
			]),
		];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "driver_moved_too_fast",
				tick: tick(1),
				driverId: d2,
				from: cell(5, 5),
				to: cell(7, 5),
			},
		]);
	});

	test("a driver moving off the grid is flagged", () => {
		// Built by hand: cellIn refuses cells outside the grid.
		const offGrid = { x: 10, y: 0 } as Cell;
		const log = [wentOnline(i1, cell(9, 0)), moved(i1, offGrid, 1)];

		expect(checkInvariants(log, grid)).toEqual([
			{ type: "driver_left_grid", tick: tick(1), driverId: d1, cell: offGrid },
		]);
	});
});

// ADR 0032.
describe("checkInvariants driver shifts", () => {
	test("a driver offered a trip as it goes offline, declining, then back online is clean", () => {
		const log: Message[] = [
			...cleanTrip,
			requested(t2, 4),
			wentOffline(d1, cell(2, 0), 4),
			tripEvent("trip.offered", t2, d1, 4),
			tripEvent("trip.offer_declined", t2, d1, 4),
			driversWentOnline(tick(8), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(2, 0) },
			]),
			moved(i1, cell(2, 1), 9),
		];

		expect(checkInvariants(log, grid)).toEqual([]);
	});

	test("every driver one message announces online may move again", () => {
		const log: Message[] = [
			wentOnline(i1, cell(0, 0)),
			wentOnline(i2, cell(5, 5)),
			wentOffline(d1, cell(0, 0), 1),
			wentOffline(d2, cell(5, 5), 1),
			driversWentOnline(tick(4), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(0, 0) },
				{ driverIndex: i2, cell: cell(5, 5) },
			]),
			driversMoved(tick(5), Region.parse(0), fleetSize, [
				{ driverIndex: i1, cell: cell(1, 0) },
				{ driverIndex: i2, cell: cell(5, 6) },
			]),
		];

		expect(checkInvariants(log, grid)).toEqual([]);
	});

	test("an offline driver moving is flagged", () => {
		const log = [
			wentOnline(i1, cell(0, 0)),
			wentOffline(d1, cell(0, 0), 1),
			moved(i1, cell(1, 0), 2),
		];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "offline_driver_moved",
				tick: tick(2),
				driverId: d1,
				cell: cell(1, 0),
			},
		]);
	});

	test("a trip matched to an offline driver is flagged", () => {
		const log = [
			wentOnline(i1, cell(0, 0)),
			requested(t1, 1),
			tripEvent("trip.offered", t1, d1, 1),
			wentOffline(d1, cell(0, 0), 1),
			tripEvent("trip.matched", t1, d1, 2),
		];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "offline_driver_matched",
				tick: tick(2),
				tripId: t1,
				driverId: d1,
			},
		]);
	});

	test("a driver going offline with an active trip is flagged", () => {
		const log = [
			wentOnline(i1, cell(0, 0)),
			requested(t1, 1),
			tripEvent("trip.offered", t1, d1, 1),
			tripEvent("trip.matched", t1, d1, 1),
			wentOffline(d1, cell(0, 0), 2),
		];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "driver_went_offline_with_active_trip",
				tick: tick(2),
				driverId: d1,
				tripId: t1,
			},
		]);
	});

	test.each<Message>([
		{ type: "trip.cancelled", tick: tick(2), tripId: t1, driverId: d1 },
		tripEvent("trip.offer_declined", t1, d1, 2),
		tripEvent("trip.offer_expired", t1, d1, 2),
	])("$type naming an offline driver keeps it offline", (freed) => {
		const log = [
			wentOnline(i1, cell(0, 0)),
			requested(t1, 1),
			tripEvent("trip.offered", t1, d1, 1),
			wentOffline(d1, cell(0, 0), 1),
			freed,
			moved(i1, cell(1, 0), 3),
		];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "offline_driver_moved",
				tick: tick(3),
				driverId: d1,
				cell: cell(1, 0),
			},
		]);
	});
});

// ADR 0054: a rider declining surge leaves without a trip.
describe("checkInvariants surge declines", () => {
	const r2 = RiderId.parse("r-2");

	function declined(riderId: RiderId, at: number): Message {
		return {
			type: "rider.declined_surge",
			tick: tick(at),
			riderId,
			pickup: cell(1, 0),
			surge: Surge.parse(1.5),
		};
	}

	test("a rider declining once while others request trips is clean", () => {
		expect(checkInvariants([declined(r2, 1), requested(t1, 1)], grid)).toEqual(
			[],
		);
	});

	test("a declined rider requesting a trip is flagged", () => {
		expect(checkInvariants([declined(r1, 1), requested(t1, 2)], grid)).toEqual([
			{ type: "declined_rider_requested", tick: tick(2), riderId: r1 },
		]);
	});

	// Over NATS the two may arrive in either order.
	test("a rider declining after requesting a trip is flagged", () => {
		expect(checkInvariants([requested(t1, 1), declined(r1, 2)], grid)).toEqual([
			{ type: "declined_rider_requested", tick: tick(2), riderId: r1 },
		]);
	});

	test("a rider declining twice is flagged", () => {
		expect(checkInvariants([declined(r2, 1), declined(r2, 3)], grid)).toEqual([
			{ type: "declined_rider_requested", tick: tick(3), riderId: r2 },
		]);
	});
});

// ADR 0056: a driver holds at most two trips, two only when both are pooled.
describe("checkInvariants capacity", () => {
	function pooledRequested(tripId: TripId, at: number): Message {
		return {
			type: "trip.requested",
			tick: tick(at),
			tripId,
			riderId: r1,
			pickup: cell(1, 0),
			dropoff: cell(2, 0),
			pooled: true,
		};
	}

	function matched(tripId: TripId, at: number): Message[] {
		return [
			tripEvent("trip.offered", tripId, d1, at),
			tripEvent("trip.matched", tripId, d1, at),
		];
	}

	test("a driver holding two pooled trips is clean", () => {
		const log = [
			pooledRequested(t1, 1),
			...matched(t1, 1),
			pooledRequested(t2, 2),
			...matched(t2, 2),
		];

		expect(checkInvariants(log, grid)).toEqual([]);
	});

	test("a pooled trip and an unpooled trip on one driver are flagged", () => {
		const log = [
			pooledRequested(t1, 1),
			...matched(t1, 1),
			requested(t2, 2),
			...matched(t2, 2),
		];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "driver_has_two_active_trips",
				tick: tick(2),
				driverId: d1,
				activeTripId: t1,
				tripId: t2,
			},
		]);
	});

	test("a third trip on a driver is flagged", () => {
		const t3 = TripId.parse("t-3");
		const log = [
			pooledRequested(t1, 1),
			...matched(t1, 1),
			pooledRequested(t2, 2),
			...matched(t2, 2),
			pooledRequested(t3, 3),
			...matched(t3, 3),
		];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "driver_over_capacity",
				tick: tick(3),
				driverId: d1,
				activeTripIds: [t1, t2],
				tripId: t3,
			},
		]);
	});

	test("a driver may take another pooled trip once one of its two ends", () => {
		const t3 = TripId.parse("t-3");
		const log = [
			pooledRequested(t1, 1),
			...matched(t1, 1),
			pooledRequested(t2, 2),
			...matched(t2, 2),
			{ type: "trip.cancelled", tick: tick(3), tripId: t1, driverId: d1 },
			pooledRequested(t3, 4),
			...matched(t3, 4),
		] satisfies Message[];

		expect(checkInvariants(log, grid)).toEqual([]);
	});
});

// ADR 0057: one rating per completed trip, by its rider, of its driver.
describe("checkInvariants ratings", () => {
	function rated(
		at: number,
		{ tripId = t1, riderId = r1, driverId = d1 } = {},
	): Message {
		return {
			type: "rider.rated_driver",
			tick: tick(at),
			riderId,
			tripId,
			driverId,
			stars: Stars.parse(4),
		};
	}

	test("a rating of a completed trip by its rider of its driver is clean", () => {
		expect(checkInvariants([...cleanTrip, rated(3)], grid)).toEqual([]);
	});

	test("a rating before its trip completed is flagged", () => {
		const beforeCompletion = cleanTrip.slice(0, -1);

		expect(checkInvariants([...beforeCompletion, rated(2)], grid)).toEqual([
			{
				type: "invalid_rating",
				tick: tick(2),
				tripId: t1,
				riderId: r1,
				driverId: d1,
			},
		]);
	});

	test("a rating naming another driver is flagged", () => {
		expect(
			checkInvariants([...cleanTrip, rated(3, { driverId: d2 })], grid),
		).toEqual([
			{
				type: "invalid_rating",
				tick: tick(3),
				tripId: t1,
				riderId: r1,
				driverId: d2,
			},
		]);
	});

	test("a rating by another rider is flagged", () => {
		const r2 = RiderId.parse("r-2");

		expect(
			checkInvariants([...cleanTrip, rated(3, { riderId: r2 })], grid),
		).toEqual([
			{
				type: "invalid_rating",
				tick: tick(3),
				tripId: t1,
				riderId: r2,
				driverId: d1,
			},
		]);
	});

	test("a rating of an unknown trip is flagged", () => {
		expect(
			checkInvariants([...cleanTrip, rated(3, { tripId: t2 })], grid),
		).toEqual([
			{
				type: "invalid_rating",
				tick: tick(3),
				tripId: t2,
				riderId: r1,
				driverId: d1,
			},
		]);
	});

	test("a second rating of one trip is flagged", () => {
		expect(checkInvariants([...cleanTrip, rated(3), rated(4)], grid)).toEqual([
			{ type: "duplicate_rating", tick: tick(4), tripId: t1 },
		]);
	});

	test("an invalid rating still counts as the trip's one rating", () => {
		const log = [...cleanTrip, rated(3, { driverId: d2 }), rated(4)];

		expect(checkInvariants(log, grid)).toEqual([
			{
				type: "invalid_rating",
				tick: tick(3),
				tripId: t1,
				riderId: r1,
				driverId: d2,
			},
			{ type: "duplicate_rating", tick: tick(4), tripId: t1 },
		]);
	});
});

// ADR 0060: a completion's fare is its trip's; a driver going offline
// reports the driver shares of its completions since it went online.
describe("checkInvariants earnings", () => {
	// cleanTrip's t1 rides 1 cell: base fare 250 + 2 × 1 cents.
	const baseFare = Fare.parse(252);

	function completed(
		tripId: TripId,
		driverId: DriverId,
		at: number,
		fare: Fare | undefined,
	): Message {
		return { type: "trip.completed", tick: tick(at), tripId, driverId, fare };
	}

	function tripWithFare(fare: Fare | undefined): Message[] {
		return [...cleanTrip.slice(0, -1), completed(t1, d1, 3, fare)];
	}

	test("a completion with its trip's base fare is clean", () => {
		expect(checkInvariants(tripWithFare(baseFare), grid)).toEqual([]);
	});

	test("a completion with another fare than its trip's is flagged", () => {
		expect(checkInvariants(tripWithFare(Fare.parse(300)), grid)).toEqual([
			{
				type: "fare_mismatch",
				tick: tick(3),
				tripId: t1,
				driverId: d1,
				fare: Fare.parse(300),
				expectedFare: Fare.parse(252),
			},
		]);
	});

	test("with earnings on a completion without a fare is flagged", () => {
		expect(
			checkInvariants(tripWithFare(undefined), grid, { earnings: true }),
		).toEqual([
			{
				type: "fare_mismatch",
				tick: tick(3),
				tripId: t1,
				driverId: d1,
				fare: null,
				expectedFare: baseFare,
			},
		]);
	});

	test("with earnings off a completion without a fare is clean", () => {
		expect(checkInvariants(tripWithFare(undefined), grid)).toEqual([]);
	});

	function wentOfflineEarning(earned: number | undefined, at: number): Message {
		return {
			type: "driver.went_offline",
			tick: tick(at),
			driverId: d1,
			cell: cell(2, 0),
			region: Region.parse(0),
			earned,
		};
	}

	// Driver share of 252: round(252 × 0.75) = 189.
	test("a driver going offline with the driver share of its completion is clean", () => {
		const log = [...tripWithFare(baseFare), wentOfflineEarning(189, 4)];

		expect(checkInvariants(log, grid, { earnings: true })).toEqual([]);
	});

	test("a driver going offline with another earned is flagged", () => {
		const log = [...tripWithFare(baseFare), wentOfflineEarning(100, 4)];

		expect(checkInvariants(log, grid, { earnings: true })).toEqual([
			{
				type: "earnings_mismatch",
				tick: tick(4),
				driverId: d1,
				earned: 100,
				expectedEarned: 189,
			},
		]);
	});

	test("with earnings on a driver going offline without earned is flagged", () => {
		const log = [...tripWithFare(baseFare), wentOfflineEarning(undefined, 4)];

		expect(checkInvariants(log, grid, { earnings: true })).toEqual([
			{
				type: "earnings_mismatch",
				tick: tick(4),
				driverId: d1,
				earned: null,
				expectedEarned: 189,
			},
		]);
	});

	// d1's second online period: t2 from (1,0) to (2,0), as t1 in its first.
	const secondPeriod: Message[] = [
		wentOfflineEarning(189, 4),
		wentOnline(i1, cell(2, 0)),
		requested(t2, 5),
		tripEvent("trip.offered", t2, d1, 5),
		tripEvent("trip.matched", t2, d1, 5),
		moved(i1, cell(1, 0), 6),
		tripEvent("trip.picked_up", t2, d1, 6),
		moved(i1, cell(2, 0), 7),
		completed(t2, d1, 7, baseFare),
	];

	test("each online period reports only its own completions", () => {
		const log = [
			...tripWithFare(baseFare),
			...secondPeriod,
			wentOfflineEarning(189, 8),
		];

		expect(checkInvariants(log, grid, { earnings: true })).toEqual([]);
	});

	test("an online period reporting the earnings of an earlier one is flagged", () => {
		const log = [
			...tripWithFare(baseFare),
			...secondPeriod,
			wentOfflineEarning(378, 8),
		];

		expect(checkInvariants(log, grid, { earnings: true })).toEqual([
			{
				type: "earnings_mismatch",
				tick: tick(8),
				driverId: d1,
				earned: 378,
				expectedEarned: 189,
			},
		]);
	});

	// Two pooled riders on d1, each paying 189: driver share 142 each.
	test("a driver of a pooled pair earns the driver share of each fare", () => {
		const pooledFare = Fare.parse(189);
		function pooledRequested(tripId: TripId): Message {
			return {
				type: "trip.requested",
				tick: tick(1),
				tripId,
				riderId: r1,
				pickup: cell(1, 0),
				dropoff: cell(2, 0),
				pooled: true,
			};
		}
		const log: Message[] = [
			wentOnline(i1, cell(0, 0)),
			pooledRequested(t1),
			pooledRequested(t2),
			tripEvent("trip.offered", t1, d1, 1),
			tripEvent("trip.matched", t1, d1, 1),
			tripEvent("trip.offered", t2, d1, 1),
			tripEvent("trip.matched", t2, d1, 1),
			moved(i1, cell(1, 0), 2),
			tripEvent("trip.picked_up", t1, d1, 2),
			tripEvent("trip.picked_up", t2, d1, 2),
			moved(i1, cell(2, 0), 3),
			completed(t1, d1, 3, pooledFare),
			completed(t2, d1, 3, pooledFare),
			wentOfflineEarning(284, 4),
		];

		expect(checkInvariants(log, grid, { earnings: true })).toEqual([]);
	});

	// With surge on the trip's fare is trip.requested's, here 1.5 × 252.
	function surgedTripWithFare(fare: Fare): Message[] {
		return tripWithFare(fare).with(2, {
			type: "trip.requested",
			tick: tick(1),
			tripId: t1,
			riderId: r1,
			pickup: cell(1, 0),
			dropoff: cell(2, 0),
			surge: Surge.parse(1.5),
			fare: Fare.parse(378),
		});
	}

	test("a completion with its trip's surged fare is clean", () => {
		expect(checkInvariants(surgedTripWithFare(Fare.parse(378)), grid)).toEqual(
			[],
		);
	});

	test("a completion with the base fare of a surged trip is flagged", () => {
		expect(checkInvariants(surgedTripWithFare(baseFare), grid)).toEqual([
			{
				type: "fare_mismatch",
				tick: tick(3),
				tripId: t1,
				driverId: d1,
				fare: Fare.parse(252),
				expectedFare: Fare.parse(378),
			},
		]);
	});

	// Pooled 25% off the base fare: round(252 × 0.75) = 189.
	function pooledTripWithFare(fare: Fare): Message[] {
		return tripWithFare(fare).with(2, {
			type: "trip.requested",
			tick: tick(1),
			tripId: t1,
			riderId: r1,
			pickup: cell(1, 0),
			dropoff: cell(2, 0),
			pooled: true,
		});
	}

	test("a pooled completion with the pooled base fare is clean", () => {
		expect(checkInvariants(pooledTripWithFare(Fare.parse(189)), grid)).toEqual(
			[],
		);
	});

	test("a pooled completion with the full base fare is flagged", () => {
		expect(checkInvariants(pooledTripWithFare(baseFare), grid)).toEqual([
			{
				type: "fare_mismatch",
				tick: tick(3),
				tripId: t1,
				driverId: d1,
				fare: Fare.parse(252),
				expectedFare: Fare.parse(189),
			},
		]);
	});
});

describe("createInvariantChecker", () => {
	// Completing t1 twice, then a 3-cell jump: one violation each.
	test("reports the violations of the messages observed so far", () => {
		const checker = createInvariantChecker(grid);
		const found: number[] = [];

		for (const message of [
			...cleanTrip,
			tripEvent("trip.completed", t1, d1, 4),
			moved(i1, cell(5, 0), 5),
		]) {
			checker.observe(message);
			found.push(checker.violations().length);
		}

		expect(found).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
	});
});
