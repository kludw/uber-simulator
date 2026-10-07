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
