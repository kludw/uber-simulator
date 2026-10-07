import { describe, expect, test } from "bun:test";
import { RunId } from "../shared/messages.ts";
import { serviceProcesses } from "./launch.ts";

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
