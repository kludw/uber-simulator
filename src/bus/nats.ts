import {
	ClosedConnectionError,
	connect,
	headers,
	type Msg,
	type NatsConnection,
	RequestError,
} from "@nats-io/transport-node";
import { type Message, parseMessage, type RunId } from "../shared/messages.ts";
import type { Result } from "../shared/result.ts";
import { simSubjects, subjectFor } from "../shared/subjects.ts";
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

// Every 10 s and on close: messages received on sim.> since the last entry,
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

// One connection, one sim.> subscription (ADR 0028): a single subscription
// keeps each publisher's order. Handlers are synchronous and run from one
// loop, so they run one at a time in arrival order.
// Every publish carries `Run-Id: <runId>` (ADR 0029), so consumers tell runs
// apart without the run id in any message.
export async function connectNatsBus(options: {
	url: string;
	runId: RunId;
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
	const subscription = connection.subscribe(simSubjects);
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
	// Each returns whether it accepted the message.
	const subscribers: ((message: Message) => boolean)[] = [];
	const now = options.now ?? (() => performance.now());
	const delivering = (async () => {
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
		for await (const received of subscription) {
			const decodeStart = now();
			const parsed = decode(received);
			const decoded = now();
			timing.received++;
			timing.decodeMs += decoded - decodeStart;
			if (parsed.ok) {
				let delivered = false;
				for (const deliver of subscribers) {
					if (deliver(parsed.value)) delivered = true;
				}
				if (delivered) timing.delivered++;
			} else {
				options.log({ subject: received.subject, error: parsed.error });
			}
			const handled = now();
			timing.handleMs += handled - decoded;
			if (handled - intervalStart >= timingIntervalMs) logTiming(handled);
		}
		logTiming(now());
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
					if (!accepts(message)) return false;
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
