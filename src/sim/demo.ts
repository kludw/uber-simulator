// `bun run demo` (ADR 0053): local infra, then the `bun run dev` stack and
// the UI server together, on the demo's defaults (`demoEnv`). Prints the UI
// URL once the UI listens. SIGINT/SIGTERM stops both; so does either exiting
// on its own (exit code 1 then). Infra keeps running, as after `bun run dev`:
// `docker compose down` stops it.
import * as z from "zod";
import { demoEnv, uiStartedUrl } from "./launch.ts";

// Bun.spawn's error when the executable isn't on PATH.
const NotFound = z.object({ code: z.literal("ENOENT") });

let compose: Bun.Subprocess;
try {
	compose = Bun.spawn(["docker", "compose", "up", "-d", "--wait"], {
		stdout: "inherit",
		stderr: "inherit",
	});
} catch (error) {
	if (!NotFound.safeParse(error).success) throw error;
	console.error("[demo] docker not found, stopping");
	process.exit(1);
}
if ((await compose.exited) !== 0) {
	console.error("[demo] docker compose up failed, stopping");
	process.exit(1);
}

const env = demoEnv(Bun.env);
const dev = Bun.spawn(["bun", "src/sim/dev.ts"], {
	env,
	stdout: "inherit",
	stderr: "inherit",
});
const ui = Bun.spawn(["bun", "src/ui/serve.ts"], {
	env,
	stdout: "pipe",
	stderr: "inherit",
});
const children = [
	{ name: "dev", child: dev },
	{ name: "ui", child: ui },
];

let stopping = false;
function stopAll(): void {
	stopping = true;
	for (const { child } of children) child.kill("SIGTERM");
}
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

// Passes the UI's output through, line by line, adding the URL after its
// started line.
async function forwardUiOutput(): Promise<void> {
	const decoder = new TextDecoder();
	let partial = "";
	for await (const chunk of ui.stdout) {
		const lines = (partial + decoder.decode(chunk, { stream: true })).split(
			"\n",
		);
		partial = lines.pop() ?? "";
		for (const line of lines) {
			process.stdout.write(`${line}\n`);
			const url = uiStartedUrl(line);
			if (url !== null) console.log(`[demo] UI: ${url}`);
		}
	}
	if (partial !== "") process.stdout.write(`${partial}\n`);
}
const uiOutput = forwardUiOutput();

let exitCode = 0;
await Promise.all(
	children.map(async ({ name, child }) => {
		const code = await child.exited;
		if (stopping) return;
		console.error(`[demo] ${name} exited (${code}), stopping all`);
		exitCode = 1;
		stopAll();
	}),
);
await uiOutput;
process.exit(exitCode);
