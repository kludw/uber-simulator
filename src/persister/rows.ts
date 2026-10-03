// Event -> events table row (ADR 0029). Pure: the shell supplies the
// delivery facts (run id header, stream sequence, wall-clock ingestion).
import type { EventRow } from "../persistence/clickhouse.ts";
import type { RunId, SimEvent } from "../shared/messages.ts";

export function toRow(
	event: SimEvent,
	delivery: { runId: RunId; streamSeq: number; ingestedAt: Date },
): EventRow {
	return {
		runId: delivery.runId,
		type: event.type,
		tick: event.tick,
		streamSeq: delivery.streamSeq,
		tripId: "tripId" in event ? event.tripId : "",
		// trip.cancelled without a driver has driverId null.
		driverId: ("driverId" in event ? event.driverId : null) ?? "",
		riderId: "riderId" in event ? event.riderId : "",
		payload: JSON.stringify(event),
		ingestedAt: delivery.ingestedAt,
	};
}
