// The service processes a launcher (`bun run dev`, `bun run loadtest`) starts
// after the persister. Each gets the run's environment plus `env`.
import { oneRegion } from "../shared/regions.ts";
import type { ServiceConfig } from "./config.ts";

export type ServiceProcess = {
	name: string;
	entrypoint: string;
	env: Record<string, string>;
};

// One dispatch per region (ADR 0050). Every process gets REGIONS from the
// one layout the dispatch count comes from: a process on another layout
// would misroute silently.
export function serviceProcesses(config: ServiceConfig): ServiceProcess[] {
	const { columns, rows } = config.regions ?? oneRegion;
	const shared = { REGIONS: `${columns}x${rows}` };
	return [
		...Array.from({ length: columns * rows }, (_, region) => ({
			name: `dispatch-${region}`,
			entrypoint: "src/dispatch/main.ts",
			env: { ...shared, REGION_INDEX: String(region) },
		})),
		{ name: "riders", entrypoint: "src/rider/main.ts", env: shared },
		...Array.from({ length: config.driverShards.count }, (_, shard) => ({
			name: `driver-shard-${shard}`,
			entrypoint: "src/driver/main.ts",
			env: { ...shared, SHARD_INDEX: String(shard) },
		})),
		// Last, though its start delay is what keeps tick 1 after the others
		// subscribe.
		{ name: "clock", entrypoint: "src/clock/main.ts", env: shared },
	];
}

// `bun run demo`'s defaults (ADR 0053): 100k drivers at the spec's ratio of
// requests to drivers, a city that moves (hotspots, shifts). A variable set
// in `env` wins, e.g. DRIVERS_PER_SHARD=200000 for 400k.
const demoDefaults = {
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
};

export function demoEnv(
	env: Record<string, string | undefined>,
): Record<string, string> {
	const set = Object.entries(env).filter(
		(entry): entry is [string, string] => entry[1] !== undefined,
	);
	return { ...demoDefaults, ...Object.fromEntries(set) };
}
