// Persister process (ADR 0029): sim.events.> from JetStream into ClickHouse.
// Config: NATS_URL and CLICKHOUSE_* (src/sim/config.ts). Exit codes: 0
// stopped by SIGINT/SIGTERM, 1 NATS or ClickHouse unreachable, migration or
// JetStream setup failed, or fetching failed (NATS connection closed, or 5
// failures in a row), 2 invalid config.
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { connectClickHouse } from "../persistence/clickhouse.ts";
import { parsePersisterConfig } from "../sim/config.ts";
import { log, orExit } from "../sim/process.ts";
import { simEvents, startPersister } from "./persister.ts";

const service = "persister";
const config = orExit(service, parsePersisterConfig(Bun.env));

const clickhouse = await connectClickHouse(config.clickhouse);
if (!clickhouse.ok) {
	log(service, clickhouse.error);
	process.exit(1);
}
let nats: NatsConnection;
try {
	nats = await connect({ servers: config.natsUrl });
} catch (cause) {
	log(service, { type: "nats_connect_failed", url: config.natsUrl, cause });
	process.exit(1);
}
const started = await startPersister({
	nats,
	clickhouse: clickhouse.value,
	source: simEvents,
	log: (entry) => log(service, entry),
});
if (!started.ok) {
	log(service, started.error);
	process.exit(1);
}
const persister = started.value;
let signal: NodeJS.Signals | undefined;
const stop = (received: NodeJS.Signals) => {
	signal ??= received;
	persister.stop();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
log(service, {
	type: "service_started",
	stream: simEvents.stream,
	consumer: simEvents.consumer,
});

const stopped = await persister.stopped;
// Drain flushes the last acks; a lost connection has nothing left to drain.
if (!nats.isClosed()) await nats.drain();
await clickhouse.value.close();
if (!stopped.ok) {
	log(service, stopped.error);
	process.exit(1);
}
log(service, { type: "service_stopped", signal });
