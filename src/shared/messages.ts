import * as z from "zod";
import { Cell } from "./grid.ts";
import type { Result } from "./result.ts";

// IDs are valid NATS subject tokens (sim.offers.<driverId>, ADR 0028).
const idToken = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const DriverId = idToken.brand<"DriverId">();
export type DriverId = z.infer<typeof DriverId>;

export const Tick = z.int().nonnegative().brand<"Tick">();
export type Tick = z.infer<typeof Tick>;

export const TripId = idToken.brand<"TripId">();
export type TripId = z.infer<typeof TripId>;

export const RiderId = idToken.brand<"RiderId">();
export type RiderId = z.infer<typeof RiderId>;

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

export const DriverMoved = z.object({
	type: z.literal("driver.moved"),
	tick: Tick,
	driverId: DriverId,
	cell: Cell,
});
export type DriverMoved = z.infer<typeof DriverMoved>;

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
	DriverMoved,
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
]);
export type Message = z.infer<typeof Message>;

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
