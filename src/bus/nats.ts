import type { Message } from "../shared/messages.ts";

// Subject scheme (ADR 0028). Subscribers read sim.> and filter by predicate,
// so subjects serve wildcard taps (sim.events.>) and readability.
export function subjectFor(message: Message): string {
	switch (message.type) {
		case "clock.ticked":
		case "driver.went_online":
		case "driver.moved":
		case "driver.arrived_at_pickup":
		case "driver.arrived_at_dropoff":
		case "trip.requested":
		case "trip.offered":
		case "trip.offer_declined":
		case "trip.offer_expired":
		case "trip.matched":
		case "trip.picked_up":
		case "trip.completed":
		case "trip.cancelled":
			return `sim.events.${message.type}`;
		case "request_trip":
		case "cancel_trip":
			return `sim.commands.${message.type}`;
		case "offer":
			return `sim.offers.${message.driverId}`;
		case "offer_accepted":
		case "offer_declined":
		case "request_trip_accepted":
		case "request_trip_rejected":
		case "cancel_trip_accepted":
		case "cancel_trip_rejected":
			return `sim.replies.${message.type}`;
		default: {
			const unhandled: never = message;
			throw new Error(`no subject for ${JSON.stringify(unhandled)}`);
		}
	}
}
