// Dispatch service process. Config: src/sim/config.ts.
import { readServiceConfig, runService } from "../sim/process.ts";
import { dispatchService } from "../sim/services.ts";

const config = readServiceConfig("dispatch");
await runService(dispatchService(config), config);
