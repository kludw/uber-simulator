import { expect, test } from "bun:test";
import type { DispatchInput, decideDispatch } from "../dispatch/brain.ts";
import type {
	DriverShardInput,
	decideDriverShard,
	startDriverShard,
} from "../driver/brain.ts";
import type { decideRiders, RidersInput } from "../rider/brain.ts";
import { DriverIndex } from "./fleet.ts";
import { type Cell, cellIn } from "./grid.ts";
import {
	type ClockTicked,
	DriverId,
	type DriverMove,
	driversMoved,
	driversWentOnline,
	forEachDriverAt,
	forEachMove,
	forEachWentOnline,
	isSimEvent,
	type Message,
	parseMessage,
	RiderId,
	Tick,
	TripId,
} from "./messages.ts";
import { Region } from "./regions.ts";

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
	driversWentOnline(tick, Region.parse(0), 12, [
		{ driverIndex: DriverIndex.parse(1), cell: pickup },
		{ driverIndex: DriverIndex.parse(11), cell: dropoff },
	]),
	{
		type: "driver.went_offline",
		tick,
		driverId,
		cell: pickup,
		region: Region.parse(0),
	},
	driversMoved(tick, Region.parse(0), 12, [
		{ driverIndex: DriverIndex.parse(1), cell: pickup },
		{ driverIndex: DriverIndex.parse(11), cell: dropoff },
	]),
	{
		type: "driver.arrived_at_pickup",
		tick,
		driverId,
		tripId,
		cell: pickup,
		region: Region.parse(0),
	},
	{
		type: "driver.arrived_at_dropoff",
		tick,
		driverId,
		tripId,
		cell: dropoff,
		region: Region.parse(0),
	},
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
	{ type: "offer_accepted", tripId, driverId, region: Region.parse(0) },
	{
		type: "offer_declined",
		tripId,
		driverId,
		region: Region.parse(0),
		idleAt: null,
	},
	{
		type: "request_trip",
		tick,
		tripId,
		riderId,
		pickup,
		dropoff,
		region: Region.parse(0),
	},
	{ type: "request_trip_accepted", tripId },
	{
		type: "request_trip_rejected",
		tripId,
		error: { type: "duplicate_trip_id" },
	},
	{ type: "cancel_trip", tripId, region: Region.parse(0) },
	{ type: "cancel_trip_accepted", tripId },
	{ type: "cancel_trip_rejected", tripId, error: { type: "unknown_trip" } },
	{
		type: "cancel_trip_rejected",
		tripId,
		error: { type: "invalid_transition", from: "picked_up" },
	},
	{
		type: "confirm_trip",
		tripId,
		driverId,
		stage: "pickup",
		cell: pickup,
		region: Region.parse(0),
	},
	{
		type: "confirm_trip",
		tripId,
		driverId,
		stage: "dropoff",
		cell: dropoff,
		region: Region.parse(0),
	},
	{
		type: "trip_status",
		tripId,
		driverId,
		stage: "pickup",
		status: "picked_up",
	},
	{
		type: "trip_status",
		tripId,
		driverId,
		stage: "dropoff",
		status: "completed",
	},
	{
		type: "trip_status",
		tripId,
		driverId,
		stage: "pickup",
		status: "released",
	},
];

test.each(samples.map((message) => [message.type, message]))(
	"%s round-trips through JSON",
	(_type, message) => {
		const result = parseMessage(JSON.parse(JSON.stringify(message)));
		expect(result).toEqual({ ok: true, value: message });
	},
);

const oneMove = {
	type: "drivers.moved",
	tick: 1,
	fleetSize: 10,
	driverIndexes: [1],
	xs: [0],
	ys: [0],
};
const oneOnline = { ...oneMove, type: "drivers.went_online" };

const invalidInputs: [string, unknown][] = [
	["not an object", "clock.ticked"],
	["unknown type", { type: "clock.stopped", tick: 1 }],
	[
		"missing field",
		{
			type: "driver.went_offline",
			tick: 1,
			driverId: "d-1",
			region: Region.parse(0),
		},
	],
	["wrong field type", { type: "clock.ticked", tick: "1" }],
	["negative tick", { type: "clock.ticked", tick: -1 }],
	// IDs must be valid NATS subject tokens (sim.offers.<driverId>, ADR 0028).
	[
		"trip ID with a dot",
		{ type: "cancel_trip", tripId: "t.1", region: Region.parse(0) },
	],
	[
		"driver ID with a wildcard",
		{
			type: "offer_accepted",
			tripId: "t-1",
			driverId: "d-*",
			region: Region.parse(0),
		},
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
			region: Region.parse(0),
		},
	],
	[
		"confirm with an unknown stage",
		{
			type: "confirm_trip",
			tripId: "t-1",
			driverId: "d-1",
			stage: "en_route",
			cell: { x: 0, y: 0 },
			region: Region.parse(0),
		},
	],
	[
		"trip status with an unknown status",
		{
			type: "trip_status",
			tripId: "t-1",
			driverId: "d-1",
			stage: "pickup",
			status: "cancelled",
		},
	],
	[
		"moves with fewer x than driver indexes",
		{
			type: "drivers.moved",
			tick: 1,
			fleetSize: 10,
			driverIndexes: [1, 2],
			xs: [0],
			ys: [0, 0],
		},
	],
	[
		"moves with more y than driver indexes",
		{
			type: "drivers.moved",
			tick: 1,
			fleetSize: 10,
			driverIndexes: [1],
			xs: [0],
			ys: [0, 0],
		},
	],
	["move with a non-integer x", { ...oneMove, xs: [1.5] }],
	["move with a negative y", { ...oneMove, ys: [-1] }],
	["move with a string coordinate", { ...oneMove, xs: ["0"] }],
	["move with an unsafe integer x", { ...oneMove, xs: [2 ** 53] }],
	["moves with coordinates not in an array", { ...oneMove, xs: { 0: 0 } }],
	["moves without ys", { ...oneMove, ys: undefined }],
	["move with a negative driver index", { ...oneMove, driverIndexes: [-1] }],
	["move with a fractional driver index", { ...oneMove, driverIndexes: [1.5] }],
	["move with a string driver index", { ...oneMove, driverIndexes: ["1"] }],
	[
		"move with a driver index outside the fleet",
		{ ...oneMove, driverIndexes: [10] },
	],
	[
		"moves with driver indexes not in an array",
		{ ...oneMove, driverIndexes: 1 },
	],
	["moves without a fleet size", { ...oneMove, fleetSize: undefined }],
	[
		"moves in an empty fleet",
		{ ...oneMove, driverIndexes: [], xs: [], ys: [], fleetSize: 0 },
	],
	["moves in a fractional fleet", { ...oneMove, fleetSize: 10.5 }],
	// Stored before ADR 0052: replay skips them (stored_event_skipped).
	[
		"moves by driver ID",
		{ type: "drivers.moved", tick: 1, driverIds: ["d-1"], xs: [0], ys: [0] },
	],
	[
		"drivers online with fewer y than driver indexes",
		{
			type: "drivers.went_online",
			tick: 1,
			fleetSize: 10,
			driverIndexes: [1, 2],
			xs: [0, 0],
			ys: [0],
		},
	],
	["driver online at a negative x", { ...oneOnline, xs: [-1] }],
	[
		"driver online with a driver index outside the fleet",
		{ ...oneOnline, driverIndexes: [10] },
	],
	[
		"drivers online by driver ID",
		{
			type: "drivers.went_online",
			tick: 1,
			driverIds: ["d-1"],
			xs: [0],
			ys: [0],
		},
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
		driversMoved(Tick.parse(1), Region.parse(0), 1, []),
		{ type: "offer_accepted", tripId, driverId, region: Region.parse(0) },
		{ type: "cancel_trip", tripId, region: Region.parse(0) },
		{ type: "cancel_trip_accepted", tripId },
	];

	expect(messages.map(isSimEvent)).toEqual([
		true,
		true,
		true,
		false,
		false,
		false,
	]);
});

// IDs from the fleet's size: indexes 10 and 1 of a fleet of 12 (ADR 0052).
const moves: DriverMove[] = [
	{ driverIndex: DriverIndex.parse(10), cell: cell(1, 2) },
	{ driverIndex: DriverIndex.parse(1), cell: cell(3, 4) },
];

test("forEachMove visits a message's moves in order, by driver ID", () => {
	const visited: [string, Cell][] = [];

	forEachMove(driversMoved(tick, Region.parse(0), 12, moves), (id, at) => {
		visited.push([id, at]);
	});

	expect(visited).toEqual([
		["d-10", cell(1, 2)],
		["d-01", cell(3, 4)],
	]);
});

test("forEachWentOnline visits a message's drivers in order, by driver ID", () => {
	const visited: [string, Cell][] = [];

	forEachWentOnline(
		driversWentOnline(tick, Region.parse(0), 12, moves),
		(id, at) => {
			visited.push([id, at]);
		},
	);

	expect(visited).toEqual([
		["d-10", cell(1, 2)],
		["d-01", cell(3, 4)],
	]);
});

test("forEachDriverAt visits each driver's index and coordinates in order", () => {
	const visited: [number, number, number][] = [];

	forEachDriverAt(
		driversMoved(tick, Region.parse(0), 12, moves),
		(driverIndex, x, y) => {
			visited.push([driverIndex, x, y]);
		},
	);

	expect(visited).toEqual([
		[10, 1, 2],
		[1, 3, 4],
	]);
});

// ADR 0050: the ten types dispatch takes carry their region; runs stored
// before regions existed replay as region 0.
const storedWithoutRegion: Record<string, unknown>[] = [
	{
		type: "request_trip",
		tick: 1,
		tripId: "t-1",
		riderId: "r-1",
		pickup: { x: 0, y: 0 },
		dropoff: { x: 1, y: 0 },
		region: Region.parse(0),
	},
	{ type: "cancel_trip", tripId: "t-1", region: Region.parse(0) },
	{
		type: "offer_accepted",
		tripId: "t-1",
		driverId: "d-1",
		region: Region.parse(0),
	},
	{
		type: "offer_declined",
		tripId: "t-1",
		driverId: "d-1",
		idleAt: null,
		region: Region.parse(0),
	},
	{
		type: "driver.arrived_at_pickup",
		tick: 1,
		driverId: "d-1",
		tripId: "t-1",
		cell: { x: 0, y: 0 },
		region: Region.parse(0),
	},
	{
		type: "driver.arrived_at_dropoff",
		tick: 1,
		driverId: "d-1",
		tripId: "t-1",
		cell: { x: 0, y: 0 },
		region: Region.parse(0),
	},
	{
		type: "confirm_trip",
		tripId: "t-1",
		driverId: "d-1",
		stage: "pickup",
		cell: { x: 0, y: 0 },
		region: Region.parse(0),
	},
	{
		type: "drivers.went_online",
		tick: 1,
		fleetSize: 10,
		driverIndexes: [1],
		xs: [0],
		ys: [0],
	},
	{
		type: "driver.went_offline",
		tick: 1,
		driverId: "d-1",
		cell: { x: 0, y: 0 },
		region: Region.parse(0),
	},
	{
		type: "drivers.moved",
		tick: 1,
		fleetSize: 10,
		driverIndexes: [1],
		xs: [0],
		ys: [0],
	},
];

test.each(storedWithoutRegion.map((input) => [input.type, input]))(
	"%s without a region parses as region 0",
	(_type, input) => {
		expect(parseMessage(input)).toMatchObject({
			ok: true,
			value: { region: 0 },
		});
	},
);

test.each(storedWithoutRegion.map((input) => [input.type, input]))(
	"%s keeps the region it carries",
	(_type, input) => {
		expect(parseMessage({ ...input, region: 3 })).toMatchObject({
			ok: true,
			value: { region: 3 },
		});
	},
);

test.each(storedWithoutRegion.map((input) => [input.type, input]))(
	"%s with a negative region is invalid",
	(_type, input) => {
		expect(parseMessage({ ...input, region: -1 })).toMatchObject({
			ok: false,
		});
	},
);

test("offer_declined carries the declining driver's idle cell", () => {
	expect(
		parseMessage({
			type: "offer_declined",
			tripId: "t-1",
			driverId: "d-1",
			region: 0,
			idleAt: { x: 4, y: 5 },
		}),
	).toEqual({
		ok: true,
		value: {
			type: "offer_declined",
			tripId,
			driverId,
			region: Region.parse(0),
			idleAt: cell(4, 5),
		},
	});
});

test("offer_declined without idleAt is invalid", () => {
	expect(
		parseMessage({
			type: "offer_declined",
			tripId: "t-1",
			driverId: "d-1",
			region: 0,
		}),
	).toMatchObject({ ok: false });
});
