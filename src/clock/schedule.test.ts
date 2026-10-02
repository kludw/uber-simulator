import { describe, expect, test } from "bun:test";
import { Tick } from "../shared/messages.ts";
import { tickDueAt } from "./schedule.ts";

describe("tickDueAt", () => {
	const firstTickAt = 10_000;

	test.each([
		[1, 1, 10_000],
		[3, 1, 12_000],
		[3, 4, 10_500],
		[5, 0.5, 18_000],
	])("tick %p at speed %p is due at %p ms", (tick, speed, dueAt) => {
		expect(tickDueAt(Tick.parse(tick), { firstTickAt, speed })).toBe(dueAt);
	});
});
