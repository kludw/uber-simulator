// One driver shard's process; SHARD_INDEX picks the shard. Config:
// src/sim/config.ts.
import { parseShardIndex } from "../sim/config.ts";
import { orExit, readServiceConfig, runService } from "../sim/process.ts";
import { driverShardService } from "../sim/services.ts";

const config = readServiceConfig("driver-shard");
const shard = orExit(
	"driver-shard",
	parseShardIndex(Bun.env, config.driverShards.count),
);
await runService(driverShardService(config, shard), config);
