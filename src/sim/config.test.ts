import { describe, expect, test } from "bun:test";
import { parseServiceConfig, parseShardIndex } from "./config.ts";

describe("parseServiceConfig", () => {
	test("unset variables default to the spec scale at real time", () => {
		expect(parseServiceConfig({ NATS_URL: "nats://localhost:4222" })).toEqual({
			ok: true,
			value: {
				natsUrl: "nats://localhost:4222",
				seed: 1,
				speed: 1,
				clockStartDelayMs: 2000,
				grid: { width: 500, height: 500 },
				driverShards: { count: 2, driversPerShard: 50 },
				requestsPerMinute: 10,
			},
		});
	});

	test("set variables override the defaults", () => {
		const parsed = parseServiceConfig({
			NATS_URL: "nats://nats:4222",
			SEED: "42",
			SPEED: "2.5",
			CLOCK_START_DELAY_MS: "0",
			DRIVER_SHARDS: "3",
			DRIVERS_PER_SHARD: "10",
			REQUESTS_PER_MINUTE: "60",
		});

		expect(parsed).toMatchObject({
			ok: true,
			value: {
				natsUrl: "nats://nats:4222",
				seed: 42,
				speed: 2.5,
				clockStartDelayMs: 0,
				driverShards: { count: 3, driversPerShard: 10 },
				requestsPerMinute: 60,
			},
		});
	});

	test("names every invalid or missing variable", () => {
		const parsed = parseServiceConfig({ SPEED: "0", SEED: "1.5" });

		expect(parsed).toMatchObject({
			ok: false,
			error: {
				type: "invalid_config",
				issues: [
					{ variable: "NATS_URL" },
					{ variable: "SEED" },
					{ variable: "SPEED" },
				],
			},
		});
	});
});

describe("parseShardIndex", () => {
	test("reads the shard index", () => {
		expect(parseShardIndex({ SHARD_INDEX: "1" }, 2)).toEqual({
			ok: true,
			value: 1,
		});
	});

	test.each([[undefined], ["2"], ["-1"], ["one"]])(
		"rejects SHARD_INDEX %p for 2 shards",
		(index) => {
			expect(parseShardIndex({ SHARD_INDEX: index }, 2)).toMatchObject({
				ok: false,
				error: {
					type: "invalid_config",
					issues: [{ variable: "SHARD_INDEX" }],
				},
			});
		},
	);
});
