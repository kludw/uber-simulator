// Rider service process. Config: src/sim/config.ts.
import { readServiceConfig, runService } from "../sim/process.ts";
import { ridersService } from "../sim/services.ts";

const config = readServiceConfig("riders");
await runService(ridersService(config), config);
