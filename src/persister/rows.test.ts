import { describe, expect, test } from "bun:test";
import { Cell } from "../shared/grid.ts";
import {
	DriverId,
	driversMoved,
	RiderId,
	RunId,
	type SimEvent,
	Tick,
	TripId,
} from "../shared/messages.ts";
import { toRow } from "./rows.ts";

const tick = Tick.parse(12);
const tripId = TripId.parse("t-3");
const driverId = DriverId.parse("d-7");
const riderId = RiderId.parse("r-3");
const cell = Cell.parse({ x: 4, y: 5 });
const delivery = {
	runId: RunId.parse("run-1"),
	streamSeq: 99,
	ingestedAt: new Date("2026-10-03T12:00:00Z"),
};

describe("toRow", () => {
	// Every event type with the ID columns it fills; payload is the event JSON.
	const cases: [
		SimEvent,
		{ tripId: string; driverId: string; riderId: string },
	][] = [
		[
			{ type: "clock.ticked", tick },
			{ tripId: "", driverId: "", riderId: "" },
		],
		[
			{ type: "driver.went_online", tick, driverId, cell },
			{ tripId: "", driverId: "d-7", riderId: "" },
		],
		[
			{ type: "driver.went_offline", tick, driverId, cell },
			{ tripId: "", driverId: "d-7", riderId: "" },
		],
		// One row per message, the moves in the payload (ADR 0045).
		[
			driversMoved(tick, [{ driverId, cell }]),
			{ tripId: "", driverId: "", riderId: "" },
		],
		[
			{ type: "driver.arrived_at_pickup", tick, driverId, tripId, cell },
			{ tripId: "t-3", driverId: "d-7", riderId: "" },
		],
		[
			{ type: "driver.arrived_at_dropoff", tick, driverId, tripId, cell },
			{ tripId: "t-3", driverId: "d-7", riderId: "" },
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
			{ tripId: "t-3", driverId: "", riderId: "r-3" },
		],
		[
			{ type: "trip.offered", tick, tripId, driverId },
			{ tripId: "t-3", driverId: "d-7", riderId: "" },
		],
		[
			{ type: "trip.offer_declined", tick, tripId, driverId },
			{ tripId: "t-3", driverId: "d-7", riderId: "" },
		],
		[
			{ type: "trip.offer_expired", tick, tripId, driverId },
			{ tripId: "t-3", driverId: "d-7", riderId: "" },
		],
		[
			{ type: "trip.matched", tick, tripId, driverId },
			{ tripId: "t-3", driverId: "d-7", riderId: "" },
		],
		[
			{ type: "trip.picked_up", tick, tripId, driverId },
			{ tripId: "t-3", driverId: "d-7", riderId: "" },
		],
		[
			{ type: "trip.completed", tick, tripId, driverId },
			{ tripId: "t-3", driverId: "d-7", riderId: "" },
		],
		[
			{ type: "trip.cancelled", tick, tripId, driverId },
			{ tripId: "t-3", driverId: "d-7", riderId: "" },
		],
		[
			{ type: "trip.cancelled", tick, tripId, driverId: null },
			{ tripId: "t-3", driverId: "", riderId: "" },
		],
	];

	test.each(cases)("maps %o", (event, ids) => {
		expect(toRow(event, delivery)).toEqual({
			runId: RunId.parse("run-1"),
			type: event.type,
			tick: Tick.parse(12),
			streamSeq: 99,
			...ids,
			payload: JSON.stringify(event),
			ingestedAt: new Date("2026-10-03T12:00:00Z"),
		});
	});
});
