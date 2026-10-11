import * as z from "zod";
import { type DriverIndex, driverIdAt } from "./fleet.ts";
import { Cell, type Coordinate, cellAt } from "./grid.ts";
import { Region } from "./regions.ts";
import type { Result } from "./result.ts";
import { Fare, Surge, Zone } from "./surge.ts";

// IDs are valid NATS subject tokens (sim.offers.<driverId>, ADR 0028).
const idPattern = /^[A-Za-z0-9_-]+$/;
const idToken = z.string().regex(idPattern);

export const DriverId = idToken.brand<"DriverId">();
export type DriverId = z.infer<typeof DriverId>;

export const Tick = z.int().nonnegative().brand<"Tick">();
export type Tick = z.infer<typeof Tick>;

export const TripId = idToken.brand<"TripId">();
export type TripId = z.infer<typeof TripId>;

export const RiderId = idToken.brand<"RiderId">();
export type RiderId = z.infer<typeof RiderId>;

// Not in any message: the Run-Id NATS header (ADR 0029). Same charset keeps
// it a safe header value, ClickHouse value, and CLI argument.
export const RunId = idToken.brand<"RunId">();
export type RunId = z.infer<typeof RunId>;

// The region owning a message dispatch takes (ADR 0050). Absent in runs
// stored before regions: region 0, the one region they had.
const OwningRegion = Region.default(Region.parse(0));

export const ClockTicked = z.object({
	type: z.literal("clock.ticked"),
	tick: Tick,
});
export type ClockTicked = z.infer<typeof ClockTicked>;

export const DriverWentOffline = z.object({
	type: z.literal("driver.went_offline"),
	tick: Tick,
	driverId: DriverId,
	cell: Cell,
	region: OwningRegion,
});
export type DriverWentOffline = z.infer<typeof DriverWentOffline>;

// drivers.moved's and drivers.went_online's arrays are checked in one pass
// each, not by a schema per element: z.array runs its element schema on every
// entry and copies the array, most of drivers.moved's Zod time (ADR 0047,
// 0049; docs/performance-history.md, Dispatch moves profile). Same rules as
// DriverIndex and Coordinate, so the result is branded as they would brand it.
const DriverIndexes = z.custom<DriverIndex[]>(
	(indexes) =>
		Array.isArray(indexes) &&
		indexes.every((index) => Number.isSafeInteger(index) && index >= 0),
);
const Coordinates = z.custom<Coordinate[]>(
	(coordinates) =>
		Array.isArray(coordinates) &&
		coordinates.every((c) => Number.isSafeInteger(c) && c >= 0),
);

// Entry i is the driver with index driverIndexes[i] at cell (xs[i], ys[i]):
// parallel arrays decode faster than an object per driver (ADR 0047), and an
// index faster than a driver ID (ADR 0052). fleetSize names the IDs, so each
// message reads alone.
function driverCells<Type extends string>(type: Type) {
	return z
		.object({
			type: z.literal(type),
			tick: Tick,
			region: OwningRegion,
			fleetSize: z.int().positive(),
			driverIndexes: DriverIndexes,
			xs: Coordinates,
			ys: Coordinates,
		})
		.refine(
			(message) =>
				message.xs.length === message.driverIndexes.length &&
				message.ys.length === message.driverIndexes.length,
			{ error: "driverIndexes, xs, and ys differ in length" },
		)
		.refine(
			(message) =>
				message.driverIndexes.every((index) => index < message.fleetSize),
			{ error: "driver index outside the fleet" },
		);
}

// A shard's moves of a tick, in chunks, published after its drivers.went_online
// and before its other events of that tick (ADR 0045, 0049). Build with
// driversMoved, read with forEachMove.
export const DriversMoved = driverCells("drivers.moved");
export type DriversMoved = z.infer<typeof DriversMoved>;
export type DriverMove = { driverIndex: DriverIndex; cell: Cell };

// A shard's drivers going online in a tick (at start, or a shift change), in
// chunks, published first in that tick (ADR 0049). Build with
// driversWentOnline, read with forEachWentOnline.
export const DriversWentOnline = driverCells("drivers.went_online");
export type DriversWentOnline = z.infer<typeof DriversWentOnline>;

export function driversMoved(
	tick: Tick,
	region: Region,
	fleetSize: number,
	moves: DriverMove[],
): DriversMoved {
	return { type: "drivers.moved", tick, region, ...toArrays(fleetSize, moves) };
}

export function driversWentOnline(
	tick: Tick,
	region: Region,
	fleetSize: number,
	drivers: DriverMove[],
): DriversWentOnline {
	return {
		type: "drivers.went_online",
		tick,
		region,
		...toArrays(fleetSize, drivers),
	};
}

function toArrays(
	fleetSize: number,
	entries: DriverMove[],
): {
	fleetSize: number;
	driverIndexes: DriverIndex[];
	xs: Coordinate[];
	ys: Coordinate[];
} {
	return {
		fleetSize,
		driverIndexes: entries.map((entry) => entry.driverIndex),
		xs: entries.map((entry) => entry.cell.x),
		ys: entries.map((entry) => entry.cell.y),
	};
}

type Visit = (driverId: DriverId, cell: Cell) => void;

export const forEachMove: (moved: DriversMoved, visit: Visit) => void =
	forEachDriverCell;

export const forEachWentOnline: (
	wentOnline: DriversWentOnline,
	visit: Visit,
) => void = forEachDriverCell;

function forEachDriverCell(
	message: DriversMoved | DriversWentOnline,
	visit: Visit,
): void {
	forEachDriverAt(message, (index, x, y) =>
		visit(driverIdAt(message.fleetSize, index), cellAt(x, y)),
	);
}

// forEachMove / forEachWentOnline by driver index and without a Cell per
// driver, for a reader that keeps drivers by index and only the coordinates
// (dispatch, ADR 0052, docs/performance-history.md).
export function forEachDriverAt(
	message: DriversMoved | DriversWentOnline,
	visit: (driverIndex: DriverIndex, x: Coordinate, y: Coordinate) => void,
): void {
	for (let i = 0; i < message.driverIndexes.length; i++) {
		const index = message.driverIndexes[i];
		const x = message.xs[i];
		const y = message.ys[i];
		// Equal lengths: checked by the schema, kept by the builders.
		if (index === undefined || x === undefined || y === undefined) {
			throw new Error(`${message.type} arrays differ in length`);
		}
		visit(index, x, y);
	}
}

export const DriverArrivedAtPickup = z.object({
	type: z.literal("driver.arrived_at_pickup"),
	tick: Tick,
	driverId: DriverId,
	tripId: TripId,
	cell: Cell,
	region: OwningRegion,
});
export type DriverArrivedAtPickup = z.infer<typeof DriverArrivedAtPickup>;

export const TripPickedUp = z.object({
	type: z.literal("trip.picked_up"),
	tick: Tick,
	tripId: TripId,
	driverId: DriverId,
});
export type TripPickedUp = z.infer<typeof TripPickedUp>;

export const DriverArrivedAtDropoff = z.object({
	type: z.literal("driver.arrived_at_dropoff"),
	tick: Tick,
	driverId: DriverId,
	tripId: TripId,
	cell: Cell,
	region: OwningRegion,
});
export type DriverArrivedAtDropoff = z.infer<typeof DriverArrivedAtDropoff>;

export const TripCompleted = z.object({
	type: z.literal("trip.completed"),
	tick: Tick,
	tripId: TripId,
	driverId: DriverId,
});
export type TripCompleted = z.infer<typeof TripCompleted>;

// driverId: the driver to free, matched or holding the pending offer (it may
// have accepted concurrently); null when no driver was involved.
export const TripCancelled = z.object({
	type: z.literal("trip.cancelled"),
	tick: Tick,
	tripId: TripId,
	driverId: DriverId.nullable(),
});
export type TripCancelled = z.infer<typeof TripCancelled>;

export const TripOffered = z.object({
	type: z.literal("trip.offered"),
	tick: Tick,
	tripId: TripId,
	driverId: DriverId,
});
export type TripOffered = z.infer<typeof TripOffered>;

export const TripMatched = z.object({
	type: z.literal("trip.matched"),
	tick: Tick,
	tripId: TripId,
	driverId: DriverId,
});
export type TripMatched = z.infer<typeof TripMatched>;

export const TripOfferDeclined = z.object({
	type: z.literal("trip.offer_declined"),
	tick: Tick,
	tripId: TripId,
	driverId: DriverId,
});
export type TripOfferDeclined = z.infer<typeof TripOfferDeclined>;

export const TripOfferExpired = z.object({
	type: z.literal("trip.offer_expired"),
	tick: Tick,
	tripId: TripId,
	driverId: DriverId,
});
export type TripOfferExpired = z.infer<typeof TripOfferExpired>;

// Brain output for an input addressed to it but invalid for the current
// state (stale or out-of-order message). Shells log it, never publish it.
export type InputRejected<Input, Reason extends string> = {
	type: "input_rejected";
	reason: Reason;
	input: Input;
};

// A pooled trip's rider opted in to pooling (ADR 0056): true on its
// request_trip, trip.requested and offers; absent otherwise, never false.
const Pooled = z.literal(true).optional();

export const Offer = z.object({
	type: z.literal("offer"),
	tripId: TripId,
	driverId: DriverId,
	pickup: Cell,
	dropoff: Cell,
	pooled: Pooled,
});
export type Offer = z.infer<typeof Offer>;

export const OfferAccepted = z.object({
	type: z.literal("offer_accepted"),
	tripId: TripId,
	driverId: DriverId,
	region: OwningRegion,
});
export type OfferAccepted = z.infer<typeof OfferAccepted>;

// idleAt: the driver's cell if it is idle, else null (offline, or on a trip),
// so dispatch can correct or drop its view of the driver (ADR 0050).
export const OfferDeclined = z.object({
	type: z.literal("offer_declined"),
	tripId: TripId,
	driverId: DriverId,
	region: OwningRegion,
	idleAt: Cell.nullable(),
});
export type OfferDeclined = z.infer<typeof OfferDeclined>;

// Command from the rider service; dispatch answers with a reply, not an event.
export const RequestTrip = z.object({
	type: z.literal("request_trip"),
	tick: Tick,
	tripId: TripId,
	riderId: RiderId,
	pickup: Cell,
	dropoff: Cell,
	region: OwningRegion,
	// The rider's quote, the price of the trip (ADR 0054); absent with surge off.
	surge: Surge.optional(),
	pooled: Pooled,
});
export type RequestTrip = z.infer<typeof RequestTrip>;

// One region's surge zones above 1.0, in zone order, every pricing tick
// (ADR 0054); zones not listed are 1.0, so it is published even when empty.
// Zones are below the grid's zone count: not checked here, a message can't
// know the grid (like Cell).
export const ZonesPriced = z.object({
	type: z.literal("zones.priced"),
	tick: Tick,
	region: Region,
	zones: z.array(
		z.object({
			zone: Zone,
			surge: Surge.refine((surge) => surge > 1, {
				error: "a priced zone surges above 1.0",
			}),
		}),
	),
});
export type ZonesPriced = z.infer<typeof ZonesPriced>;

// A spawned rider whose quote exceeded its max surge: it leaves, no trip.
// Max surge is at least 1.0, so a declined quote is above 1.0.
export const RiderDeclinedSurge = z.object({
	type: z.literal("rider.declined_surge"),
	tick: Tick,
	riderId: RiderId,
	pickup: Cell,
	surge: Surge.refine((surge) => surge > 1, {
		error: "a declined quote surges above 1.0",
	}),
});
export type RiderDeclinedSurge = z.infer<typeof RiderDeclinedSurge>;

export const RequestTripAccepted = z.object({
	type: z.literal("request_trip_accepted"),
	tripId: TripId,
});
export type RequestTripAccepted = z.infer<typeof RequestTripAccepted>;

export const RequestTripRejected = z.object({
	type: z.literal("request_trip_rejected"),
	tripId: TripId,
	error: z.object({ type: z.literal("duplicate_trip_id") }),
});
export type RequestTripRejected = z.infer<typeof RequestTripRejected>;

// Command from the rider service; dispatch answers with a reply, not an event.
export const CancelTrip = z.object({
	type: z.literal("cancel_trip"),
	tripId: TripId,
	region: OwningRegion,
});
export type CancelTrip = z.infer<typeof CancelTrip>;

export const CancelTripAccepted = z.object({
	type: z.literal("cancel_trip_accepted"),
	tripId: TripId,
});
export type CancelTripAccepted = z.infer<typeof CancelTripAccepted>;

export const CancelTripRejected = z.object({
	type: z.literal("cancel_trip_rejected"),
	tripId: TripId,
	error: z.discriminatedUnion("type", [
		z.object({ type: z.literal("unknown_trip") }),
		z.object({
			type: z.literal("invalid_transition"),
			from: z.enum(["picked_up", "completed", "cancelled"]),
		}),
	]),
});
export type CancelTripRejected = z.infer<typeof CancelTripRejected>;

// Command from a driver waiting at its pickup or dropoff (ADR 0041); dispatch
// answers with trip_status, runs the arrival, stays silent, or rejects it.
const Stage = z.enum(["pickup", "dropoff"]);

export const ConfirmTrip = z.object({
	type: z.literal("confirm_trip"),
	tripId: TripId,
	driverId: DriverId,
	stage: Stage,
	cell: Cell,
	region: OwningRegion,
});
export type ConfirmTrip = z.infer<typeof ConfirmTrip>;

// Reply to confirm_trip, echoing its stage (ADR 0041).
export const TripStatus = z.object({
	type: z.literal("trip_status"),
	tripId: TripId,
	driverId: DriverId,
	stage: Stage,
	status: z.enum(["picked_up", "completed", "released"]),
});
export type TripStatus = z.infer<typeof TripStatus>;

// surge and fare: the trip's price, fixed at request (ADR 0054); both absent
// with surge off.
export const TripRequested = z
	.object({
		type: z.literal("trip.requested"),
		tick: Tick,
		tripId: TripId,
		riderId: RiderId,
		pickup: Cell,
		dropoff: Cell,
		surge: Surge.optional(),
		fare: Fare.optional(),
		pooled: Pooled,
	})
	.refine(
		(requested) =>
			(requested.surge === undefined) === (requested.fare === undefined),
		{ error: "surge and fare come together" },
	);
export type TripRequested = z.infer<typeof TripRequested>;

// Every message published on the bus (ADR 0027). InputRejected is not one:
// shells log it, never publish it.
const Message = z.discriminatedUnion("type", [
	ClockTicked,
	DriversWentOnline,
	DriverWentOffline,
	DriversMoved,
	DriverArrivedAtPickup,
	DriverArrivedAtDropoff,
	TripRequested,
	TripOffered,
	TripOfferDeclined,
	TripOfferExpired,
	TripMatched,
	TripPickedUp,
	TripCompleted,
	TripCancelled,
	Offer,
	OfferAccepted,
	OfferDeclined,
	RequestTrip,
	RequestTripAccepted,
	RequestTripRejected,
	CancelTrip,
	CancelTripAccepted,
	CancelTripRejected,
	ConfirmTrip,
	TripStatus,
	ZonesPriced,
	RiderDeclinedSurge,
]);
export type Message = z.infer<typeof Message>;

export type MessageType = Message["type"];

// The message of one type, e.g. what a subscription to that type delivers.
export type MessageOf<Type extends MessageType> = Extract<
	Message,
	{ type: Type }
>;

// Every message type, for a subscriber taking everything (a run's recorder).
export const messageTypes: readonly MessageType[] = Message.options.map(
	(option) => option.shape.type.value,
);

export function isOneOf<Type extends MessageType>(
	types: ReadonlySet<Type>,
	message: Message,
): message is MessageOf<Type> {
	const anyTypes: ReadonlySet<MessageType> = types;
	return anyTypes.has(message.type);
}

// What sim.events.> carries (ADR 0028): events, never offers, offer replies,
// commands, or command replies.
export type SimEvent = Extract<
	Message,
	{
		type: `${"clock" | "driver" | "drivers" | "trip" | "zones" | "rider"}.${string}`;
	}
>;

// sim.events.> carries only events, but a payload is untrusted.
export function isSimEvent(message: Message): message is SimEvent {
	return /^(clock|drivers?|trip|zones|rider)\./.test(message.type);
}

// Issues are Zod's plain data (code, path, message), fine to log; ZodError
// itself never leaves this function.
export function parseMessage(
	input: unknown,
): Result<Message, { type: "invalid_message"; issues: z.core.$ZodIssue[] }> {
	const parsed = Message.safeParse(input);
	if (!parsed.success) {
		return {
			ok: false,
			error: { type: "invalid_message", issues: parsed.error.issues },
		};
	}
	return { ok: true, value: parsed.data };
}
