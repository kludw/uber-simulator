import { describe, expect, test } from "bun:test";
import { persisterBacklog } from "./backlog.ts";

const pending = (...counts: number[]) =>
	counts.map((count) => ({ pending: count, ackPending: 0 }));

describe("persisterBacklog", () => {
	test("a second-half max within 3 ticks of events passes", () => {
		expect(persisterBacklog(pending(0, 0, 9000, 9500), 10_000)).toEqual({
			secondHalfMax: 9500,
			limit: 30_000,
			withinLimit: true,
		});
	});

	test("a second-half max over 3 ticks of events fails", () => {
		expect(
			persisterBacklog(pending(0, 0, 20_000, 31_000), 10_000),
		).toMatchObject({ withinLimit: false });
	});

	test("events the persister holds but hasn't acked don't count", () => {
		// Milestone 18's batched 40k (run 37498494906): 1,206 in the
		// persister's hands against a limit of 1,187, none waiting.
		const samples = [
			{ pending: 0, ackPending: 0 },
			{ pending: 0, ackPending: 400 },
			{ pending: 0, ackPending: 1206 },
			{ pending: 12, ackPending: 380 },
		];
		expect(persisterBacklog(samples, 395.6)).toMatchObject({
			secondHalfMax: 12,
			withinLimit: true,
		});
	});

	test("an odd middle sample is not in the second half", () => {
		expect(
			persisterBacklog(pending(0, 0, 99_999, 10, 20), 10_000),
		).toMatchObject({ secondHalfMax: 20 });
	});

	test("one sample has no backlog verdict", () => {
		expect(persisterBacklog(pending(10), 10_000)).toBeUndefined();
	});
});
