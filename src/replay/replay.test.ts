import { describe, expect, test } from "bun:test";
import { Tick } from "../shared/messages.ts";
import { publishAt } from "./replay.ts";

describe("publishAt", () => {
	// 1 tick = 1 s sim time; speed = sim seconds per wall second.
	test("a tick is published its sim seconds after the start tick, divided by speed", () => {
		expect(publishAt(Tick.parse(13), Tick.parse(10), 2)).toBe(1500);
	});

	test("the start tick is published at once", () => {
		expect(publishAt(Tick.parse(10), Tick.parse(10), 20)).toBe(0);
	});
});
