import { describe, expect, test } from "bun:test";
import { persisterBacklog } from "./backlog.ts";

describe("persisterBacklog", () => {
	test("a second-half max within 3 ticks of events passes", () => {
		expect(persisterBacklog([0, 0, 9000, 9500], 10_000)).toEqual({
			secondHalfMax: 9500,
			limit: 30_000,
			withinLimit: true,
		});
	});

	test("a second-half max over 3 ticks of events fails", () => {
		expect(persisterBacklog([0, 0, 20_000, 31_000], 10_000)).toMatchObject({
			withinLimit: false,
		});
	});

	test("an odd middle sample is not in the second half", () => {
		expect(persisterBacklog([0, 0, 99_999, 10, 20], 10_000)).toMatchObject({
			secondHalfMax: 20,
		});
	});

	test("one sample has no backlog verdict", () => {
		expect(persisterBacklog([10], 10_000)).toBeUndefined();
	});
});
