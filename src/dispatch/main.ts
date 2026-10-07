// One dispatch instance's process; REGION_INDEX picks its region of REGIONS
// (ADR 0050). Config: src/sim/config.ts.
import { parseRegionIndex } from "../sim/config.ts";
import { orExit, readServiceConfig, runService } from "../sim/process.ts";
import { dispatchService } from "../sim/services.ts";

// Untagged by region only while the region itself is invalid.
const region = orExit("dispatch", parseRegionIndex(Bun.env));
const config = readServiceConfig(`dispatch-${region}`);
await runService(dispatchService(config, region), config);
