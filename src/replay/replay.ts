// Where and when a stored event is republished (ADR 0034).
import { subjectFor } from "../bus/nats.ts";
import type { RunId, SimEvent, Tick } from "../shared/messages.ts";

// Outside sim.events.>, so the persister never stores a replay again.
export function replaySubject(runId: RunId, event: SimEvent): string {
	return `replay.${runId}.${subjectFor(event)}`;
}

// Wall milliseconds after the replay starts at which a tick's events are
// published. 1 tick = 1 s sim time; speed = sim seconds per wall second.
export function publishAt(tick: Tick, startTick: Tick, speed: number): number {
	return ((tick - startTick) * 1000) / speed;
}
