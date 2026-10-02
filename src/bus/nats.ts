import { connect } from "@nats-io/transport-node";
import { type Message, parseMessage } from "../shared/messages.ts";
import type { Result } from "../shared/result.ts";
import type { Bus } from "./bus.ts";

export type NatsBus = Bus & { close(): Promise<void> };

export type NatsConnectError = {
	type: "nats_connect_failed";
	url: string;
	cause: unknown;
};

// One connection, one sim.> subscription (ADR 0028): a single subscription
// keeps each publisher's order. Handlers are synchronous and run from one
// loop, so they run one at a time in arrival order.
export async function connectNatsBus(options: {
	url: string;
	log: (dropped: unknown) => void;
}): Promise<Result<NatsBus, NatsConnectError>> {
	try {
		const connection = await connect({ servers: options.url });
		const subscription = connection.subscribe("sim.>");
		// The server has registered the subscription once flush resolves, so
		// messages published after connect returns are delivered.
		await connection.flush();
		const subscribers: ((message: Message) => void)[] = [];
		const delivering = (async () => {
			for await (const received of subscription) {
				const parsed = parseMessage(received.json());
				if (!parsed.ok) continue;
				for (const deliver of subscribers) deliver(parsed.value);
			}
		})();
		return {
			ok: true,
			value: {
				publish(message) {
					connection.publish(subjectFor(message), JSON.stringify(message));
				},
				subscribe(accepts, handle) {
					subscribers.push((message) => {
						if (accepts(message)) handle(message);
					});
				},
				async close() {
					await connection.drain();
					await delivering;
				},
			},
		};
	} catch (cause) {
		return {
			ok: false,
			error: { type: "nats_connect_failed", url: options.url, cause },
		};
	}
}

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
