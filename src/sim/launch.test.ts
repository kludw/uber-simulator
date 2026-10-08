import { describe, expect, test } from "bun:test";
import { RunId } from "../shared/messages.ts";
import { demoEnv, serviceProcesses } from "./launch.ts";

describe("serviceProcesses", () => {
	test("starts one dispatch per region, every process on the same layout, the clock last", () => {
		const processes = serviceProcesses({
			natsUrl: "nats://localhost:4222",
			runId: RunId.parse("run-1"),
			seed: 1,
			speed: 1,
			clockStartDelayMs: 2000,
			grid: { width: 500, height: 500 },
			driverShards: { count: 2, driversPerShard: 50 },
			requestsPerMinute: 10,
			regions: { columns: 2, rows: 1 },
		});

		expect(processes).toEqual([
			{
				name: "dispatch-0",
				entrypoint: "src/dispatch/main.ts",
				env: { REGIONS: "2x1", REGION_INDEX: "0" },
			},
			{
				name: "dispatch-1",
				entrypoint: "src/dispatch/main.ts",
				env: { REGIONS: "2x1", REGION_INDEX: "1" },
			},
			{
				name: "riders",
				entrypoint: "src/rider/main.ts",
				env: { REGIONS: "2x1" },
			},
			{
				name: "driver-shard-0",
				entrypoint: "src/driver/main.ts",
				env: { REGIONS: "2x1", SHARD_INDEX: "0" },
			},
			{
				name: "driver-shard-1",
				entrypoint: "src/driver/main.ts",
				env: { REGIONS: "2x1", SHARD_INDEX: "1" },
			},
			{
				name: "clock",
				entrypoint: "src/clock/main.ts",
				env: { REGIONS: "2x1" },
			},
		]);
	});
});

describe("demoEnv", () => {
	test("with nothing set, runs 100k drivers on city demand with shifts on port 3000", () => {
		expect(demoEnv({})).toEqual({
			DRIVER_SHARDS: "2",
			DRIVERS_PER_SHARD: "50000",
			REQUESTS_PER_MINUTE: "10000",
			DEMAND: "city",
			SHIFTS: "on",
			PREFERENCES: "off",
			MATCHING: "greedy",
			REGIONS: "1x1",
			SPEED: "1",
			SEED: "1",
			UI_PORT: "3000",
		});
	});

	test("a variable set in the environment wins over its demo default", () => {
		expect(
			demoEnv({
				DRIVERS_PER_SHARD: "200000",
				NATS_URL: "nats://localhost:4222",
				SEED: undefined,
			}),
		).toMatchObject({
			DRIVERS_PER_SHARD: "200000",
			NATS_URL: "nats://localhost:4222",
			SEED: "1",
		});
	});
});
