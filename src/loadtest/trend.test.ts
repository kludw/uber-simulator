import { describe, expect, test } from "bun:test";
import { pendingTrend } from "./trend.ts";

describe("pendingTrend", () => {
	test("compares the mean pending count of the second half of the samples with the first", () => {
		expect(pendingTrend([100, 300, 200, 400])).toEqual({
			firstHalfMean: 200,
			secondHalfMean: 300,
			rising: true,
		});
	});

	test("a second half no higher on average than the first is not rising", () => {
		expect(pendingTrend([500, 0, 250, 250])).toMatchObject({ rising: false });
	});

	test("an odd middle sample belongs to neither half", () => {
		expect(pendingTrend([10, 20, 999, 30, 40])).toEqual({
			firstHalfMean: 15,
			secondHalfMean: 35,
			rising: true,
		});
	});

	test("one sample has no trend", () => {
		expect(pendingTrend([10])).toBeUndefined();
	});
});
