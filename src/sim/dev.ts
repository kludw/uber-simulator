// `bun run dev`: every service as its own process (ADR 0019), output
// prefixed by service. SIGINT/SIGTERM stops them all; so does any one
// exiting on its own (exit code 1 then). One run id per start, given to
// every service (ADR 0029); it replaces any RUN_ID in the environment.
// The persister starts first and alone: the others start once it logs
// service_started, i.e. its stream exists. Driver shards publish
// drivers.went_online as they start, so on a fresh NATS volume an earlier
// start would lose those events. Not ready within 30 s: stop, exit 1.
import * as z from "zod";
import { parseServiceConfig } from "./config.ts";

const persisterReadyTimeoutMs = 30_000;

const runEnv = { ...Bun.env, RUN_ID: crypto.randomUUID() };
const config = parseServiceConfig(runEnv);
if (!config.ok) {
	console.error(JSON.stringify(config.error));
	process.exit(2);
}
console.log(`[dev] run id: ${config.value.runId}`);

type Service = {
	name: string;
	entrypoint: string;
	env: Record<string, string>;
};

const persister: Service = {
	name: "persister",
	entrypoint: "src/persister/main.ts",
	env: {},
};
const others: Service[] = [
	{ name: "dispatch", entrypoint: "src/dispatch/main.ts", env: {} },
	{ name: "riders", entrypoint: "src/rider/main.ts", env: {} },
	...Array.from({ length: config.value.driverShards.count }, (_, shard) => ({
		name: `driver-shard-${shard}`,
		entrypoint: "src/driver/main.ts",
		env: { SHARD_INDEX: String(shard) },
	})),
	// Last, though its start delay is what keeps tick 1 after the others
	// subscribe.
	{ name: "clock", entrypoint: "src/clock/main.ts", env: {} },
];
const nameWidth = Math.max(
	...[persister, ...others].map((service) => service.name.length),
);

type Child = {
	name: string;
	child: Bun.Subprocess<"ignore", "pipe", "pipe">;
	output: Promise<unknown>;
};
const children: Child[] = [];

let stopping = false;
function stopAll(): void {
	stopping = true;
	for (const { child } of children) child.kill("SIGTERM");
}
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

function spawn(service: Service, onLine: (line: string) => void = () => {}) {
	const child = Bun.spawn(["bun", service.entrypoint], {
		env: { ...runEnv, ...service.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const prefix = `[${service.name.padEnd(nameWidth)}] `;
	const output = Promise.all([
		prefixLines(child.stdout, prefix, process.stdout, onLine),
		prefixLines(child.stderr, prefix, process.stderr),
	]);
	const spawned = { name: service.name, child, output };
	children.push(spawned);
	return spawned;
}

// The persister's log line once its stream and consumer exist.
const ServiceStarted = z.object({ type: z.literal("service_started") });
const { promise: persisterReady, resolve: markReady } =
	Promise.withResolvers<"ready">();
const persisterChild = spawn(persister, (line) => {
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch (error) {
		// Not a JSON log entry (e.g. a stack trace line).
		if (error instanceof SyntaxError) return;
		throw error;
	}
	if (ServiceStarted.safeParse(entry).success) markReady("ready");
});
const persisterStart = await Promise.race([
	persisterReady,
	persisterChild.child.exited.then(() => "exited" as const),
	Bun.sleep(persisterReadyTimeoutMs).then(() => "timed_out" as const),
]);
if (persisterStart !== "ready") {
	const signalled = stopping;
	if (!signalled) {
		console.error(
			persisterStart === "exited"
				? "[dev] persister exited before it was ready, stopping"
				: `[dev] persister not ready after ${persisterReadyTimeoutMs} ms, stopping`,
		);
	}
	stopAll();
	await persisterChild.child.exited;
	await persisterChild.output;
	process.exit(signalled ? 0 : 1);
}
if (!stopping) for (const service of others) spawn(service);

let exitCode = 0;
await Promise.all(
	children.map(async ({ name, child, output }) => {
		const code = await child.exited;
		await output;
		if (stopping) return;
		console.error(`[dev] ${name} exited (${code}), stopping all`);
		exitCode = 1;
		stopAll();
	}),
);
process.exit(exitCode);

async function prefixLines(
	stream: ReadableStream<Uint8Array>,
	prefix: string,
	sink: NodeJS.WriteStream,
	onLine: (line: string) => void = () => {},
): Promise<void> {
	const decoder = new TextDecoder();
	let partial = "";
	for await (const chunk of stream) {
		const lines = (partial + decoder.decode(chunk, { stream: true })).split(
			"\n",
		);
		partial = lines.pop() ?? "";
		for (const line of lines) {
			sink.write(`${prefix}${line}\n`);
			onLine(line);
		}
	}
	if (partial !== "") {
		sink.write(`${prefix}${partial}\n`);
		onLine(partial);
	}
}
