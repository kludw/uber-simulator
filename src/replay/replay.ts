// When a stored event is republished (ADR 0034).
import type { Tick } from "../shared/messages.ts";

// Wall milliseconds after the replay starts at which a tick's events are
// published. 1 tick = 1 s sim time; speed = sim seconds per wall second.
export function publishAt(tick: Tick, startTick: Tick, speed: number): number {
	return ((tick - startTick) * 1000) / speed;
}
