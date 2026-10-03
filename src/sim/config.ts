import * as z from "zod";
import type { ClickHouseConfig } from "../persistence/clickhouse.ts";
import { specGrid } from "../shared/grid.ts";
import { RunId } from "../shared/messages.ts";
import type { Result } from "../shared/result.ts";
import type { SimConfig } from "./services.ts";

// Every service process reads the same variables, so they agree on the
// simulation (seed, shard sizes, ...).
export type ServiceConfig = SimConfig & {
	natsUrl: string;
	// Stamped on every publish as the Run-Id header (ADR 0029).
	runId: RunId;
	// Sim seconds per wall second; only the clock paces by it.
	speed: number;
	// Wall time the clock waits before tick 1, for the other services to
	// subscribe.
	clockStartDelayMs: number;
};

export type InvalidConfig = {
	type: "invalid_config";
	issues: { variable: string; message: string }[];
};

const integer = z
	.string()
	.regex(z.regexes.integer, { error: "expected an integer" })
	.transform(Number);

const Env = z.object({
	NATS_URL: z.url(),
	RUN_ID: RunId,
	// createRandom folds the seed to 32 bits; larger seeds would alias.
	SEED: integer
		.pipe(
			z
				.int()
				.min(0)
				.max(2 ** 32 - 1),
		)
		.default(1),
	SPEED: z
		.string()
		.regex(z.regexes.number, { error: "expected a number" })
		.transform(Number)
		.pipe(z.number().positive())
		.default(1),
	CLOCK_START_DELAY_MS: integer.pipe(z.int().min(0)).default(2000),
	// Spec defaults (docs/spec.md).
	DRIVER_SHARDS: integer.pipe(z.int().positive()).default(2),
	DRIVERS_PER_SHARD: integer.pipe(z.int().positive()).default(50),
	REQUESTS_PER_MINUTE: integer.pipe(z.int().min(0)).default(10),
});

export function parseServiceConfig(
	env: Record<string, string | undefined>,
): Result<ServiceConfig, InvalidConfig> {
	const parsed = Env.safeParse(env);
	if (!parsed.success) return invalidConfig(parsed.error);
	const vars = parsed.data;
	return {
		ok: true,
		value: {
			natsUrl: vars.NATS_URL,
			runId: vars.RUN_ID,
			seed: vars.SEED,
			speed: vars.SPEED,
			clockStartDelayMs: vars.CLOCK_START_DELAY_MS,
			grid: specGrid,
			driverShards: {
				count: vars.DRIVER_SHARDS,
				driversPerShard: vars.DRIVERS_PER_SHARD,
			},
			requestsPerMinute: vars.REQUESTS_PER_MINUTE,
		},
	};
}

export type UiConfig = { natsWsUrl: string; port: number };

const UiEnv = z.object({
	NATS_WS_URL: z.url({ protocol: /^wss?$/ }),
	UI_PORT: integer.pipe(z.int().min(1).max(65535)).default(3000),
});

export function parseUiConfig(
	env: Record<string, string | undefined>,
): Result<UiConfig, InvalidConfig> {
	const parsed = UiEnv.safeParse(env);
	if (!parsed.success) return invalidConfig(parsed.error);
	return {
		ok: true,
		value: { natsWsUrl: parsed.data.NATS_WS_URL, port: parsed.data.UI_PORT },
	};
}

const ClickHouseEnv = z.object({
	CLICKHOUSE_URL: z.url({ protocol: /^https?$/ }),
	CLICKHOUSE_USER: z.string().min(1),
	// Empty is a valid password.
	CLICKHOUSE_PASSWORD: z.string(),
	CLICKHOUSE_DB: z.string().min(1),
});

export function parseClickHouseConfig(
	env: Record<string, string | undefined>,
): Result<ClickHouseConfig, InvalidConfig> {
	const parsed = ClickHouseEnv.safeParse(env);
	if (!parsed.success) return invalidConfig(parsed.error);
	const vars = parsed.data;
	return {
		ok: true,
		value: {
			url: vars.CLICKHOUSE_URL,
			username: vars.CLICKHOUSE_USER,
			password: vars.CLICKHOUSE_PASSWORD,
			database: vars.CLICKHOUSE_DB,
		},
	};
}

// Driver processes only: which of `shardCount` shards this one runs.
export function parseShardIndex(
	env: Record<string, string | undefined>,
	shardCount: number,
): Result<number, InvalidConfig> {
	const parsed = z
		.object({
			SHARD_INDEX: integer.pipe(
				z
					.int()
					.min(0)
					.max(shardCount - 1),
			),
		})
		.safeParse(env);
	if (!parsed.success) return invalidConfig(parsed.error);
	return { ok: true, value: parsed.data.SHARD_INDEX };
}

// Schemas are objects keyed by variable, so each issue's path starts with it.
function invalidConfig(error: z.ZodError): Result<never, InvalidConfig> {
	return {
		ok: false,
		error: {
			type: "invalid_config",
			issues: error.issues.map((issue) => ({
				variable: String(issue.path[0]),
				message: issue.message,
			})),
		},
	};
}
