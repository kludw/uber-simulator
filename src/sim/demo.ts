// `bun run demo` (ADR 0053): local infra, then the `bun run dev` stack and
// the UI server together, on the demo's defaults (`demoEnv`). SIGINT/SIGTERM
// stops both; so does either exiting on its own (exit code 1 then). Infra
// keeps running, as after `bun run dev`: `docker compose down` stops it.
import { demoEnv } from "./launch.ts";

const compose = Bun.spawn(["docker", "compose", "up", "-d", "--wait"], {
	stdout: "inherit",
	stderr: "inherit",
});
if ((await compose.exited) !== 0) {
	console.error("[demo] docker compose up failed, stopping");
	process.exit(1);
}

const env = demoEnv(Bun.env);
const children = [
	{ name: "dev", entrypoint: "src/sim/dev.ts" },
	{ name: "ui", entrypoint: "src/ui/serve.ts" },
].map(({ name, entrypoint }) => ({
	name,
	child: Bun.spawn(["bun", entrypoint], {
		env,
		stdout: "inherit",
		stderr: "inherit",
	}),
}));

let stopping = false;
function stopAll(): void {
	stopping = true;
	for (const { child } of children) child.kill("SIGTERM");
}
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

console.log(`[demo] UI: http://localhost:${env.UI_PORT}/`);

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
process.exit(exitCode);
