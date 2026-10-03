// `bun run replay -- --run <id> [--speed N] [--from-tick T]`: republishes a
// stored run on replay.<runId>.<live subject>, paced by tick (ADR 0034).
// Publishes only, on a plain connection: the Bus would publish on sim.>.
// Exit codes: 0 replayed, 1 no stored events for the run (from --from-tick),
// 2 invalid args or config, 3 NATS or ClickHouse unreachable or failed.
import {
	ClosedConnectionError,
	connect,
	type NatsConnection,
} from "@nats-io/transport-node";
import * as z from "zod";
import { connectClickHouse } from "../persistence/clickhouse.ts";
import type { Tick } from "../shared/messages.ts";
import { parseClickHouseConfig } from "../sim/config.ts";
import { log, orExit } from "../sim/process.ts";
import { parseReplayArgs } from "./args.ts";
import { readRunEvents } from "./events.ts";
import { publishAt, replaySubject } from "./replay.ts";

const service = "replay";

const args = parseReplayArgs(Bun.argv.slice(2));
if (!args.ok) {
	console.error(args.error.message);
	console.error(
		"usage: bun run replay -- --run <run id> [--speed N] [--from-tick T]",
	);
	process.exit(2);
}
const { runId, speed, fromTick } = args.value;
const natsUrl = z.url().safeParse(Bun.env.NATS_URL);
if (!natsUrl.success) {
	console.error(`NATS_URL: ${z.prettifyError(natsUrl.error)}`);
	process.exit(2);
}
const clickhouseConfig = orExit(service, parseClickHouseConfig(Bun.env));

const connected = await connectClickHouse(clickhouseConfig);
if (!connected.ok) {
	log(service, connected.error);
	process.exit(3);
}
const clickhouse = connected.value;
let nats: NatsConnection;
try {
	nats = await connect({ servers: natsUrl.data });
} catch (cause) {
	log(service, { type: "nats_connect_failed", url: natsUrl.data, cause });
	process.exit(3);
}

let start: { tick: Tick; at: number } | undefined;
let published = 0;
for await (const read of readRunEvents(clickhouse, runId, {
	fromTick,
	log: (entry) => log(service, entry),
})) {
	if (!read.ok) {
		log(service, read.error);
		process.exit(3);
	}
	const { tick, message } = read.value;
	if (start === undefined) {
		start = { tick, at: performance.now() };
		log(service, { type: "replay_started", runId, startTick: tick, speed });
	}
	// Wall-clock pacing is a shell concern, like the clock service's.
	const wait =
		start.at + publishAt(tick, start.tick, speed) - performance.now();
	if (wait > 0) await Bun.sleep(wait);
	try {
		nats.publish(replaySubject(runId, message), JSON.stringify(message));
	} catch (cause) {
		// The client gave up reconnecting.
		if (!(cause instanceof ClosedConnectionError)) throw cause;
		log(service, { type: "nats_closed", cause });
		process.exit(3);
	}
	published += 1;
}

try {
	// Delivers everything published before exiting.
	await nats.drain();
} catch (cause) {
	log(service, { type: "nats_drain_failed", cause });
	process.exit(3);
}
await clickhouse.close();
if (start === undefined) {
	console.error(
		`no stored events for run id: ${runId}${fromTick === undefined ? "" : ` from tick ${fromTick}`} (bun run report -- --list shows stored runs)`,
	);
	process.exit(1);
}
log(service, { type: "replay_finished", runId, events: published });
