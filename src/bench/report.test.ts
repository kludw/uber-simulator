import { describe, expect, test } from "bun:test";
import { benchReport } from "./report.ts";

const config = {
	seed: 1,
	ticks: 20,
	grid: { width: 500, height: 500 },
	driverShards: { count: 2, driversPerShard: 500 },
	requestsPerMinute: 100,
	matching: { type: "batched", windowTicks: 5 },
	regions: { columns: 2, rows: 1 },
} as const;

describe("benchReport", () => {
	test("reports per-tick wall time as mean and nearest-rank p95, and memory in MiB", () => {
		expect(
			benchReport(config, {
				// 1..20 ms, out of order: mean 10.5, p95 = 19th of 20 sorted.
				tickMs: [
					7, 20, 1, 14, 3, 19, 9, 12, 5, 17, 2, 11, 16, 4, 18, 8, 13, 6, 15, 10,
				],
				messages: 4321,
				peakRssBytes: 268_435_456,
				heapBytes: 104_857_600,
				heapObjects: 98_765,
				status: { type: "finished" },
			}),
		).toBe(
			[
				"seed: 1",
				"ticks: 20",
				"drivers: 1000 (2 shards x 500)",
				"requests per minute: 100",
				"matching: batched (window 5 ticks)",
				"regions: 2x1",
				"wall ms per tick: mean 10.50, p95 19.00",
				"total messages: 4321",
				"peak rss: 256.0 MiB",
				"heap at end: 100.0 MiB, 98765 objects",
				"status: finished",
			].join("\n"),
		);
	});

	test("a run stopped at its time limit reports the ticks it completed and the limit", () => {
		expect(
			benchReport(config, {
				tickMs: [30, 10, 20],
				messages: 99,
				peakRssBytes: 2 ** 20,
				heapBytes: 2 ** 20,
				heapObjects: 7,
				status: { type: "did_not_finish", maxMinutes: 0.05 },
			}),
		).toBe(
			[
				"seed: 1",
				"ticks: 3 of 20",
				"drivers: 1000 (2 shards x 500)",
				"requests per minute: 100",
				"matching: batched (window 5 ticks)",
				"regions: 2x1",
				"wall ms per tick: mean 20.00, p95 30.00",
				"total messages: 99",
				"peak rss: 1.0 MiB",
				"heap at end: 1.0 MiB, 7 objects",
				"status: did not finish in 0.05 min",
			].join("\n"),
		);
	});
});
