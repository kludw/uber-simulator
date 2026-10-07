import { describe, expect, test } from "bun:test";
import { DriverIndex, driverIdAt } from "./fleet.ts";
import { Cell } from "./grid.ts";
import {
	driversMoved,
	driversWentOnline,
	type Message,
	RiderId,
	RunId,
	Tick,
	TripId,
} from "./messages.ts";
import { Region } from "./regions.ts";
import {
	replaySubject,
	replaySubjects,
	simEventSubjects,
	subjectFor,
	subscriptionSubject,
} from "./subjects.ts";

const tick = Tick.parse(1);
const tripId = TripId.parse("t-1");
// Drivers of a fleet of 10: IDs d-0 to d-9 (ADR 0052).
const fleetSize = 10;
const driverIndex = DriverIndex.parse(7);
const driverId = driverIdAt(fleetSize, driverIndex);
const riderId = RiderId.parse("r-1");
const cell = Cell.parse({ x: 0, y: 0 });
const region = Region.parse(2);

describe("subjectFor", () => {
	// Every Message type with its subject per ADR 0028.
	const cases: [Message, string][] = [
		[{ type: "clock.ticked", tick }, "sim.events.clock.ticked"],
		[
			driversWentOnline(tick, region, fleetSize, [{ driverIndex, cell }]),
			"sim.events.drivers.went_online.region-2",
		],
		[
			{
				type: "driver.went_offline",
				tick,
				driverId,
				cell,
				region: region,
			},
			"sim.events.driver.went_offline.region-2",
		],
		[
			driversMoved(tick, region, fleetSize, [{ driverIndex, cell }]),
			"sim.events.drivers.moved.region-2",
		],
		[
			{
				type: "driver.arrived_at_pickup",
				tick,
				driverId,
				tripId,
				cell,
				region: region,
			},
			"sim.events.driver.arrived_at_pickup.region-2",
		],
		[
			{
				type: "driver.arrived_at_dropoff",
				tick,
				driverId,
				tripId,
				cell,
				region: region,
			},
			"sim.events.driver.arrived_at_dropoff.region-2",
		],
		[
			{
				type: "trip.requested",
				tick,
				tripId,
				riderId,
				pickup: cell,
				dropoff: cell,
			},
			"sim.events.trip.requested",
		],
		[
			{ type: "trip.offered", tick, tripId, driverId },
			"sim.events.trip.offered",
		],
		[
			{ type: "trip.offer_declined", tick, tripId, driverId },
			"sim.events.trip.offer_declined",
		],
		[
			{ type: "trip.offer_expired", tick, tripId, driverId },
			"sim.events.trip.offer_expired",
		],
		[
			{ type: "trip.matched", tick, tripId, driverId },
			"sim.events.trip.matched",
		],
		[
			{ type: "trip.picked_up", tick, tripId, driverId },
			"sim.events.trip.picked_up",
		],
		[
			{ type: "trip.completed", tick, tripId, driverId },
			"sim.events.trip.completed",
		],
		[
			{ type: "trip.cancelled", tick, tripId, driverId: null },
			"sim.events.trip.cancelled",
		],
		[
			{ type: "offer", tripId, driverId, pickup: cell, dropoff: cell },
			"sim.offers.d-7",
		],
		[
			{ type: "offer_accepted", tripId, driverId, region: region },
			"sim.replies.offer_accepted.region-2",
		],
		[
			{
				type: "offer_declined",
				tripId,
				driverId,
				region: region,
				idleAt: null,
			},
			"sim.replies.offer_declined.region-2",
		],
		[
			{
				type: "request_trip",
				tick,
				tripId,
				riderId,
				pickup: cell,
				dropoff: cell,
				region: region,
			},
			"sim.commands.request_trip.region-2",
		],
		[
			{ type: "request_trip_accepted", tripId },
			"sim.replies.request_trip_accepted",
		],
		[
			{
				type: "request_trip_rejected",
				tripId,
				error: { type: "duplicate_trip_id" },
			},
			"sim.replies.request_trip_rejected",
		],
		[
			{ type: "cancel_trip", tripId, region: region },
			"sim.commands.cancel_trip.region-2",
		],
		[
			{ type: "cancel_trip_accepted", tripId },
			"sim.replies.cancel_trip_accepted",
		],
		[
			{
				type: "cancel_trip_rejected",
				tripId,
				error: { type: "unknown_trip" },
			},
			"sim.replies.cancel_trip_rejected",
		],
		[
			{
				type: "confirm_trip",
				tripId,
				driverId,
				stage: "pickup",
				cell,
				region: region,
			},
			"sim.commands.confirm_trip.region-2",
		],
		[
			{
				type: "trip_status",
				tripId,
				driverId,
				stage: "pickup",
				status: "released",
			},
			"sim.replies.trip_status",
		],
	];

	test.each(cases)("%p goes on %s", (message, subject) => {
		expect(subjectFor(message)).toBe(subject);
	});

	// ADR 0042: one subscription per type a service takes; offers for any
	// driver, so a shard needs one subscription, not one per driver. ADR
	// 0050: a subscriber without a region takes every region.
	test.each(cases)(
		"%p is received on the subscription to its type",
		(message, subject) => {
			expect(subscriptionSubject(message.type)).toBe(
				message.type === "offer"
					? "sim.offers.*"
					: subject.replace(/\.region-2$/, ".*"),
			);
		},
	);

	// ADR 0050: dispatch k takes its region's messages, and unregioned types
	// as everyone does.
	test.each(cases)(
		"%p is received on the subscription to its type for its region",
		(message, subject) => {
			expect(subscriptionSubject(message.type, region)).toBe(
				message.type === "offer" ? "sim.offers.*" : subject,
			);
		},
	);
});

test("a region's subscription excludes other regions' messages", () => {
	expect(subscriptionSubject("drivers.moved", Region.parse(1))).toBe(
		"sim.events.drivers.moved.region-1",
	);
});

test("simEventSubjects is the wildcard over every event subject", () => {
	expect(simEventSubjects).toBe("sim.events.>");
});

test("replaySubject prefixes the live subject with replay and the run id", () => {
	expect(
		replaySubject(
			RunId.parse("run-1"),
			driversMoved(tick, region, fleetSize, [{ driverIndex, cell }]),
		),
	).toBe("replay.run-1.sim.events.drivers.moved.region-2");
});

test("replaySubjects is the wildcard over a run's replayed event subjects", () => {
	expect(replaySubjects(RunId.parse("run-1"))).toBe(
		"replay.run-1.sim.events.>",
	);
});
