// `bun run db:migrate`: applies infra/clickhouse/*.sql. Exit codes: 0
// applied, 1 ClickHouse unreachable or a migration failed, 2 invalid config.
import { parseClickHouseConfig } from "../sim/config.ts";
import { log, orExit } from "../sim/process.ts";
import { connectClickHouse, migrate } from "./clickhouse.ts";

const service = "migrate";
const config = orExit(service, parseClickHouseConfig(Bun.env));
const connected = await connectClickHouse(config);
if (!connected.ok) {
	log(service, connected.error);
	process.exit(1);
}
const migrated = await migrate(connected.value);
await connected.value.close();
if (!migrated.ok) {
	log(service, migrated.error);
	process.exit(1);
}
log(service, { type: "migrated", files: migrated.value });
