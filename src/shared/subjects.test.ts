import { describe, expect, test } from "bun:test";
import { Cell } from "./grid.ts";
import {
	DriverId,
	type Message,
	RiderId,
	RunId,
	Tick,
	TripId,
} from "./messages.ts";
import {
	replaySubject,
	replaySubjects,
	simEventSubjects,
	simSubjects,
	subjectFor,
} from "./subjects.ts";

const tick = Tick.parse(1);
const tripId = TripId.parse("t-1");
const driverId = DriverId.parse("d-7");
const riderId = RiderId.parse("r-1");
const cell = Cell.parse({ x: 0, y: 0 });

describe("subjectFor", () => {
	// Every Message type with its subject per ADR 0028.
	const cases: [Message, string][] = [
		[{ type: "clock.ticked", tick }, "sim.events.clock.ticked"],
		[
			{ type: "driver.went_online", tick, driverId, cell },
			"sim.events.driver.went_online",
		],
		[
			{ type: "driver.went_offline", tick, driverId, cell },
			"sim.events.driver.went_offline",
		],
		[{ type: "driver.moved", tick, driverId, cell }, "sim.events.driver.moved"],
		[
			{ type: "driver.arrived_at_pickup", tick, driverId, tripId, cell },
			"sim.events.driver.arrived_at_pickup",
		],
		[
			{ type: "driver.arrived_at_dropoff", tick, driverId, tripId, cell },
			"sim.events.driver.arrived_at_dropoff",
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
			{ type: "offer_accepted", tripId, driverId },
			"sim.replies.offer_accepted",
		],
		[
			{ type: "offer_declined", tripId, driverId },
			"sim.replies.offer_declined",
		],
		[
			{
				type: "request_trip",
				tick,
				tripId,
				riderId,
				pickup: cell,
				dropoff: cell,
			},
			"sim.commands.request_trip",
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
		[{ type: "cancel_trip", tripId }, "sim.commands.cancel_trip"],
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
			{ type: "confirm_trip", tripId, driverId, stage: "pickup", cell },
			"sim.commands.confirm_trip",
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
});

test("simSubjects is the wildcard over every service subject", () => {
	expect(simSubjects).toBe("sim.>");
});

test("simEventSubjects is the wildcard over every event subject", () => {
	expect(simEventSubjects).toBe("sim.events.>");
});

test("replaySubject prefixes the live subject with replay and the run id", () => {
	expect(
		replaySubject(RunId.parse("run-1"), {
			type: "driver.moved",
			tick,
			driverId,
			cell,
		}),
	).toBe("replay.run-1.sim.events.driver.moved");
});

test("replaySubjects is the wildcard over a run's replayed event subjects", () => {
	expect(replaySubjects(RunId.parse("run-1"))).toBe(
		"replay.run-1.sim.events.>",
	);
});
