import { expect, test } from "bun:test";
import type { DispatchInput, decideDispatch } from "../dispatch/brain.ts";
import type {
	DriverShardInput,
	decideDriverShard,
	startDriverShard,
} from "../driver/brain.ts";
import type { decideRiders, RidersInput } from "../rider/brain.ts";
import { type Cell, cellIn } from "./grid.ts";
import {
	type ClockTicked,
	DriverId,
	isSimEvent,
	type Message,
	parseMessage,
	RiderId,
	Tick,
	TripId,
} from "./messages.ts";

type OutputOf<Brain extends (...args: never[]) => { outputs: unknown[] }> =
	ReturnType<Brain>["outputs"][number];

type BrainMessage = Exclude<
	| DriverShardInput
	| DispatchInput
	| RidersInput
	| OutputOf<typeof startDriverShard>
	| OutputOf<typeof decideDriverShard>
	| OutputOf<typeof decideDispatch>
	| OutputOf<typeof decideRiders>,
	{ type: "input_rejected" }
>;

// The real check is `bun run typecheck`: this fails to compile when a brain
// consumes or publishes a type missing from Message.
const asMessage = (message: BrainMessage): Message => message;

test("every brain input and output is a Message", () => {
	const ticked: ClockTicked = { type: "clock.ticked", tick: Tick.parse(1) };
	expect(asMessage(ticked)).toBe(ticked);
});

const tick = Tick.parse(7);
const driverId = DriverId.parse("d-1");
const tripId = TripId.parse("t-1");
const riderId = RiderId.parse("r-1");

function cell(x: number, y: number): Cell {
	const result = cellIn({ width: 10, height: 10 }, x, y);
	if (!result.ok) throw new Error(`test cell (${x}, ${y}) outside grid`);
	return result.value;
}

const pickup = cell(1, 2);
const dropoff = cell(3, 4);

const samples: Message[] = [
	{ type: "clock.ticked", tick },
	{ type: "driver.went_online", tick, driverId, cell: pickup },
	{ type: "driver.moved", tick, driverId, cell: pickup },
	{ type: "driver.arrived_at_pickup", tick, driverId, tripId, cell: pickup },
	{ type: "driver.arrived_at_dropoff", tick, driverId, tripId, cell: dropoff },
	{ type: "trip.requested", tick, tripId, riderId, pickup, dropoff },
	{ type: "trip.offered", tick, tripId, driverId },
	{ type: "trip.offer_declined", tick, tripId, driverId },
	{ type: "trip.offer_expired", tick, tripId, driverId },
	{ type: "trip.matched", tick, tripId, driverId },
	{ type: "trip.picked_up", tick, tripId, driverId },
	{ type: "trip.completed", tick, tripId, driverId },
	{ type: "trip.cancelled", tick, tripId, driverId },
	{ type: "trip.cancelled", tick, tripId, driverId: null },
	{ type: "offer", tripId, driverId, pickup, dropoff },
	{ type: "offer_accepted", tripId, driverId },
	{ type: "offer_declined", tripId, driverId },
	{ type: "request_trip", tick, tripId, riderId, pickup, dropoff },
	{ type: "request_trip_accepted", tripId },
	{
		type: "request_trip_rejected",
		tripId,
		error: { type: "duplicate_trip_id" },
	},
	{ type: "cancel_trip", tripId },
	{ type: "cancel_trip_accepted", tripId },
	{ type: "cancel_trip_rejected", tripId, error: { type: "unknown_trip" } },
	{
		type: "cancel_trip_rejected",
		tripId,
		error: { type: "invalid_transition", from: "picked_up" },
	},
];

test.each(samples.map((message) => [message.type, message]))(
	"%s round-trips through JSON",
	(_type, message) => {
		const result = parseMessage(JSON.parse(JSON.stringify(message)));
		expect(result).toEqual({ ok: true, value: message });
	},
);

const invalidInputs: [string, unknown][] = [
	["not an object", "clock.ticked"],
	["unknown type", { type: "clock.stopped", tick: 1 }],
	["missing field", { type: "driver.moved", tick: 1, driverId: "d-1" }],
	["wrong field type", { type: "clock.ticked", tick: "1" }],
	["negative tick", { type: "clock.ticked", tick: -1 }],
	// IDs must be valid NATS subject tokens (sim.offers.<driverId>, ADR 0028).
	["trip ID with a dot", { type: "cancel_trip", tripId: "t.1" }],
	[
		"driver ID with a wildcard",
		{ type: "offer_accepted", tripId: "t-1", driverId: "d-*" },
	],
	[
		"rider ID with a space",
		{
			type: "request_trip",
			tick: 1,
			tripId: "t-1",
			riderId: "r 1",
			pickup: { x: 0, y: 0 },
			dropoff: { x: 0, y: 0 },
		},
	],
	[
		"non-integer cell",
		{ type: "driver.moved", tick: 1, driverId: "d-1", cell: { x: 1.5, y: 0 } },
	],
];

test.each(invalidInputs)("rejects %s as invalid_message", (_case, input) => {
	const result = parseMessage(input);
	expect(result).toMatchObject({
		ok: false,
		error: { type: "invalid_message", issues: expect.any(Array) },
	});
});

test("isSimEvent tells events from offers, replies, and commands", () => {
	const tripId = TripId.parse("t-1");
	const driverId = DriverId.parse("d-1");
	const messages: Message[] = [
		{ type: "clock.ticked", tick: Tick.parse(1) },
		{ type: "trip.matched", tick: Tick.parse(1), tripId, driverId },
		{ type: "offer_accepted", tripId, driverId },
		{ type: "cancel_trip", tripId },
		{ type: "cancel_trip_accepted", tripId },
	];

	expect(messages.map(isSimEvent)).toEqual([true, true, false, false, false]);
});
