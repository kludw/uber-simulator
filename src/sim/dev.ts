// `bun run dev`: every service as its own process (ADR 0019), output
// prefixed by service. SIGINT/SIGTERM stops them all; so does any one
// exiting on its own (exit code 1 then). One run id per start, given to
// every service (ADR 0029); it replaces any RUN_ID in the environment.
import { parseServiceConfig } from "./config.ts";

const runEnv = { ...Bun.env, RUN_ID: crypto.randomUUID() };
const config = parseServiceConfig(runEnv);
if (!config.ok) {
	console.error(JSON.stringify(config.error));
	process.exit(2);
}
console.log(`[dev] run id: ${config.value.runId}`);

const services = [
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
const nameWidth = Math.max(...services.map((service) => service.name.length));

const children = services.map((service) => {
	const child = Bun.spawn(["bun", service.entrypoint], {
		env: { ...runEnv, ...service.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const prefix = `[${service.name.padEnd(nameWidth)}] `;
	const output = Promise.all([
		prefixLines(child.stdout, prefix, process.stdout),
		prefixLines(child.stderr, prefix, process.stderr),
	]);
	return { name: service.name, child, output };
});

let stopping = false;
function stopAll(): void {
	stopping = true;
	for (const { child } of children) child.kill("SIGTERM");
}
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

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
): Promise<void> {
	const decoder = new TextDecoder();
	let partial = "";
	for await (const chunk of stream) {
		const lines = (partial + decoder.decode(chunk, { stream: true })).split(
			"\n",
		);
		partial = lines.pop() ?? "";
		for (const line of lines) sink.write(`${prefix}${line}\n`);
	}
	if (partial !== "") sink.write(`${prefix}${partial}\n`);
}
