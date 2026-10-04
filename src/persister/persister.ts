// Persister shell (ADR 0029): JetStream stream -> ClickHouse events table,
// at-least-once. Owns the stream and consumer setup, batching, ack-after-
// insert, and the insert retry policy.
import {
	AckPolicy,
	type Consumer,
	JetStreamApiError,
	type JsMsg,
	jetstream,
	jetstreamManager,
	StorageType,
} from "@nats-io/jetstream";
import { type NatsConnection, nanos } from "@nats-io/transport-node";
import {
	type ClickHouse,
	type ClickHouseError,
	type EventRow,
	type MigrationFailed,
	migrate,
} from "../persistence/clickhouse.ts";
import {
	isSimEvent,
	parseMessage,
	RunId,
	type SimEvent,
} from "../shared/messages.ts";
import type { Result } from "../shared/result.ts";
import { simEventSubjects } from "../shared/subjects.ts";
import { toRow } from "./rows.ts";

// Where the persister reads from. Tests use their own stream and subjects;
// a stream's subjects can't overlap another's.
export type EventSource = {
	stream: string;
	subjects: string;
	consumer: string;
	// Above the batch wait plus the ClickHouse client's 30 s request timeout,
	// so no message is redelivered while its batch is still being fetched or
	// inserted.
	ackWaitMs: number;
};

export const simEvents: EventSource = {
	stream: "SIM_EVENTS",
	subjects: simEventSubjects,
	consumer: "persister",
	ackWaitMs: 60_000,
};

// Fetch up to this many messages or for this long, whichever comes first.
const batchSize = 1000;
const batchWaitMs = 1000;
// Waits between insert attempts for one batch: 5 attempts, 15 s of waiting.
// Each attempt can itself take up to the client's 30 s request timeout, so a
// batch can outlive the ack wait and be redelivered while still retrying;
// harmless, the copies share stream_seq and collapse under FINAL. A batch
// still failing stays unacked: JetStream redelivers it after the ack wait, so
// the retry continues there.
const defaultRetryDelaysMs = [1000, 2000, 4000, 8000];
// How often the persister logs where its round time went (`rounds_timed`).
const timingIntervalMs = 10_000;

const unknownRunId = RunId.parse("unknown");

export type PersisterLogEntry =
	| {
			type: "message_dropped";
			streamSeq: number;
			error:
				| { type: "invalid_json" }
				| { type: "invalid_message"; issues: unknown[] }
				| { type: "not_an_event"; messageType: string };
	  }
	| {
			type: "insert_failed";
			attempt: number;
			rows: number;
			error: ClickHouseError;
	  }
	| { type: "batch_not_persisted"; firstSeq: number; lastSeq: number }
	// Every 10 s and on stop: rounds (fetches that returned messages) since
	// the last entry, events inserted and acked, and ms spent in each phase of
	// those rounds, rounded. Fetches that returned nothing are idle time, left
	// out; intervalMs minus the phases is idle time plus that bookkeeping.
	| ({ type: "rounds_timed"; intervalMs: number } & RoundsTiming);

type RoundsTiming = {
	rounds: number;
	events: number;
	fetchMs: number;
	decodeMs: number;
	insertMs: number;
	ackMs: number;
};

export type PersisterError =
	| MigrationFailed
	| { type: "jetstream_setup_failed"; cause: unknown }
	| { type: "fetch_failed"; cause: unknown };

export type Persister = {
	// Stops after the batch in hand is inserted and acked (or given up).
	stop(): void;
	// Resolves once stopped, or on a failure that ends the loop.
	stopped: Promise<Result<void, PersisterError>>;
};

// Migrates the events table (idempotent, so `bun run dev` needs no separate
// `bun run db:migrate`), ensures the stream and the durable consumer
// (creating or updating them to this config), then persists batches until
// stopped.
export async function startPersister(options: {
	nats: NatsConnection;
	clickhouse: Pick<ClickHouse, "insertEvents" | "command">;
	source: EventSource;
	log: (entry: PersisterLogEntry) => void;
	// Tests shorten the waits.
	retryDelaysMs?: number[];
	// Milliseconds, for timing rounds only. Tests control it.
	now?: () => number;
}): Promise<Result<Persister, PersisterError>> {
	const migrated = await migrate(options.clickhouse);
	if (!migrated.ok) return migrated;
	let consumer: Consumer;
	try {
		consumer = await ensureConsumer(options.nats, options.source);
	} catch (cause) {
		return { ok: false, error: { type: "jetstream_setup_failed", cause } };
	}
	const now = options.now ?? (() => performance.now());
	const stop = new AbortController();
	const stopped = (async (): Promise<Result<void, PersisterError>> => {
		let intervalStart = now();
		let timing = noRounds();
		const logTiming = (at: number) => {
			options.log({
				type: "rounds_timed",
				intervalMs: Math.round(at - intervalStart),
				rounds: timing.rounds,
				events: timing.events,
				fetchMs: Math.round(timing.fetchMs),
				decodeMs: Math.round(timing.decodeMs),
				insertMs: Math.round(timing.insertMs),
				ackMs: Math.round(timing.ackMs),
			});
			intervalStart = at;
			timing = noRounds();
		};
		while (!stop.signal.aborted) {
			const fetchStart = now();
			let batch: JsMsg[];
			try {
				batch = await Array.fromAsync(
					await consumer.fetch({
						max_messages: batchSize,
						expires: batchWaitMs,
					}),
				);
			} catch (cause) {
				return { ok: false, error: { type: "fetch_failed", cause } };
			}
			if (batch.length > 0) {
				const fetchMs = now() - fetchStart;
				const round = await persist(
					batch,
					{
						...options,
						retryDelaysMs: options.retryDelaysMs ?? defaultRetryDelaysMs,
						now,
					},
					stop.signal,
				);
				timing.rounds += 1;
				timing.events += round.events;
				timing.fetchMs += fetchMs;
				timing.decodeMs += round.decodeMs;
				timing.insertMs += round.insertMs;
				timing.ackMs += round.ackMs;
			}
			const at = now();
			if (at - intervalStart >= timingIntervalMs) logTiming(at);
		}
		logTiming(now());
		return { ok: true, value: undefined };
	})();
	return { ok: true, value: { stop: () => stop.abort(), stopped } };
}

async function ensureConsumer(
	nats: NatsConnection,
	source: EventSource,
): Promise<Consumer> {
	const jsm = await jetstreamManager(nats);
	const stream = {
		name: source.stream,
		subjects: [source.subjects],
		storage: StorageType.File,
		max_age: nanos(24 * 60 * 60 * 1000),
	};
	// add() is a no-op for an identical config; a changed one is an API
	// error, then update() applies it.
	await jsm.streams.add(stream).catch((error: unknown) => {
		if (!(error instanceof JetStreamApiError)) throw error;
		return jsm.streams.update(source.stream, stream);
	});
	const consumer = {
		durable_name: source.consumer,
		ack_policy: AckPolicy.Explicit,
		max_ack_pending: batchSize,
		ack_wait: nanos(source.ackWaitMs),
	};
	await jsm.consumers.add(source.stream, consumer).catch((error: unknown) => {
		if (!(error instanceof JetStreamApiError)) throw error;
		return jsm.consumers.update(source.stream, source.consumer, consumer);
	});
	return jetstream(nats).consumers.get(source.stream, source.consumer);
}

function noRounds(): RoundsTiming {
	return {
		rounds: 0,
		events: 0,
		fetchMs: 0,
		decodeMs: 0,
		insertMs: 0,
		ackMs: 0,
	};
}

// One round after its fetch: decode, insert (with retries), ack.
async function persist(
	batch: JsMsg[],
	options: {
		clickhouse: Pick<ClickHouse, "insertEvents">;
		log: (entry: PersisterLogEntry) => void;
		retryDelaysMs: number[];
		now: () => number;
	},
	stopping: AbortSignal,
): Promise<Omit<RoundsTiming, "rounds" | "fetchMs">> {
	const decodeStart = options.now();
	const ingestedAt = new Date();
	const delivered: { message: JsMsg; row: EventRow }[] = [];
	for (const message of batch) {
		const event = decode(message);
		if (!event.ok) {
			options.log({
				type: "message_dropped",
				streamSeq: message.seq,
				error: event.error,
			});
			// Never valid on redelivery either.
			message.term();
			continue;
		}
		const row = toRow(event.value, {
			runId: runIdOf(message),
			streamSeq: message.seq,
			ingestedAt,
		});
		delivered.push({ message, row });
	}
	const rows = delivered.map(({ row }) => row);
	const insertStart = options.now();
	const decodeMs = insertStart - decodeStart;
	if (delivered.length === 0) {
		return { events: 0, decodeMs, insertMs: 0, ackMs: 0 };
	}
	for (let attempt = 1; ; attempt++) {
		const inserted = await options.clickhouse.insertEvents(rows);
		if (inserted.ok) {
			const ackStart = options.now();
			for (const { message } of delivered) message.ack();
			return {
				events: rows.length,
				decodeMs,
				insertMs: ackStart - insertStart,
				ackMs: options.now() - ackStart,
			};
		}
		options.log({
			type: "insert_failed",
			attempt,
			rows: rows.length,
			error: inserted.error,
		});
		const delay = options.retryDelaysMs[attempt - 1];
		if (delay === undefined || stopping.aborted) break;
		await Bun.sleep(delay);
	}
	options.log({
		type: "batch_not_persisted",
		firstSeq: rows[0]?.streamSeq ?? 0,
		lastSeq: rows.at(-1)?.streamSeq ?? 0,
	});
	return {
		events: 0,
		decodeMs,
		insertMs: options.now() - insertStart,
		ackMs: 0,
	};
}

function decode(
	message: JsMsg,
): Result<
	SimEvent,
	Extract<PersisterLogEntry, { type: "message_dropped" }>["error"]
> {
	let payload: unknown;
	try {
		payload = message.json();
	} catch (cause) {
		// JsMsg.json() is JSON.parse: SyntaxError means a malformed payload.
		if (!(cause instanceof SyntaxError)) throw cause;
		return { ok: false, error: { type: "invalid_json" } };
	}
	const parsed = parseMessage(payload);
	if (!parsed.ok) return parsed;
	if (!isSimEvent(parsed.value)) {
		return {
			ok: false,
			error: { type: "not_an_event", messageType: parsed.value.type },
		};
	}
	return { ok: true, value: parsed.value };
}

// Header missing or not a valid run id: stored as 'unknown' (ADR 0029).
function runIdOf(message: JsMsg): RunId {
	const parsed = RunId.safeParse(message.headers?.get("Run-Id"));
	return parsed.success ? parsed.data : unknownRunId;
}
