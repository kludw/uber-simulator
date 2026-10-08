import * as z from "zod";
import type { Preferences, Shifts } from "../driver/brain.ts";
import type { ClickHouseConfig } from "../persistence/clickhouse.ts";
import { cityDemand, type Demand } from "../rider/demand.ts";
import { specGrid } from "../shared/grid.ts";
import { RunId } from "../shared/messages.ts";
import { oneRegion, Region, RegionLayout } from "../shared/regions.ts";
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

// Demand models selectable by name, from env (DEMAND) or the CLI (--demand).
export const DemandName = z.enum(["uniform", "city"]);

export function demandNamed(name: z.infer<typeof DemandName>): Demand {
	return name === "city" ? cityDemand : { type: "uniform" };
}

// Shift models selectable by name, from env (SHIFTS) or the CLI (--shifts).
export const ShiftsName = z.enum(["off", "on"]);

// The one shift preset (ADR 0032). Mean online 1800 ticks vs mean offline
// 600 keeps about 75% of drivers online in steady state; starting 80% online
// stays near that instead of a mass log-on. 20-40 min online means every
// driver of a simulated hour changes shift at least once.
const shiftPreset: Shifts = {
	type: "shifts",
	onlineTicks: { min: 1200, max: 2400 },
	offlineTicks: { min: 300, max: 900 },
	startOnlineShare: 0.8,
};

export function shiftsNamed(name: z.infer<typeof ShiftsName>): Shifts {
	return name === "on" ? shiftPreset : { type: "always_online" };
}

// Preference models selectable by name, from env (PREFERENCES) or the CLI
// (--preferences).
export const PreferencesName = z.enum(["off", "picky"]);

// The one picky preset (ADR 0035). At spec scale (100 drivers on 500 x 500
// cells) a driver has about 2500 cells to itself, a Manhattan radius of
// about 35 cells, so the nearest idle driver is typically tens of cells
// away: max pickup 20-80 cells (200-800 m) makes distance declines common
// but leaves most drivers willing nearby. 10% other declines stay visible
// without dominating.
const pickyPreset: Preferences = {
	type: "picky",
	maxPickupDistance: { min: 20, max: 80 },
	declineShare: 0.1,
};

export function preferencesNamed(
	name: z.infer<typeof PreferencesName>,
): Preferences {
	return name === "picky" ? pickyPreset : { type: "accept_all" };
}

// Surge pricing selectable by name, from env (SURGE) or the CLI (--surge).
// Every process of a run must get the same value (ADR 0054).
export const SurgeName = z.enum(["off", "on"]);

// Every process of a run must get the same value (ADR 0050).
const Regions = RegionLayout.refine(
	({ columns, rows }) => columns <= specGrid.width && rows <= specGrid.height,
	{ error: "more regions than grid cells across" },
).default(oneRegion);

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
	// Dispatch only (ADR 0030). The window applies to batched alone.
	MATCHING: z.enum(["greedy", "batched"]).default("greedy"),
	BATCH_WINDOW_TICKS: integer.pipe(z.int().positive()).default(5),
	// Riders only (ADR 0031).
	DEMAND: DemandName.default("uniform"),
	// Driver shards only (ADR 0032).
	SHIFTS: ShiftsName.default("off"),
	// Driver shards only (ADR 0035).
	PREFERENCES: PreferencesName.default("off"),
	REGIONS: Regions,
	SURGE: SurgeName.default("off"),
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
			matching:
				vars.MATCHING === "batched"
					? { type: "batched", windowTicks: vars.BATCH_WINDOW_TICKS }
					: { type: "greedy" },
			demand: demandNamed(vars.DEMAND),
			shifts: shiftsNamed(vars.SHIFTS),
			preferences: preferencesNamed(vars.PREFERENCES),
			regions: vars.REGIONS,
			surge: vars.SURGE === "on",
		},
	};
}

// regions: the run's layout, to draw surging zone parts (ADR 0054).
export type UiConfig = {
	natsWsUrl: string;
	port: number;
	regions: RegionLayout;
};

const UiEnv = z.object({
	NATS_WS_URL: z.url({ protocol: /^wss?$/ }),
	UI_PORT: integer.pipe(z.int().min(1).max(65535)).default(3000),
	REGIONS: Regions,
});

export function parseUiConfig(
	env: Record<string, string | undefined>,
): Result<UiConfig, InvalidConfig> {
	const parsed = UiEnv.safeParse(env);
	if (!parsed.success) return invalidConfig(parsed.error);
	return {
		ok: true,
		value: {
			natsWsUrl: parsed.data.NATS_WS_URL,
			port: parsed.data.UI_PORT,
			regions: parsed.data.REGIONS,
		},
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
	return { ok: true, value: clickHouseConfig(parsed.data) };
}

function clickHouseConfig(
	vars: z.infer<typeof ClickHouseEnv>,
): ClickHouseConfig {
	return {
		url: vars.CLICKHOUSE_URL,
		username: vars.CLICKHOUSE_USER,
		password: vars.CLICKHOUSE_PASSWORD,
		database: vars.CLICKHOUSE_DB,
	};
}

export type PersisterConfig = { natsUrl: string; clickhouse: ClickHouseConfig };

const PersisterEnv = z
	.object({ NATS_URL: z.url() })
	.extend(ClickHouseEnv.shape);

export function parsePersisterConfig(
	env: Record<string, string | undefined>,
): Result<PersisterConfig, InvalidConfig> {
	const parsed = PersisterEnv.safeParse(env);
	if (!parsed.success) return invalidConfig(parsed.error);
	return {
		ok: true,
		value: {
			natsUrl: parsed.data.NATS_URL,
			clickhouse: clickHouseConfig(parsed.data),
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

// Dispatch processes only: which region of REGIONS this one owns. Reads
// REGIONS itself, so a dispatch knows its region before the rest of its
// config (its logs are tagged dispatch-<region>).
export function parseRegionIndex(
	env: Record<string, string | undefined>,
): Result<Region, InvalidConfig> {
	const parsed = z
		.object({ REGIONS: Regions, REGION_INDEX: integer.pipe(Region) })
		.refine(
			({ REGIONS, REGION_INDEX }) =>
				REGION_INDEX < REGIONS.columns * REGIONS.rows,
			{
				error: "outside REGIONS",
				path: ["REGION_INDEX"],
				// Only once both parsed: an index that isn't one is reported once.
				when: (payload) => payload.issues.length === 0,
			},
		)
		.safeParse(env);
	if (!parsed.success) return invalidConfig(parsed.error);
	return { ok: true, value: parsed.data.REGION_INDEX };
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
