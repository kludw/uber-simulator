import { describe, expect, test } from "bun:test";
import { Cell } from "../shared/grid.ts";
import { DriverId, RunId, Tick } from "../shared/messages.ts";
import { publishAt, replaySubject } from "./replay.ts";

describe("replaySubject", () => {
	test("prefixes the live subject with replay and the run id", () => {
		expect(
			replaySubject(RunId.parse("run-1"), {
				type: "driver.moved",
				tick: Tick.parse(3),
				driverId: DriverId.parse("d-1"),
				cell: Cell.parse({ x: 0, y: 0 }),
			}),
		).toBe("replay.run-1.sim.events.driver.moved");
	});
});

describe("publishAt", () => {
	// 1 tick = 1 s sim time; speed = sim seconds per wall second.
	test("a tick is published its sim seconds after the start tick, divided by speed", () => {
		expect(publishAt(Tick.parse(13), Tick.parse(10), 2)).toBe(1500);
	});

	test("the start tick is published at once", () => {
		expect(publishAt(Tick.parse(10), Tick.parse(10), 20)).toBe(0);
	});
});
