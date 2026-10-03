// NATS subject names, in one place for the services, the persister, replay,
// and the browser UI. Pure, no NATS imports, so the UI bundle can use it.
import type { Message, RunId, SimEvent } from "./messages.ts";

const simEventsPrefix = "sim.events";

// Every service subject: each service's one subscription (ADR 0028).
export const simSubjects = "sim.>";

// Every event subject (ADR 0028), e.g. for the persister's stream.
export const simEventSubjects = `${simEventsPrefix}.>`;

// Subject scheme (ADR 0028). Subscribers read sim.> and filter by predicate,
// so subjects serve wildcard taps (sim.events.>) and readability.
export function subjectFor(message: Message): string {
	switch (message.type) {
		case "clock.ticked":
		case "driver.went_online":
		case "driver.went_offline":
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
			return `${simEventsPrefix}.${message.type}`;
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

// Replay (ADR 0034): outside sim.events.>, so the persister never stores a
// replay again. A RunId is one subject token.
function replayPrefix(runId: RunId): string {
	return `replay.${runId}`;
}

export function replaySubject(runId: RunId, event: SimEvent): string {
	return `${replayPrefix(runId)}.${subjectFor(event)}`;
}

// Every subject replaySubject produces for the run.
export function replaySubjects(runId: RunId): string {
	return `${replayPrefix(runId)}.${simEventSubjects}`;
}
