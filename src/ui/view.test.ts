import { describe, expect, test } from "bun:test";
import { Cell } from "../shared/grid.ts";
import {
	DriverId,
	driversMoved,
	driversWentOnline,
	RiderId,
	type SimEvent,
	Tick,
	TripId,
} from "../shared/messages.ts";
import { applyEvent, emptyView, type View } from "./view.ts";

const d1 = DriverId.parse("d-1");
const r1 = RiderId.parse("r-1");
const t1 = TripId.parse("t-1");

function cell(x: number, y: number): Cell {
	return Cell.parse({ x, y });
}

function tick(n: number): Tick {
	return Tick.parse(n);
}

// t1 for d1, one event per step: requested at 1, matched at 2, picked up at 5.
// Moves are left out; position is covered by its own tests.
const pickup = cell(3, 0);
const dropoff = cell(3, 5);
const trip: SimEvent[] = [
	online(d1, 0, cell(0, 0)),
	{
		type: "trip.requested",
		tick: tick(1),
		tripId: t1,
		riderId: r1,
		pickup,
		dropoff,
	},
	{ type: "trip.matched", tick: tick(2), tripId: t1, driverId: d1 },
	{
		type: "driver.arrived_at_pickup",
		tick: tick(5),
		driverId: d1,
		tripId: t1,
		cell: pickup,
	},
	{ type: "trip.picked_up", tick: tick(5), tripId: t1, driverId: d1 },
	{
		type: "driver.arrived_at_dropoff",
		tick: tick(10),
		driverId: d1,
		tripId: t1,
		cell: dropoff,
	},
	{ type: "trip.completed", tick: tick(10), tripId: t1, driverId: d1 },
];

function viewOf(events: SimEvent[]): View {
	return events.reduce(applyEvent, emptyView());
}

describe("drivers", () => {
	test("each driver one message announces online is idle at its cell", () => {
		const d2 = DriverId.parse("d-2");
		const view = viewOf([
			driversWentOnline(tick(0), [
				{ driverId: d1, cell: cell(2, 3) },
				{ driverId: d2, cell: cell(5, 5) },
			]),
		]);
		expect([...view.drivers]).toEqual([
			[
				d1,
				{
					state: "idle",
					cell: cell(2, 3),
					previousCell: cell(2, 3),
					movedAt: tick(0),
				},
			],
			[
				d2,
				{
					state: "idle",
					cell: cell(5, 5),
					previousCell: cell(5, 5),
					movedAt: tick(0),
				},
			],
		]);
	});

	test("drivers announced online in one message count as idle", () => {
		const d2 = DriverId.parse("d-2");
		const view = viewOf([
			driversWentOnline(tick(0), [
				{ driverId: d1, cell: cell(2, 3) },
				{ driverId: d2, cell: cell(5, 5) },
			]),
		]);
		expect(view.driversPerState.idle).toBe(2);
	});

	test("a move keeps the previous cell and the tick it moved at", () => {
		const view = viewOf([online(d1, 0, cell(2, 3)), moved(d1, 4, cell(2, 4))]);
		expect(view.drivers.get(d1)).toEqual({
			state: "idle",
			cell: cell(2, 4),
			previousCell: cell(2, 3),
			movedAt: tick(4),
		});
	});

	test("each move in one message moves its driver", () => {
		const d2 = DriverId.parse("d-2");
		const view = viewOf([
			...trip.slice(0, 3),
			online(d2, 0, cell(5, 5)),
			driversMoved(tick(3), [
				{ driverId: d1, cell: cell(1, 0) },
				{ driverId: d2, cell: cell(5, 6) },
			]),
		]);
		expect([...view.drivers]).toEqual([
			[
				d1,
				{
					state: "en_route",
					cell: cell(1, 0),
					previousCell: cell(0, 0),
					movedAt: tick(3),
				},
			],
			[
				d2,
				{
					state: "idle",
					cell: cell(5, 6),
					previousCell: cell(5, 5),
					movedAt: tick(3),
				},
			],
		]);
	});

	test("a matched driver is en route", () => {
		const view = viewOf(trip.slice(0, 3));
		expect(view.drivers.get(d1)?.state).toBe("en_route");
	});

	test("a driver arrived at pickup is at pickup", () => {
		const view = viewOf(trip.slice(0, 4));
		expect(view.drivers.get(d1)?.state).toBe("at_pickup");
	});

	test("a driver whose rider is picked up is on trip", () => {
		const view = viewOf(trip.slice(0, 5));
		expect(view.drivers.get(d1)?.state).toBe("on_trip");
	});

	test("a driver arrived at dropoff is at dropoff", () => {
		const view = viewOf(trip.slice(0, 6));
		expect(view.drivers.get(d1)?.state).toBe("at_dropoff");
	});

	test("a driver whose trip completed is idle again", () => {
		const view = viewOf(trip);
		expect(view.drivers.get(d1)?.state).toBe("idle");
	});

	test("the driver named by a cancelled trip is idle again", () => {
		const view = viewOf([...trip.slice(0, 3), cancelled(t1, d1, 3)]);
		expect(view.drivers.get(d1)?.state).toBe("idle");
	});
});

describe("waiting riders", () => {
	test("a requested trip has a waiting rider at its pickup", () => {
		const view = viewOf(trip.slice(0, 2));
		expect([...view.waitingRiders]).toEqual([
			[t1, { pickup: cell(3, 0), dropoff: cell(3, 5), requestedAt: tick(1) }],
		]);
	});

	test("a matched rider still waits", () => {
		const view = viewOf(trip.slice(0, 4));
		expect([...view.waitingRiders.keys()]).toEqual([t1]);
	});

	test("a picked up rider no longer waits", () => {
		const view = viewOf(trip.slice(0, 5));
		expect(view.waitingRiders.size).toBe(0);
	});

	test("a cancelled trip's rider no longer waits", () => {
		const view = viewOf([...trip.slice(0, 2), cancelled(t1, null, 3)]);
		expect(view.waitingRiders.size).toBe(0);
	});
});

describe("active trips", () => {
	test("a matched trip is active from pickup to dropoff", () => {
		const view = viewOf(trip.slice(0, 3));
		expect([...view.activeTrips]).toEqual([
			[t1, { driverId: d1, pickup: cell(3, 0), dropoff: cell(3, 5) }],
		]);
	});

	test("a picked up trip stays active", () => {
		const view = viewOf(trip.slice(0, 6));
		expect([...view.activeTrips.keys()]).toEqual([t1]);
	});

	test("a completed trip is no longer active", () => {
		const view = viewOf(trip);
		expect(view.activeTrips.size).toBe(0);
	});

	test("a cancelled trip is no longer active", () => {
		const view = viewOf([...trip.slice(0, 3), cancelled(t1, d1, 3)]);
		expect(view.activeTrips.size).toBe(0);
	});
});

describe("counters", () => {
	test("the current tick is the last clock tick", () => {
		const view = viewOf([
			{ type: "clock.ticked", tick: tick(1) },
			{ type: "clock.ticked", tick: tick(2) },
		]);
		expect(view.tick).toBe(tick(2));
	});

	test("completed and cancelled trips are counted", () => {
		const t2 = TripId.parse("t-2");
		const t3 = TripId.parse("t-3");
		const view = viewOf([
			...trip,
			requested(t2, 11, cell(1, 1), cell(2, 2)),
			requested(t3, 11, cell(1, 1), cell(2, 2)),
			cancelled(t2, null, 12),
			cancelled(t3, null, 13),
		]);
		expect({
			completed: view.tripsCompleted,
			cancelled: view.tripsCancelled,
		}).toEqual({ completed: 1, cancelled: 2 });
	});

	test("drivers are counted per state", () => {
		const d2 = DriverId.parse("d-2");
		const view = viewOf([
			...trip.slice(0, 3),
			online(d2, 0, cell(5, 5)),
			moved(d2, 1, cell(5, 6)),
		]);
		expect(view.driversPerState).toEqual({
			idle: 1,
			en_route: 1,
			at_pickup: 0,
			on_trip: 0,
			at_dropoff: 0,
		});
	});

	test("no mean ticks to pickup before any pickup", () => {
		expect(emptyView().meanTicksToPickup).toBeNull();
	});

	// t1 waits 4 ticks (1 -> 5), t2 waits 3 ticks (6 -> 9): mean 3.5.
	test("mean ticks to pickup averages request to pickup", () => {
		const d2 = DriverId.parse("d-2");
		const t2 = TripId.parse("t-2");
		const view = viewOf([
			...trip,
			online(d2, 0, cell(5, 5)),
			requested(t2, 6, cell(5, 6), cell(5, 9)),
			matched(t2, d2, 7),
			{ type: "trip.picked_up", tick: tick(9), tripId: t2, driverId: d2 },
		]);
		expect(view.meanTicksToPickup).toBe(3.5);
	});
});

describe("joining mid-run", () => {
	test("a driver first seen moving is idle at its cell", () => {
		const view = viewOf([moved(d1, 7, cell(4, 4))]);
		expect(view.drivers.get(d1)).toEqual({
			state: "idle",
			cell: cell(4, 4),
			previousCell: cell(4, 4),
			movedAt: tick(7),
		});
	});

	test("a driver first seen arriving at pickup is at pickup at that cell", () => {
		const view = viewOf([trip[3] as SimEvent]);
		expect(view.drivers.get(d1)).toEqual({
			state: "at_pickup",
			cell: cell(3, 0),
			previousCell: cell(3, 0),
			movedAt: tick(5),
		});
	});

	test("a driver first seen arriving at dropoff is at dropoff at that cell", () => {
		const view = viewOf([trip[5] as SimEvent]);
		expect(view.drivers.get(d1)).toEqual({
			state: "at_dropoff",
			cell: cell(3, 5),
			previousCell: cell(3, 5),
			movedAt: tick(10),
		});
	});

	test("trip events for an unknown trip and driver only count", () => {
		const view = viewOf(
			trip.slice(2).filter((e) => e.type.startsWith("trip.")),
		);
		expect(view).toEqual({
			...emptyView(),
			tripsCompleted: 1,
		});
	});
});

// Over NATS only per-publisher order holds (ADR 0028): a driver's arrival can
// reach the UI after dispatch's event that freed it.
describe("late arrivals", () => {
	test("an arrival after the driver's offer expired leaves it idle", () => {
		const view = viewOf([
			...trip.slice(0, 2),
			{ type: "trip.offered", tick: tick(2), tripId: t1, driverId: d1 },
			trip[3] as SimEvent,
			{ type: "trip.offer_expired", tick: tick(5), tripId: t1, driverId: d1 },
		]);
		expect(view.drivers.get(d1)?.state).toBe("idle");
	});

	test("an arrival after the trip was cancelled leaves the driver idle", () => {
		const view = viewOf([
			...trip.slice(0, 3),
			cancelled(t1, d1, 5),
			trip[3] as SimEvent,
		]);
		expect(view.drivers.get(d1)?.state).toBe("idle");
	});
});

describe("offers", () => {
	test("offer events leave the view unchanged", () => {
		const view = viewOf(trip.slice(0, 2));
		const offered = [
			{ type: "trip.offered", tick: tick(2), tripId: t1, driverId: d1 },
			{ type: "trip.offer_declined", tick: tick(3), tripId: t1, driverId: d1 },
			{ type: "trip.offer_expired", tick: tick(4), tripId: t1, driverId: d1 },
		] satisfies SimEvent[];
		expect(offered.reduce(applyEvent, view)).toBe(view);
	});
});

// ADR 0032: offline drivers are out of the view, not a state of it.
describe("going offline", () => {
	const wentOffline: SimEvent = {
		type: "driver.went_offline",
		tick: tick(4),
		driverId: d1,
		cell: cell(2, 3),
	};

	test("a driver going offline leaves the view", () => {
		const view = viewOf([online(d1, 0, cell(2, 3)), wentOffline]);
		expect(view.drivers.has(d1)).toBe(false);
	});

	test("a driver going offline is no longer counted", () => {
		const view = viewOf([online(d1, 0, cell(2, 3)), wentOffline]);
		expect(view.driversPerState.idle).toBe(0);
	});

	test.each<SimEvent>([
		cancelled(t1, d1, 5),
		{ type: "trip.offer_declined", tick: tick(5), tripId: t1, driverId: d1 },
		{ type: "trip.offer_expired", tick: tick(5), tripId: t1, driverId: d1 },
	])("$type naming an offline driver keeps it out of the view", (freed) => {
		const view = viewOf([
			online(d1, 0, cell(2, 3)),
			requested(t1, 1, pickup, dropoff),
			{ type: "trip.offered", tick: tick(4), tripId: t1, driverId: d1 },
			wentOffline,
			freed,
		]);
		expect(view.drivers.has(d1)).toBe(false);
	});

	test("a driver back online is idle at its cell", () => {
		const view = viewOf([
			online(d1, 0, cell(2, 3)),
			wentOffline,
			online(d1, 9, cell(2, 3)),
		]);
		expect(view.drivers.get(d1)?.state).toBe("idle");
	});
});

function online(driverId: DriverId, at: number, to: Cell): SimEvent {
	return driversWentOnline(tick(at), [{ driverId, cell: to }]);
}

function moved(driverId: DriverId, at: number, to: Cell): SimEvent {
	return driversMoved(tick(at), [{ driverId, cell: to }]);
}

function requested(
	tripId: TripId,
	at: number,
	pickup: Cell,
	dropoff: Cell,
): SimEvent {
	return {
		type: "trip.requested",
		tick: tick(at),
		tripId,
		riderId: r1,
		pickup,
		dropoff,
	};
}

function matched(tripId: TripId, driverId: DriverId, at: number): SimEvent {
	return { type: "trip.matched", tick: tick(at), tripId, driverId };
}

function cancelled(
	tripId: TripId,
	driverId: DriverId | null,
	at: number,
): SimEvent {
	return { type: "trip.cancelled", tick: tick(at), tripId, driverId };
}
