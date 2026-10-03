import { describe, expect, test } from "bun:test";
import { parseBenchArgs } from "./args.ts";

describe("parseBenchArgs", () => {
	test("demand scales with the fleet at the spec ratio, drivers split over two shards", () => {
		expect(
			parseBenchArgs([
				"--drivers",
				"1000",
				"--ticks",
				"600",
				"--matching",
				"greedy",
			]),
		).toEqual({
			ok: true,
			value: {
				seed: 1,
				ticks: 600,
				grid: { width: 500, height: 500 },
				driverShards: { count: 2, driversPerShard: 500 },
				// 10 requests/min per 100 drivers (docs/spec.md).
				requestsPerMinute: 100,
				matching: { type: "greedy" },
				demand: { type: "uniform" },
				shifts: { type: "always_online" },
			},
		});
	});

	test("batched matching and shard count are set per run", () => {
		expect(
			parseBenchArgs([
				"--drivers",
				"10000",
				"--shards",
				"4",
				"--matching",
				"batched",
				"--batch-window",
				"10",
			]),
		).toMatchObject({
			ok: true,
			value: {
				driverShards: { count: 4, driversPerShard: 2500 },
				matching: { type: "batched", windowTicks: 10 },
			},
		});
	});

	test("a fleet that doesn't split evenly over the shards is invalid", () => {
		expect(
			parseBenchArgs(["--drivers", "1001", "--shards", "2"]),
		).toMatchObject({ ok: false, error: { type: "invalid_args" } });
	});
});
