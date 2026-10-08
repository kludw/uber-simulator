// NATS subject names, in one place for the services, the persister, replay,
// and the browser UI. Pure, no NATS imports, so the UI bundle can use it.
import type { Message, MessageType, RunId, SimEvent } from "./messages.ts";
import type { Region } from "./regions.ts";

const simEventsPrefix = "sim.events";

// Every event subject (ADR 0028), e.g. for the persister's stream.
export const simEventSubjects = `${simEventsPrefix}.>`;

// Subject scheme (ADR 0028): subjects serve wildcard taps (sim.events.>),
// readability, and each service's subscriptions (ADR 0042). Messages
// dispatch takes end in their region (ADR 0050), so each dispatch instance
// subscribes to its own.
export function subjectFor(message: Message): string {
	if (message.type === "offer") return `sim.offers.${message.driverId}`;
	const subject = `${kindPrefix(message.type)}.${message.type}`;
	if (!("region" in message)) return subject;
	return `${subject}.${regionToken(message.region)}`;
}

// What a service subscribes to for one message type it takes (ADR 0042):
// every subject that type goes on, so offers to any driver, and every
// region's messages unless the subscriber takes one region (ADR 0050).
export function subscriptionSubject(
	type: MessageType,
	region?: Region,
): string {
	if (type === "offer") return "sim.offers.*";
	const subject = `${kindPrefix(type)}.${type}`;
	if (!regionedTypes.has(type)) return subject;
	return `${subject}.${region === undefined ? "*" : regionToken(region)}`;
}

function regionToken(region: Region): string {
	return `region-${region}`;
}

// The types carrying a region (ADR 0050): what dispatch takes, except
// clock.ticked.
const regionedTypes: ReadonlySet<MessageType> = new Set<
	Extract<Message, { region: Region }>["type"]
>([
	"request_trip",
	"cancel_trip",
	"offer_accepted",
	"offer_declined",
	"driver.arrived_at_pickup",
	"driver.arrived_at_dropoff",
	"confirm_trip",
	"drivers.went_online",
	"driver.went_offline",
	"drivers.moved",
]);

function kindPrefix(type: Exclude<MessageType, "offer">): string {
	switch (type) {
		case "clock.ticked":
		case "drivers.went_online":
		case "driver.went_offline":
		case "drivers.moved":
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
		case "zones.priced":
		case "rider.declined_surge":
			return simEventsPrefix;
		case "request_trip":
		case "cancel_trip":
		case "confirm_trip":
			return "sim.commands";
		case "offer_accepted":
		case "offer_declined":
		case "request_trip_accepted":
		case "request_trip_rejected":
		case "cancel_trip_accepted":
		case "cancel_trip_rejected":
		case "trip_status":
			return "sim.replies";
		default: {
			const unhandled: never = type;
			throw new Error(`no subject for ${unhandled}`);
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
