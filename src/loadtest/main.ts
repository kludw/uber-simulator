// `bun run loadtest` (ADR 0037): the real stack at SPEED=1, started like
// `bun run dev` (persister first, the rest once it logs service_started),
// watched by an observer on its own NATS connection, stopped after tick T.
// stdout is the report; service output goes to stderr, prefixed. Exit codes:
// 0 report printed (whatever its verdicts), 1 the stack or infra failed, 2
// invalid args or env.
import { cpus, loadavg } from "node:os";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import * as z from "zod";
import { simEvents } from "../persister/persister.ts";
import { Tick } from "../shared/messages.ts";
import { simEventSubjects, subjectFor } from "../shared/subjects.ts";
import { parsePersisterConfig, parseServiceConfig } from "../sim/config.ts";
import { parseLoadtestArgs } from "./args.ts";
import type { PersisterSample } from "./backlog.ts";
import { createInfraReader, type InfraReading } from "./infra.ts";
import { readPendingBytes, readSlowConsumers } from "./monitoring.ts";
import { type LoadtestMeasurement, loadtestReport } from "./report.ts";
import { createSettleTracker } from "./settle.ts";

const persisterReadyTimeoutMs = 30_000;
const sampleIntervalMs = 5000;
const drainPollMs = 1000;
// After tick T, how long the observer still counts events of ticks <= T.
// Events of tick T arriving later are never seen, so tick T's settle is
// understated by them (the report says so).
const settleGraceMs = 2000;
const observerName = "loadtest-observer";

const args = parseLoadtestArgs(Bun.argv.slice(2));
if (!args.ok) fail(args.error.message, 2);
const { ticks, driverShards, matching, drainBoundMs, natsMonitoringUrl } =
	args.value;

// Every service reads the same variables (src/sim/config.ts): this run's
// fleet at real time, spec defaults for everything else.
const runEnv: Record<string, string | undefined> = {
	...Bun.env,
	RUN_ID: crypto.randomUUID(),
	SPEED: "1",
	DRIVER_SHARDS: String(driverShards.count),
	DRIVERS_PER_SHARD: String(driverShards.driversPerShard),
	REQUESTS_PER_MINUTE: String(args.value.requestsPerMinute),
	MATCHING: matching.type,
	BATCH_WINDOW_TICKS: String(
		matching.type === "batched" ? matching.windowTicks : 5,
	),
	DEMAND: "uniform",
	SHIFTS: "off",
	PREFERENCES: "off",
};
const serviceConfig = parseServiceConfig(runEnv);
if (!serviceConfig.ok) fail(JSON.stringify(serviceConfig.error), 2);
const persisterConfig = parsePersisterConfig(runEnv);
if (!persisterConfig.ok) fail(JSON.stringify(persisterConfig.error), 2);
console.error(`[loadtest] run id: ${serviceConfig.value.runId}`);

// slow_consumers counts since the server started: the run's are the rise.
const slowConsumersBefore = orFail(await readSlowConsumers(natsMonitoringUrl));
const infra = orFail(
	await createInfraReader({
		natsUrl: serviceConfig.value.natsUrl,
		clickhouse: persisterConfig.value.clickhouse,
	}),
);
const infraReadings: InfraReading[] = [orFail(await infra.read())];

let observer: NatsConnection;
try {
	observer = await connect({
		servers: serviceConfig.value.natsUrl,
		name: observerName,
	});
} catch (cause) {
	fail(`NATS unreachable: ${String(cause)}`, 1);
}
const jsm = await jetstreamManager(observer).catch((cause: unknown) =>
	fail(`JetStream unavailable: ${String(cause)}`, 1),
);

type Service = {
	name: string;
	entrypoint: string;
	env: Record<string, string>;
};
type Child = {
	name: string;
	subprocess: Bun.Subprocess<"ignore", "pipe", "inherit">;
	output: Promise<void>;
	spawnedAtMs: number;
	exitedAtMs: number | undefined;
	// Set once the load test stops it; an exit before is a failure.
	stopping: boolean;
};
const children: Child[] = [];
const { promise: childFailed, resolve: markChildFailed } =
	Promise.withResolvers<string>();

function spawn(service: Service, onLine: (line: string) => void = () => {}) {
	// #232 experiment, not merged: CPU profile of dispatch, written on its
	// process.exit after SIGTERM.
	const profile =
		service.name === "dispatch"
			? ["--cpu-prof", "--cpu-prof-dir", "out/profiles"]
			: [];
	const subprocess = Bun.spawn(["bun", ...profile, service.entrypoint], {
		env: { ...runEnv, ...service.env },
		stdout: "pipe",
		stderr: "inherit",
	});
	const child: Child = {
		name: service.name,
		subprocess,
		output: forwardLines(subprocess.stdout, `[${service.name}] `, onLine),
		spawnedAtMs: performance.now(),
		exitedAtMs: undefined,
		stopping: false,
	};
	children.push(child);
	void subprocess.exited.then((code) => {
		child.exitedAtMs = performance.now();
		if (!child.stopping) markChildFailed(`${service.name} exited (${code})`);
	});
	return child;
}

async function stopChildren(names: (name: string) => boolean): Promise<void> {
	const stopped = children.filter((child) => names(child.name));
	for (const child of stopped) {
		child.stopping = true;
		child.subprocess.kill("SIGTERM");
	}
	await Promise.all(
		stopped.map(async (child) => {
			await child.subprocess.exited;
			await child.output;
		}),
	);
}

async function abort(reason: string): Promise<never> {
	console.error(`[loadtest] ${reason}, stopping`);
	await stopChildren(() => true);
	process.exit(1);
}
process.on("SIGINT", () => void abort("interrupted"));
process.on("SIGTERM", () => void abort("terminated"));
void childFailed.then(abort);

const ServiceStarted = z.object({ type: z.literal("service_started") });
const { promise: persisterReady, resolve: markReady } =
	Promise.withResolvers<"ready">();
spawn(
	{ name: "persister", entrypoint: "src/persister/main.ts", env: {} },
	(line) => {
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch (error) {
			// Not a JSON log entry (e.g. a stack trace line).
			if (error instanceof SyntaxError) return;
			throw error;
		}
		if (ServiceStarted.safeParse(entry).success) markReady("ready");
	},
);
const persisterStart = await Promise.race([
	persisterReady,
	Bun.sleep(persisterReadyTimeoutMs).then(() => "timed_out" as const),
]);
if (persisterStart !== "ready") {
	await abort(`persister not ready after ${persisterReadyTimeoutMs} ms`);
}
// The stream exists now; an empty backlog makes pending this run's alone.
await jsm.streams
	.purge(simEvents.stream)
	.catch((cause: unknown) => abort(`purge failed: ${String(cause)}`));

const clockSubject = subjectFor({ type: "clock.ticked", tick: Tick.parse(0) });
// Only the tick: a full message parse would make the observer the slowest
// subscriber.
const TickOnly = z.object({ tick: Tick });
const settle = createSettleTracker(ticks);
let undecodable = 0;
const { promise: lastTickObserved, resolve: markLastTick } =
	Promise.withResolvers<number>();
const subscription = observer.subscribe(simEventSubjects);
await observer.flush();
const observing = (async () => {
	for await (const message of subscription) {
		const atMs = performance.now();
		let payload: unknown;
		try {
			payload = message.json();
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			undecodable++;
			continue;
		}
		const decoded = TickOnly.safeParse(payload);
		if (!decoded.success) {
			undecodable++;
			continue;
		}
		const { tick } = decoded.data;
		if (message.subject !== clockSubject) {
			settle.eventReceived(tick, atMs, message.subject, message.data.length);
			continue;
		}
		settle.clockTicked(tick, atMs, message.data.length);
		if (tick === ticks) markLastTick(atMs);
	}
})();

const services: Service[] = [
	{ name: "dispatch", entrypoint: "src/dispatch/main.ts", env: {} },
	{ name: "riders", entrypoint: "src/rider/main.ts", env: {} },
	...Array.from({ length: driverShards.count }, (_, shard) => ({
		name: `driver-shard-${shard}`,
		entrypoint: "src/driver/main.ts",
		env: { SHARD_INDEX: String(shard) },
	})),
	// Last, though its start delay is what keeps tick 1 after the others
	// subscribe.
	{ name: "clock", entrypoint: "src/clock/main.ts", env: {} },
];
for (const service of services) spawn(service);

const persisterSamples: PersisterSample[] = [];
const pendingBytes = { observerMax: 0, anyMax: 0 };
let running = true;
// Ends the sampler's wait between samples at once, so stopping it doesn't
// delay the drain wait (and inflate drain time) by up to an interval.
const { promise: samplingStopped, resolve: stopSampling } =
	Promise.withResolvers<void>();
const sampling = (async () => {
	while (running) {
		const consumer = await jsm.consumers
			.info(simEvents.stream, simEvents.consumer)
			.catch((cause: unknown) => {
				console.error(`[loadtest] consumer info failed: ${String(cause)}`);
				return undefined;
			});
		if (consumer !== undefined) {
			persisterSamples.push({
				pending: consumer.num_pending,
				ackPending: consumer.num_ack_pending,
			});
			// With the persister sample only, so the report lines them up.
			const reading = await infra.read();
			if (!reading.ok) {
				await abort(`infra read failed: ${JSON.stringify(reading.error)}`);
			} else {
				infraReadings.push(reading.value);
			}
		}
		const bytes = await readPendingBytes(natsMonitoringUrl, observerName);
		if (bytes.ok) {
			pendingBytes.observerMax = Math.max(
				pendingBytes.observerMax,
				bytes.value.named,
			);
			pendingBytes.anyMax = Math.max(pendingBytes.anyMax, bytes.value.anyMax);
		} else {
			console.error(`[loadtest] ${JSON.stringify(bytes.error)}`);
		}
		await Promise.race([Bun.sleep(sampleIntervalMs), samplingStopped]);
	}
})();

const lastTickAtMs = await lastTickObserved;
running = false;
stopSampling();
// The clock has no tick limit of its own.
await stopChildren((name) => name === "clock");
await Bun.sleep(settleGraceMs);
subscription.unsubscribe();
await observing;
await sampling;
await stopChildren((name) => name !== "persister");

let drain: LoadtestMeasurement["drain"];
for (;;) {
	const consumer = await jsm.consumers
		.info(simEvents.stream, simEvents.consumer)
		.catch((cause: unknown) => abort(`consumer info failed: ${String(cause)}`));
	const pending = consumer.num_pending + consumer.num_ack_pending;
	const elapsedMs = performance.now() - lastTickAtMs;
	if (pending === 0) {
		drain = { type: "drained", ms: elapsedMs };
		break;
	}
	if (elapsedMs >= drainBoundMs) {
		drain = { type: "did_not_drain", pending };
		break;
	}
	await Bun.sleep(drainPollMs);
}
await stopChildren(() => true);
infraReadings.push(orFail(await infra.read()));
await infra.close();
// Documented in microseconds (nodejs.org/api/process.html#processcpuusagepreviousvalue).
const loadtestCpu = process.cpuUsage();
const slowConsumersAfter = orFail(await readSlowConsumers(natsMonitoringUrl));
await observer.drain();

if (undecodable > 0) {
	console.error(`[loadtest] ${undecodable} undecodable events ignored`);
}
const [load1 = 0, load5 = 0, load15 = 0] = loadavg();
console.log(
	loadtestReport(args.value, {
		settle: settle.summary(),
		persisterSamples,
		sampleIntervalMs,
		settleGraceMs,
		drain,
		slowConsumers: slowConsumersAfter - slowConsumersBefore,
		pendingBytes,
		host: {
			cpus: cpus().length,
			cpuModel: cpus()[0]?.model ?? "unknown",
			loadAverage: [load1, load5, load15],
		},
		peakRssBytes: children.map((child) => ({
			service: child.name,
			// Documented in bytes (bun.com/docs/runtime/child-process).
			bytes: child.subprocess.resourceUsage()?.maxRSS ?? 0,
		})),
		infraReadings,
		loadtestCpu: {
			userMicros: loadtestCpu.user,
			systemMicros: loadtestCpu.system,
		},
		cpuTime: children.map((child) => {
			// Documented in microseconds (bun.com/docs/runtime/child-process).
			// Typed number, but bigint at runtime in Bun 1.4.2 (checked on Linux
			// and macOS): Number() works for both.
			const usage = child.subprocess.resourceUsage()?.cpuTime;
			return {
				service: child.name,
				userMicros: Number(usage?.user ?? 0),
				systemMicros: Number(usage?.system ?? 0),
				// Every child has exited by now (stopChildren above).
				wallMs: (child.exitedAtMs ?? performance.now()) - child.spawnedAtMs,
			};
		}),
	}),
);
process.exit(0);

function fail(message: string, code: number): never {
	console.error(message);
	process.exit(code);
}

function orFail<T>(
	result: { ok: true; value: T } | { ok: false; error: unknown },
): T {
	if (result.ok) return result.value;
	fail(JSON.stringify(result.error), 1);
}

async function forwardLines(
	stream: ReadableStream<Uint8Array>,
	prefix: string,
	onLine: (line: string) => void,
): Promise<void> {
	const decoder = new TextDecoder();
	let partial = "";
	for await (const chunk of stream) {
		const lines = (partial + decoder.decode(chunk, { stream: true })).split(
			"\n",
		);
		partial = lines.pop() ?? "";
		for (const line of lines) {
			process.stderr.write(`${prefix}${line}\n`);
			onLine(line);
		}
	}
	if (partial !== "") {
		process.stderr.write(`${prefix}${partial}\n`);
		onLine(partial);
	}
}
