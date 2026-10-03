// Headless CLI: one seeded run, in process or over NATS, summary on stdout.
// Exit codes: 0 ok, 1 invariant violated, 2 invalid args or NATS_URL,
// 3 NATS unreachable.
import { parseArgs } from "node:util";
import * as z from "zod";
import { specGrid } from "../shared/grid.ts";
import {
	type RunConfig,
	type RunResult,
	runInProcess,
	runOverNats,
} from "./run.ts";
import { summarize } from "./summary.ts";

const integerArg = z
	.string()
	.regex(z.regexes.integer, { error: "expected an integer" })
	.transform(Number);

const Args = z.strictObject({
	// createRandom folds the seed to 32 bits; larger seeds would alias.
	seed: integerArg.pipe(
		z
			.int()
			.min(0)
			.max(2 ** 32 - 1),
	),
	ticks: integerArg.pipe(z.int().positive()),
	bus: z.enum(["in-memory", "nats"]),
});

function readArgs(): ReturnType<typeof parseArgs>["values"] {
	try {
		return parseArgs({
			args: Bun.argv.slice(2),
			options: {
				seed: { type: "string", default: "1" },
				// 1 simulated hour.
				ticks: { type: "string", default: "3600" },
				bus: { type: "string", default: "in-memory" },
			},
			strict: true,
		}).values;
	} catch (error) {
		// parseArgs throws TypeError only for malformed argv.
		if (!(error instanceof TypeError)) throw error;
		console.error(error.message);
		process.exit(2);
	}
}

const args = Args.safeParse(readArgs());
if (!args.success) {
	console.error(z.prettifyError(args.error));
	process.exit(2);
}

// Spec defaults (docs/spec.md): spec grid, 2 shards x 50 drivers,
// 10 trip requests/min.
const { bus, ...runArgs } = args.data;
const config = {
	...runArgs,
	grid: specGrid,
	driverShards: { count: 2, driversPerShard: 50 },
	requestsPerMinute: 10,
};
const summary = summarize(config, await run(config));

console.log(`seed: ${summary.seed}`);
console.log(`ticks: ${summary.ticks}`);
console.log(`drivers: ${summary.drivers}`);
console.log(`trips requested: ${summary.trips.requested}`);
console.log(`trips completed: ${summary.trips.completed}`);
console.log(`trips cancelled: ${summary.trips.cancelled}`);
console.log(
	`mean ticks from request to pickup: ${summary.meanTicksToPickup?.toFixed(1) ?? "n/a"}`,
);
console.log(`rejected inputs: ${summary.rejectedInputs}`);
console.log(`invariant violations: ${summary.violations.length}`);
for (const violation of summary.violations) {
	console.log(JSON.stringify(violation));
}
if (summary.violations.length > 0) process.exitCode = 1;

async function run(config: RunConfig): Promise<RunResult> {
	if (bus === "in-memory") return runInProcess(config);
	const url = z.url().safeParse(Bun.env.NATS_URL);
	if (!url.success) {
		console.error(`NATS_URL: ${z.prettifyError(url.error)}`);
		process.exit(2);
	}
	const result = await runOverNats({ ...config, url: url.data });
	if (!result.ok) {
		console.error(
			`cannot connect to NATS at ${url.data}: ${String(result.error.cause)}`,
		);
		process.exit(3);
	}
	return result.value;
}
