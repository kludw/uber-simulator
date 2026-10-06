import * as z from "zod";
import { Cell } from "./grid.ts";
import type { Result } from "./result.ts";

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

export const ClockTicked = z.object({
	type: z.literal("clock.ticked"),
	tick: Tick,
});
export type ClockTicked = z.infer<typeof ClockTicked>;

export const DriverWentOnline = z.object({
	type: z.literal("driver.went_online"),
	tick: Tick,
	driverId: DriverId,
	cell: Cell,
});
export type DriverWentOnline = z.infer<typeof DriverWentOnline>;

export const DriverWentOffline = z.object({
	type: z.literal("driver.went_offline"),
	tick: Tick,
	driverId: DriverId,
	cell: Cell,
});
export type DriverWentOffline = z.infer<typeof DriverWentOffline>;

// drivers.moved's arrays are checked by one refine each, not a schema per
// element, which was most of this message's Zod time (ADR 0047). Same rules
// as DriverId and Cell.
const MovedDriverIds = z
	.array(z.string())
	.refine((ids) => ids.every((id) => idPattern.test(id)));
const Coordinates = z
	.array(z.number())
	.refine((coordinates) =>
		coordinates.every((c) => Number.isSafeInteger(c) && c >= 0),
	);

// Move i is driver driverIds[i] stepping to cell (xs[i], ys[i]): parallel
// arrays decode faster than an object per move (ADR 0047). A shard publishes
// its moves of a tick in chunks, before its other events of that tick
// (ADR 0045). Build with driversMoved, read with forEachMove.
export const DriversMoved = z
	.object({
		type: z.literal("drivers.moved"),
		tick: Tick,
		driverIds: MovedDriverIds,
		xs: Coordinates,
		ys: Coordinates,
	})
	.refine(
		(moved) =>
			moved.xs.length === moved.driverIds.length &&
			moved.ys.length === moved.driverIds.length,
		{ error: "driverIds, xs, and ys differ in length" },
	);
export type DriversMoved = z.infer<typeof DriversMoved>;
export type DriverMove = { driverId: DriverId; cell: Cell };

export function driversMoved(tick: Tick, moves: DriverMove[]): DriversMoved {
	return {
		type: "drivers.moved",
		tick,
		driverIds: moves.map((move) => move.driverId),
		xs: moves.map((move) => move.cell.x),
		ys: moves.map((move) => move.cell.y),
	};
}

export function forEachMove(
	moved: DriversMoved,
	visit: (driverId: DriverId, cell: Cell) => void,
): void {
	for (let i = 0; i < moved.driverIds.length; i++) {
		// Parsed or built from moves: a valid DriverId and Cell.
		const cell = { x: moved.xs[i], y: moved.ys[i] } as Cell;
		visit(moved.driverIds[i] as DriverId, cell);
	}
}

export const DriverArrivedAtPickup = z.object({
	type: z.literal("driver.arrived_at_pickup"),
	tick: Tick,
	driverId: DriverId,
	tripId: TripId,
	cell: Cell,
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

export const Offer = z.object({
	type: z.literal("offer"),
	tripId: TripId,
	driverId: DriverId,
	pickup: Cell,
	dropoff: Cell,
});
export type Offer = z.infer<typeof Offer>;

export const OfferAccepted = z.object({
	type: z.literal("offer_accepted"),
	tripId: TripId,
	driverId: DriverId,
});
export type OfferAccepted = z.infer<typeof OfferAccepted>;

export const OfferDeclined = z.object({
	type: z.literal("offer_declined"),
	tripId: TripId,
	driverId: DriverId,
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
});
export type RequestTrip = z.infer<typeof RequestTrip>;

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

export const TripRequested = z.object({
	type: z.literal("trip.requested"),
	tick: Tick,
	tripId: TripId,
	riderId: RiderId,
	pickup: Cell,
	dropoff: Cell,
});
export type TripRequested = z.infer<typeof TripRequested>;

// Every message published on the bus (ADR 0027). InputRejected is not one:
// shells log it, never publish it.
const Message = z.discriminatedUnion("type", [
	ClockTicked,
	DriverWentOnline,
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
	{ type: `${"clock" | "driver" | "drivers" | "trip"}.${string}` }
>;

// sim.events.> carries only events, but a payload is untrusted.
export function isSimEvent(message: Message): message is SimEvent {
	return /^(clock|drivers?|trip)\./.test(message.type);
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
