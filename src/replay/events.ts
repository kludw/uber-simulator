// Reads a stored run back from ClickHouse (ADR 0034).
import * as z from "zod";
import type { ClickHouse, ClickHouseError } from "../persistence/clickhouse.ts";
import {
	isSimEvent,
	parseMessage,
	type RunId,
	type SimEvent,
	Tick,
} from "../shared/messages.ts";
import type { Result } from "../shared/result.ts";

export type StoredEvent = { tick: Tick; streamSeq: number; message: SimEvent };

export type ReadLogEntry = {
	type: "stored_event_skipped";
	runId: RunId;
	tick: Tick;
	streamSeq: number;
	error:
		| { type: "invalid_json" }
		| { type: "invalid_message"; issues: unknown[] }
		| { type: "not_an_event"; messageType: string };
};

const StoredRow = z.object({
	tick: Tick,
	// UInt64 comes back as a JSON string.
	streamSeq: z.coerce.number().pipe(z.int().nonnegative()),
	payload: z.string(),
});

// The run's events from fromTick (default 0) on, in tick, stream sequence
// order: a causal order (ADR 0034). Payloads that don't parse as events are
// logged and skipped. Yields one failed Result and stops if ClickHouse fails
// mid-read.
export async function* readRunEvents(
	clickhouse: Pick<ClickHouse, "query">,
	runId: RunId,
	options: {
		fromTick?: Tick;
		pageSize?: number;
		log: (entry: ReadLogEntry) => void;
	},
): AsyncGenerator<Result<StoredEvent, ClickHouseError>> {
	const pageSize = options.pageSize ?? 10_000;
	let after: { tick: number; streamSeq: number } | null = null;
	for (;;) {
		// Keyset pagination: OFFSET would rescan every earlier page.
		const rows = await clickhouse.query(
			`SELECT tick, stream_seq AS streamSeq, payload
			FROM events FINAL
			WHERE run_id = {runId:String} AND tick >= {fromTick:UInt32}
				${after === null ? "" : "AND (tick, stream_seq) > ({afterTick:UInt32}, {afterSeq:UInt64})"}
			ORDER BY tick, stream_seq
			LIMIT {pageSize:UInt32}`,
			{
				runId,
				fromTick: options.fromTick ?? 0,
				pageSize,
				afterTick: after?.tick,
				afterSeq: after?.streamSeq,
			},
		);
		if (!rows.ok) {
			yield rows;
			return;
		}
		// Our own query: a row that doesn't parse is a bug.
		const page = z.array(StoredRow).parse(rows.value);
		for (const { tick, streamSeq, payload } of page) {
			const event = decode(payload);
			if (!event.ok) {
				options.log({
					type: "stored_event_skipped",
					runId,
					tick,
					streamSeq,
					error: event.error,
				});
				continue;
			}
			yield { ok: true, value: { tick, streamSeq, message: event.value } };
		}
		const last = page.at(-1);
		if (page.length < pageSize || last === undefined) return;
		after = { tick: last.tick, streamSeq: last.streamSeq };
	}
}

function decode(payload: string): Result<SimEvent, ReadLogEntry["error"]> {
	let json: unknown;
	try {
		json = JSON.parse(payload);
	} catch (cause) {
		if (!(cause instanceof SyntaxError)) throw cause;
		return { ok: false, error: { type: "invalid_json" } };
	}
	const parsed = parseMessage(json);
	if (!parsed.ok) return parsed;
	if (!isSimEvent(parsed.value)) {
		return {
			ok: false,
			error: { type: "not_an_event", messageType: parsed.value.type },
		};
	}
	return { ok: true, value: parsed.value };
}
