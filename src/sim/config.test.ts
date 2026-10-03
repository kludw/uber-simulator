import { describe, expect, test } from "bun:test";
import { cityDemand } from "../rider/demand.ts";
import { RunId } from "../shared/messages.ts";
import {
	parseClickHouseConfig,
	parsePersisterConfig,
	parseServiceConfig,
	parseShardIndex,
	parseUiConfig,
} from "./config.ts";

describe("parseServiceConfig", () => {
	test("unset variables default to the spec scale at real time", () => {
		expect(
			parseServiceConfig({
				NATS_URL: "nats://localhost:4222",
				RUN_ID: "run-1",
			}),
		).toEqual({
			ok: true,
			value: {
				natsUrl: "nats://localhost:4222",
				runId: RunId.parse("run-1"),
				seed: 1,
				speed: 1,
				clockStartDelayMs: 2000,
				grid: { width: 500, height: 500 },
				driverShards: { count: 2, driversPerShard: 50 },
				requestsPerMinute: 10,
				matching: { type: "greedy" },
				demand: { type: "uniform" },
				shifts: { type: "always_online" },
			},
		});
	});

	test("SHIFTS=on runs drivers on the shift preset", () => {
		const parsed = parseServiceConfig({
			NATS_URL: "nats://nats:4222",
			RUN_ID: "run-1",
			SHIFTS: "on",
		});

		expect(parsed).toMatchObject({
			ok: true,
			value: {
				shifts: {
					type: "shifts",
					onlineTicks: { min: 1200, max: 2400 },
					offlineTicks: { min: 300, max: 900 },
					startOnlineShare: 0.8,
				},
			},
		});
	});

	test("names an unknown SHIFTS", () => {
		const parsed = parseServiceConfig({
			NATS_URL: "nats://nats:4222",
			RUN_ID: "run-1",
			SHIFTS: "yes",
		});

		expect(parsed).toMatchObject({
			ok: false,
			error: { type: "invalid_config", issues: [{ variable: "SHIFTS" }] },
		});
	});

	test("DEMAND=city spawns riders by the city preset", () => {
		const parsed = parseServiceConfig({
			NATS_URL: "nats://nats:4222",
			RUN_ID: "run-1",
			DEMAND: "city",
		});

		expect(parsed).toMatchObject({ ok: true, value: { demand: cityDemand } });
	});

	test("names an unknown DEMAND", () => {
		const parsed = parseServiceConfig({
			NATS_URL: "nats://nats:4222",
			RUN_ID: "run-1",
			DEMAND: "rush_hour",
		});

		expect(parsed).toMatchObject({
			ok: false,
			error: { type: "invalid_config", issues: [{ variable: "DEMAND" }] },
		});
	});

	test("MATCHING=batched matches every BATCH_WINDOW_TICKS ticks", () => {
		const parsed = parseServiceConfig({
			NATS_URL: "nats://nats:4222",
			RUN_ID: "run-1",
			MATCHING: "batched",
			BATCH_WINDOW_TICKS: "10",
		});

		expect(parsed).toMatchObject({
			ok: true,
			value: { matching: { type: "batched", windowTicks: 10 } },
		});
	});

	test("MATCHING=batched without a window defaults it to 5 ticks", () => {
		const parsed = parseServiceConfig({
			NATS_URL: "nats://nats:4222",
			RUN_ID: "run-1",
			MATCHING: "batched",
		});

		expect(parsed).toMatchObject({
			ok: true,
			value: { matching: { type: "batched", windowTicks: 5 } },
		});
	});

	test("names an unknown MATCHING and a non-positive BATCH_WINDOW_TICKS", () => {
		const parsed = parseServiceConfig({
			NATS_URL: "nats://nats:4222",
			RUN_ID: "run-1",
			MATCHING: "fastest",
			BATCH_WINDOW_TICKS: "0",
		});

		expect(parsed).toMatchObject({
			ok: false,
			error: {
				type: "invalid_config",
				issues: [{ variable: "MATCHING" }, { variable: "BATCH_WINDOW_TICKS" }],
			},
		});
	});

	test("set variables override the defaults", () => {
		const parsed = parseServiceConfig({
			NATS_URL: "nats://nats:4222",
			RUN_ID: "0b9e5a64-1f6c-4c43-9f1e-6a3c2d1e8f70",
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
				runId: "0b9e5a64-1f6c-4c43-9f1e-6a3c2d1e8f70",
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
					{ variable: "RUN_ID" },
					{ variable: "SEED" },
					{ variable: "SPEED" },
				],
			},
		});
	});

	// The run id travels as a NATS header value and is a ClickHouse column
	// value and report argument (ADR 0029).
	test.each([[""], ["run 1"], ["run\r\n1"]])("rejects RUN_ID %p", (runId) => {
		expect(
			parseServiceConfig({ NATS_URL: "nats://nats:4222", RUN_ID: runId }),
		).toMatchObject({
			ok: false,
			error: { type: "invalid_config", issues: [{ variable: "RUN_ID" }] },
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

describe("parseUiConfig", () => {
	test("unset port defaults to 3000", () => {
		expect(parseUiConfig({ NATS_WS_URL: "ws://localhost:8080" })).toEqual({
			ok: true,
			value: { natsWsUrl: "ws://localhost:8080", port: 3000 },
		});
	});

	test("set port overrides the default", () => {
		expect(
			parseUiConfig({ NATS_WS_URL: "wss://nats.example", UI_PORT: "8000" }),
		).toEqual({
			ok: true,
			value: { natsWsUrl: "wss://nats.example", port: 8000 },
		});
	});

	test("names every invalid or missing variable", () => {
		expect(parseUiConfig({ UI_PORT: "70000" })).toMatchObject({
			ok: false,
			error: {
				type: "invalid_config",
				issues: [{ variable: "NATS_WS_URL" }, { variable: "UI_PORT" }],
			},
		});
	});

	test("rejects a non-websocket NATS_WS_URL", () => {
		expect(
			parseUiConfig({ NATS_WS_URL: "nats://localhost:4222" }),
		).toMatchObject({
			ok: false,
			error: { type: "invalid_config", issues: [{ variable: "NATS_WS_URL" }] },
		});
	});
});

describe("parseClickHouseConfig", () => {
	test("reads the connection settings", () => {
		expect(
			parseClickHouseConfig({
				CLICKHOUSE_URL: "http://localhost:8123",
				CLICKHOUSE_USER: "sim",
				CLICKHOUSE_PASSWORD: "secret",
				CLICKHOUSE_DB: "sim",
			}),
		).toEqual({
			ok: true,
			value: {
				url: "http://localhost:8123",
				username: "sim",
				password: "secret",
				database: "sim",
			},
		});
	});

	test("names every invalid or missing variable", () => {
		expect(
			parseClickHouseConfig({
				CLICKHOUSE_URL: "nats://localhost:4222",
				CLICKHOUSE_PASSWORD: "",
			}),
		).toMatchObject({
			ok: false,
			error: {
				type: "invalid_config",
				issues: [
					{ variable: "CLICKHOUSE_URL" },
					{ variable: "CLICKHOUSE_USER" },
					{ variable: "CLICKHOUSE_DB" },
				],
			},
		});
	});
});

describe("parsePersisterConfig", () => {
	test("reads the NATS URL and the ClickHouse connection settings", () => {
		expect(
			parsePersisterConfig({
				NATS_URL: "nats://localhost:4222",
				CLICKHOUSE_URL: "http://localhost:8123",
				CLICKHOUSE_USER: "sim",
				CLICKHOUSE_PASSWORD: "secret",
				CLICKHOUSE_DB: "sim",
			}),
		).toEqual({
			ok: true,
			value: {
				natsUrl: "nats://localhost:4222",
				clickhouse: {
					url: "http://localhost:8123",
					username: "sim",
					password: "secret",
					database: "sim",
				},
			},
		});
	});

	test("names every invalid or missing variable", () => {
		expect(
			parsePersisterConfig({
				CLICKHOUSE_URL: "http://localhost:8123",
				CLICKHOUSE_PASSWORD: "",
				CLICKHOUSE_DB: "sim",
			}),
		).toMatchObject({
			ok: false,
			error: {
				type: "invalid_config",
				issues: [{ variable: "NATS_URL" }, { variable: "CLICKHOUSE_USER" }],
			},
		});
	});
});
