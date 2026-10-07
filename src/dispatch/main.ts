// Dispatch service process. Config: src/sim/config.ts.
import { Region } from "../shared/regions.ts";
import { readServiceConfig, runService } from "../sim/process.ts";
import { dispatchService } from "../sim/services.ts";

const config = readServiceConfig("dispatch");
// One region until REGION_INDEX (ADR 0050, #252).
await runService(dispatchService(config, Region.parse(0)), config);
