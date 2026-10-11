import { describe, expect, test } from "bun:test";
import { parseLoadtestArgs } from "./args.ts";

describe("parseLoadtestArgs", () => {
	test("demand scales with the fleet at the spec ratio, drivers split over two shards, five minutes to drain", () => {
		expect(parseLoadtestArgs(["--drivers", "1000", "--ticks", "120"])).toEqual({
			ok: true,
			value: {
				ticks: 120,
				driverShards: { count: 2, driversPerShard: 500 },
				// 10 requests/min per 100 drivers (docs/spec.md).
				requestsPerMinute: 100,
				matching: { type: "greedy" },
				regions: { columns: 1, rows: 1 },
				surge: false,
				pooling: false,
				drainBoundMs: 300_000,
				natsMonitoringUrl: "http://localhost:8222",
			},
		});
	});

	test("batched matching, shard count, and drain bound are set per run", () => {
		expect(
			parseLoadtestArgs([
				"--drivers",
				"10000",
				"--shards",
				"4",
				"--matching",
				"batched",
				"--batch-window",
				"10",
				"--drain-minutes",
				"0.5",
			]),
		).toMatchObject({
			ok: true,
			value: {
				driverShards: { count: 4, driversPerShard: 2500 },
				matching: { type: "batched", windowTicks: 10 },
				drainBoundMs: 30_000,
			},
		});
	});

	test("--regions splits dispatch into columns x rows regions", () => {
		expect(parseLoadtestArgs(["--regions", "2x1"])).toMatchObject({
			ok: true,
			value: { regions: { columns: 2, rows: 1 } },
		});
	});

	// ADR 0054: the cost of pricing at scale.
	test("--surge on turns surge pricing on", () => {
		expect(parseLoadtestArgs(["--surge", "on"])).toMatchObject({
			ok: true,
			value: { surge: true },
		});
	});

	test("--surge other than on or off is invalid", () => {
		expect(parseLoadtestArgs(["--surge", "yes"])).toMatchObject({
			ok: false,
			error: { type: "invalid_args" },
		});
	});

	// ADR 0056: the cost of pooling at scale.
	test("--pooling on turns pooling on", () => {
		expect(parseLoadtestArgs(["--pooling", "on"])).toMatchObject({
			ok: true,
			value: { pooling: true },
		});
	});

	test("--pooling other than on or off is invalid", () => {
		expect(parseLoadtestArgs(["--pooling", "yes"])).toMatchObject({
			ok: false,
			error: { type: "invalid_args" },
		});
	});

	test.each([["2"], ["0x1"], ["501x1"]])(
		"--regions %p is invalid",
		(layout) => {
			expect(parseLoadtestArgs(["--regions", layout])).toMatchObject({
				ok: false,
				error: { type: "invalid_args" },
			});
		},
	);

	test("a fleet that doesn't split evenly over the shards is invalid", () => {
		expect(
			parseLoadtestArgs(["--drivers", "1001", "--shards", "2"]),
		).toMatchObject({ ok: false, error: { type: "invalid_args" } });
	});

	test("an unknown option is invalid", () => {
		expect(parseLoadtestArgs(["--speed", "10"])).toMatchObject({
			ok: false,
			error: { type: "invalid_args" },
		});
	});
});
