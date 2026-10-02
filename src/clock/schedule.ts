import type { Tick } from "../shared/messages.ts";

// Wall time (ms) tick `tick` is due: one tick per 1 s / speed after the
// first. Absolute, so a late tick doesn't delay the ones after it.
export function tickDueAt(
	tick: Tick,
	schedule: { firstTickAt: number; speed: number },
): number {
	return schedule.firstTickAt + ((tick - 1) * 1000) / schedule.speed;
}
