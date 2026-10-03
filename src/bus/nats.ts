import {
	ClosedConnectionError,
	connect,
	headers,
	type Msg,
	type NatsConnection,
	RequestError,
} from "@nats-io/transport-node";
import { type Message, parseMessage } from "../shared/messages.ts";
import type { Result } from "../shared/result.ts";
import type { Bus } from "./bus.ts";

export type NatsBus = Bus & { close(): Promise<void> };

type ParseMessageError = Extract<
	ReturnType<typeof parseMessage>,
	{ ok: false }
>["error"];

// A payload on sim.> that isn't a Message: logged, never delivered.
export type DroppedMessage = {
	subject: string;
	error: { type: "invalid_json"; cause: unknown } | ParseMessageError;
};

// Connection lifecycle after setup, for the service's log.
export type ConnectionStatus =
	| { type: "nats_disconnected"; server: string }
	| { type: "nats_reconnected"; server: string }
	| { type: "nats_closed" };

export type NatsConnectError = {
	type: "nats_connect_failed";
	url: string;
	cause: unknown;
};

// One connection, one sim.> subscription (ADR 0028): a single subscription
// keeps each publisher's order. Handlers are synchronous and run from one
// loop, so they run one at a time in arrival order.
// Every publish carries `Run-Id: <runId>` (ADR 0029), so consumers tell runs
// apart without the run id in any message.
export async function connectNatsBus(options: {
	url: string;
	runId: string;
	log: (dropped: DroppedMessage) => void;
	logStatus: (status: ConnectionStatus) => void;
}): Promise<Result<NatsBus, NatsConnectError>> {
	const failed = (cause: unknown): Result<never, NatsConnectError> => ({
		ok: false,
		error: { type: "nats_connect_failed", url: options.url, cause },
	});
	// Throws on a value no header can carry (CR/LF): config parsing rules
	// those out, so it's a bug. Before connecting, so it leaks no connection.
	const runHeaders = headers();
	runHeaders.set("Run-Id", options.runId);
	let connection: NatsConnection;
	try {
		connection = await connect({ servers: options.url });
	} catch (cause) {
		return failed(cause);
	}
	const subscription = connection.subscribe("sim.>");
	try {
		// The server has registered the subscription once flush resolves, so
		// messages published after connect returns are delivered.
		await connection.flush();
	} catch (cause) {
		// Otherwise the client keeps reconnecting with nobody holding it.
		await connection.close();
		return failed(cause);
	}
	const watching = (async () => {
		// Other statuses (pings, reconnect attempts, ...) are client chatter.
		for await (const status of connection.status()) {
			switch (status.type) {
				case "disconnect":
					options.logStatus({
						type: "nats_disconnected",
						server: status.server,
					});
					break;
				case "reconnect":
					options.logStatus({
						type: "nats_reconnected",
						server: status.server,
					});
					break;
				case "close":
					options.logStatus({ type: "nats_closed" });
					break;
			}
		}
	})();
	const subscribers: ((message: Message) => void)[] = [];
	const delivering = (async () => {
		for await (const received of subscription) {
			const parsed = decode(received);
			if (!parsed.ok) {
				options.log({ subject: received.subject, error: parsed.error });
				continue;
			}
			for (const deliver of subscribers) deliver(parsed.value);
		}
	})();
	// drain() rejects on a connection already closed, by an earlier close()
	// or by the client giving up reconnecting: nothing left to drain then.
	// Every close() shares the first one.
	let closing: Promise<void> | undefined;
	return {
		ok: true,
		value: {
			publish(message) {
				connection.publish(subjectFor(message), JSON.stringify(message), {
					headers: runHeaders,
				});
			},
			subscribe(accepts, handle) {
				subscribers.push((message) => {
					if (accepts(message)) handle(message);
				});
			},
			close() {
				closing ??= connection
					.drain()
					.catch((error: unknown) => {
						if (error instanceof ClosedConnectionError) return;
						// Disconnected: drain's flush fails on the next failed
						// reconnect. Nothing reaches the server now; just close.
						if (error instanceof RequestError) return connection.close();
						throw error;
					})
					.then(() => Promise.all([delivering, watching]))
					.then(() => {});
				return closing;
			},
		},
	};
}

function decode(received: Msg): Result<Message, DroppedMessage["error"]> {
	let payload: unknown;
	try {
		payload = received.json();
	} catch (cause) {
		// Msg.json() is JSON.parse: SyntaxError means a malformed payload.
		if (!(cause instanceof SyntaxError)) throw cause;
		return { ok: false, error: { type: "invalid_json", cause } };
	}
	return parseMessage(payload);
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
