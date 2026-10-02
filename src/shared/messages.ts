import * as z from "zod";
import type { Cell } from "./grid.ts";

export const DriverId = z.string().min(1).brand<"DriverId">();
export type DriverId = z.infer<typeof DriverId>;

export const Tick = z.int().nonnegative().brand<"Tick">();
export type Tick = z.infer<typeof Tick>;

export const TripId = z.string().min(1).brand<"TripId">();
export type TripId = z.infer<typeof TripId>;

export type ClockTicked = { type: "clock.ticked"; tick: Tick };

export type DriverWentOnline = {
	type: "driver.went_online";
	tick: Tick;
	driverId: DriverId;
	cell: Cell;
};

export type DriverMoved = {
	type: "driver.moved";
	tick: Tick;
	driverId: DriverId;
	cell: Cell;
};

export type DriverArrivedAtPickup = {
	type: "driver.arrived_at_pickup";
	tick: Tick;
	driverId: DriverId;
	tripId: TripId;
	cell: Cell;
};

export type TripPickedUp = {
	type: "trip.picked_up";
	tick: Tick;
	tripId: TripId;
	driverId: DriverId;
};

export type DriverArrivedAtDropoff = {
	type: "driver.arrived_at_dropoff";
	tick: Tick;
	driverId: DriverId;
	tripId: TripId;
	cell: Cell;
};

export type TripCompleted = {
	type: "trip.completed";
	tick: Tick;
	tripId: TripId;
	driverId: DriverId;
};

// driverId null: cancelled before any driver was matched.
export type TripCancelled = {
	type: "trip.cancelled";
	tick: Tick;
	tripId: TripId;
	driverId: DriverId | null;
};

export type TripOfferExpired = {
	type: "trip.offer_expired";
	tick: Tick;
	tripId: TripId;
	driverId: DriverId;
};

export type Offer = {
	type: "offer";
	tripId: TripId;
	driverId: DriverId;
	pickup: Cell;
	dropoff: Cell;
};

export type OfferAccepted = {
	type: "offer_accepted";
	tripId: TripId;
	driverId: DriverId;
};

export type OfferDeclined = {
	type: "offer_declined";
	tripId: TripId;
	driverId: DriverId;
};
