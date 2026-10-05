import {
	ClosedConnectionError,
	connect,
	headers,
	type Msg,
	type NatsConnection,
	RequestError,
} from "@nats-io/transport-node";
import {
	isOneOf,
	type Message,
	type MessageType,
	parseMessage,
	type RunId,
} from "../shared/messages.ts";
import type { Result } from "../shared/result.ts";
import { subjectFor, subscriptionSubject } from "../shared/subjects.ts";
import type { Bus } from "./bus.ts";

export type NatsBus = Bus & { close(): Promise<void> };

type ParseMessageError = Extract<
	ReturnType<typeof parseMessage>,
	{ ok: false }
>["error"];

// A payload on a subscribed subject that isn't a Message: logged, never
// delivered.
export type DroppedMessage = {
	subject: string;
	error: { type: "invalid_json"; cause: unknown } | ParseMessageError;
};

// Connection lifecycle after setup, for the service's log.
export type ConnectionStatus =
	| { type: "nats_disconnected"; server: string }
	| { type: "nats_reconnected"; server: string }
	| { type: "nats_closed" };

// Every 10 s and on close: messages received on the bus's subscriptions
// (its inputs, ADR 0042) since the last entry,
// how many reached at least one subscriber, and ms decoding them and in
// subscribers (accepts and handlers, the handlers' publishes included),
// rounded. intervalMs minus the two is mostly waiting for messages.
export type MessagesTimed = {
	type: "messages_timed";
	intervalMs: number;
	received: number;
	decodeMs: number;
	delivered: number;
	handleMs: number;
};

const timingIntervalMs = 10_000;

export type NatsConnectError = {
	type: "nats_connect_failed";
	url: string;
	cause: unknown;
};

// One connection, one subscription per input type (ADR 0042), so the bus
// never receives or decodes what its service doesn't take. Every
// subscription delivers through one synchronous callback, which the client
// calls in the order messages arrive on the connection, so each publisher's
// order holds across subscriptions; handlers run one at a time.
// Every publish carries `Run-Id: <runId>` (ADR 0029), so consumers tell runs
// apart without the run id in any message.
export async function connectNatsBus(options: {
	url: string;
	runId: RunId;
	// Every type the bus's subscribers take, subscribed before connect returns
	// so the bus misses nothing published after; subscribe() takes no other.
	inputs: readonly MessageType[];
	log: (dropped: DroppedMessage) => void;
	logStatus: (status: ConnectionStatus) => void;
	logTiming: (timing: MessagesTimed) => void;
	// Milliseconds, for timing only. Tests control it.
	now?: () => number;
}): Promise<Result<NatsBus, NatsConnectError>> {
	const failed = (cause: unknown): Result<never, NatsConnectError> => ({
		ok: false,
		error: { type: "nats_connect_failed", url: options.url, cause },
	});
	// Before connecting: RunId's charset makes set() safe, but a throw here
	// would leak no connection anyway.
	const runHeaders = headers();
	runHeaders.set("Run-Id", options.runId);
	let connection: NatsConnection;
	try {
		connection = await connect({ servers: options.url });
	} catch (cause) {
		return failed(cause);
	}
	// Each returns whether it accepted the message.
	const subscribers: ((message: Message) => boolean)[] = [];
	const now = options.now ?? (() => performance.now());
	const noMessages = { received: 0, decodeMs: 0, delivered: 0, handleMs: 0 };
	let timing = { ...noMessages };
	let intervalStart = now();
	const logTiming = (at: number) => {
		options.logTiming({
			type: "messages_timed",
			intervalMs: Math.round(at - intervalStart),
			received: timing.received,
			decodeMs: Math.round(timing.decodeMs),
			delivered: timing.delivered,
			handleMs: Math.round(timing.handleMs),
		});
		intervalStart = at;
		timing = { ...noMessages };
	};
	// A throw inside the client's callback would only stop the client's
	// reader, with a console.log: a bug (or a subscription error) ends
	// delivery and is rethrown outside the client, as an uncaught error (exit
	// code 1), like a rejected iterator loop before ADR 0042.
	let broken = false;
	const deliver = (error: Error | null, received: Msg) => {
		if (broken) return;
		try {
			if (error) throw error;
			receive(received);
		} catch (cause) {
			broken = true;
			queueMicrotask(() => {
				throw cause;
			});
		}
	};
	const receive = (received: Msg) => {
		const decodeStart = now();
		const parsed = decode(received);
		const decoded = now();
		timing.received++;
		timing.decodeMs += decoded - decodeStart;
		if (parsed.ok) {
			let delivered = false;
			for (const subscriber of subscribers) {
				if (subscriber(parsed.value)) delivered = true;
			}
			if (delivered) timing.delivered++;
		} else {
			options.log({ subject: received.subject, error: parsed.error });
		}
		const handled = now();
		timing.handleMs += handled - decoded;
		if (handled - intervalStart >= timingIntervalMs) logTiming(handled);
	};
	const inputs = new Set(options.inputs);
	for (const subject of new Set(options.inputs.map(subscriptionSubject))) {
		connection.subscribe(subject, { callback: deliver });
	}
	try {
		// The server has registered the subscriptions once flush resolves, so
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
			subscribe(types, handle) {
				const outside = types.filter((type) => !inputs.has(type));
				if (outside.length > 0) {
					throw new Error(`not among the bus's inputs: ${outside.join(", ")}`);
				}
				const taken = new Set(types);
				subscribers.push((message) => {
					if (!isOneOf(taken, message)) return false;
					handle(message);
					return true;
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
					// Drained: every callback has run.
					.then(() => watching)
					.then(() => logTiming(now()));
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
