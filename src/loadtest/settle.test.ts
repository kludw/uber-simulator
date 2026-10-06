import { describe, expect, test } from "bun:test";
import { createSettleTracker } from "./settle.ts";

const moved = "sim.events.drivers.moved";
// Payload bytes, where a test doesn't count them.
const bytes = 70;

describe("createSettleTracker", () => {
	test("a tick settles when the last event of that tick arrives, after its clock.ticked", () => {
		const tracker = createSettleTracker(3);
		tracker.clockTicked(1, 1000, bytes);
		tracker.eventReceived(1, 1100, moved, bytes);
		tracker.eventReceived(1, 1300, moved, bytes);
		tracker.clockTicked(2, 2000, bytes);
		tracker.eventReceived(2, 2100, moved, bytes);
		tracker.clockTicked(3, 3000, bytes);
		tracker.eventReceived(3, 3600, moved, bytes);
		// Settle 300, 100, 600 ms: mean 333.3, nearest-rank p95 600, max 600.
		expect(tracker.summary().settleMs).toEqual({
			mean: 1000 / 3,
			p95: 600,
			max: 600,
		});
	});

	test("an event of tick t arriving after clock.ticked t+1 makes tick t an overrun", () => {
		const tracker = createSettleTracker(3);
		tracker.clockTicked(1, 1000, bytes);
		// Early: overrun is by arrival order, not by the 1,000 ms mark.
		tracker.clockTicked(2, 1900, bytes);
		tracker.eventReceived(1, 1950, moved, bytes);
		tracker.eventReceived(2, 2100, moved, bytes);
		tracker.clockTicked(3, 2950, bytes);
		tracker.eventReceived(3, 3100, moved, bytes);
		expect(tracker.summary().overruns).toBe(1);
	});

	test("the last tick, with no clock.ticked after it, is an overrun once it takes 1,000 ms", () => {
		const tracker = createSettleTracker(2);
		tracker.clockTicked(1, 1000, bytes);
		tracker.eventReceived(1, 1500, moved, bytes);
		tracker.clockTicked(2, 2000, bytes);
		tracker.eventReceived(2, 3000, moved, bytes);
		expect(tracker.summary().overruns).toBe(1);
	});

	test("the observer's clock check is the largest gap between clock.ticked receipts away from 1,000 ms", () => {
		const tracker = createSettleTracker(4);
		tracker.clockTicked(1, 1000, bytes);
		tracker.clockTicked(2, 2030, bytes);
		tracker.clockTicked(3, 2990, bytes);
		tracker.clockTicked(4, 3990, bytes);
		// Gaps 1030, 960, 1000.
		expect(tracker.summary().clockMaxDeviationMs).toBe(40);
	});

	test("events of ticks 1..T count towards the message rate per tick, clock.ticked included", () => {
		const tracker = createSettleTracker(2);
		tracker.eventReceived(0, 900, moved, bytes);
		tracker.clockTicked(1, 1000, bytes);
		tracker.eventReceived(1, 1100, moved, bytes);
		tracker.eventReceived(1, 1200, moved, bytes);
		tracker.clockTicked(2, 2000, bytes);
		tracker.eventReceived(2, 2100, moved, bytes);
		tracker.eventReceived(3, 3100, moved, bytes);
		expect(tracker.summary()).toMatchObject({
			ticksObserved: 2,
			messages: 5,
		});
	});

	test("counts, per subject, the observed ticks whose last event had that subject, most first", () => {
		const matched = "sim.events.trip.matched";
		const tracker = createSettleTracker(4);
		tracker.clockTicked(1, 1000, bytes);
		tracker.eventReceived(1, 1100, matched, bytes);
		tracker.eventReceived(1, 1200, moved, bytes);
		tracker.clockTicked(2, 2000, bytes);
		tracker.eventReceived(2, 2100, moved, bytes);
		tracker.eventReceived(2, 2300, matched, bytes);
		tracker.clockTicked(3, 3000, bytes);
		tracker.eventReceived(3, 3100, matched, bytes);
		// Tick 4: no clock.ticked observed, so not counted.
		tracker.eventReceived(4, 4100, moved, bytes);
		expect(tracker.summary().lastEventSubjects).toEqual([
			{ subject: matched, ticks: 2 },
			{ subject: moved, ticks: 1 },
		]);
	});

	test("counts events and payload bytes of ticks 1..T per subject, clock.ticked included, most events first", () => {
		const matched = "sim.events.trip.matched";
		const clock = "sim.events.clock.ticked";
		const tracker = createSettleTracker(2);
		tracker.eventReceived(0, 900, moved, 70);
		tracker.clockTicked(1, 1000, 25);
		tracker.eventReceived(1, 1100, moved, 70);
		tracker.eventReceived(1, 1150, moved, 71);
		tracker.eventReceived(1, 1200, matched, 120);
		tracker.clockTicked(2, 2000, 25);
		tracker.eventReceived(2, 2100, moved, 70);
		tracker.eventReceived(3, 3100, matched, 120);
		expect(tracker.summary().bySubject).toEqual([
			{ subject: moved, events: 3, bytes: 211 },
			{ subject: clock, events: 2, bytes: 50 },
			{ subject: matched, events: 1, bytes: 120 },
		]);
	});
});
