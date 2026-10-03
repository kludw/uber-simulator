import { describe, expect, test } from "bun:test";
import { type Cell, cellIn, type Grid } from "../shared/grid.ts";
import {
	DriverId,
	type Message,
	RiderId,
	Tick,
	TripId,
} from "../shared/messages.ts";
import { checkInvariants, createInvariantChecker } from "./invariants.ts";

const grid: Grid = { width: 10, height: 10 };
const d1 = DriverId.parse("d-1");
const d2 = DriverId.parse("d-2");
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

function wentOnline(driverId: DriverId, at: Cell): Message {
	return { type: "driver.went_online", tick: tick(0), driverId, cell: at };
}

function wentOffline(driverId: DriverId, at: Cell, when: number): Message {
	return { type: "driver.went_offline", tick: tick(when), driverId, cell: at };
}

function moved(driverId: DriverId, to: Cell, at: number): Message {
	return { type: "driver.moved", tick: tick(at), driverId, cell: to };
}

// d1 starts at (0,0); t1 picks up at (1,0), drops off at (2,0).
const cleanTrip: Message[] = [
	wentOnline(d1, cell(0, 0)),
	{ type: "clock.ticked", tick: tick(1) },
	requested(t1, 1),
	tripEvent("trip.offered", t1, d1, 1),
	tripEvent("trip.matched", t1, d1, 1),
	moved(d1, cell(1, 0), 2),
	tripEvent("trip.picked_up", t1, d1, 2),
	moved(d1, cell(2, 0), 3),
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
			wentOnline(d1, cell(2, 0)),
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
			wentOnline(d1, cell(0, 0)),
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
			wentOnline(d1, cell(1, 0)),
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
		const log = [wentOnline(d1, cell(0, 0)), moved(d1, cell(2, 0), 1)];

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
			wentOnline(d1, cell(0, 0)),
			moved(d1, cell(1, 0), 1),
			moved(d1, cell(2, 0), 1),
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

	test("a driver moving off the grid is flagged", () => {
		// Built by hand: cellIn refuses cells outside the grid.
		const offGrid = { x: 10, y: 0 } as Cell;
		const log = [wentOnline(d1, cell(9, 0)), moved(d1, offGrid, 1)];

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
			{
				type: "driver.went_online",
				tick: tick(8),
				driverId: d1,
				cell: cell(2, 0),
			},
			moved(d1, cell(2, 1), 9),
		];

		expect(checkInvariants(log, grid)).toEqual([]);
	});

	test("an offline driver moving is flagged", () => {
		const log = [
			wentOnline(d1, cell(0, 0)),
			wentOffline(d1, cell(0, 0), 1),
			moved(d1, cell(1, 0), 2),
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
			wentOnline(d1, cell(0, 0)),
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
			wentOnline(d1, cell(0, 0)),
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
			wentOnline(d1, cell(0, 0)),
			requested(t1, 1),
			tripEvent("trip.offered", t1, d1, 1),
			wentOffline(d1, cell(0, 0), 1),
			freed,
			moved(d1, cell(1, 0), 3),
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

describe("createInvariantChecker", () => {
	// Completing t1 twice, then a 3-cell jump: one violation each.
	test("reports the violations of the messages observed so far", () => {
		const checker = createInvariantChecker(grid);
		const found: number[] = [];

		for (const message of [
			...cleanTrip,
			tripEvent("trip.completed", t1, d1, 4),
			moved(d1, cell(5, 0), 5),
		]) {
			checker.observe(message);
			found.push(checker.violations().length);
		}

		expect(found).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
	});
});
