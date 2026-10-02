// Headless CLI: one seeded in-process run, summary on stdout.
// Exit codes: 0 ok, 1 invariant violated, 2 invalid args.
import { parseArgs } from "node:util";
import * as z from "zod";
import { runInProcess } from "./run.ts";
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
});

function readArgs(): ReturnType<typeof parseArgs>["values"] {
	try {
		return parseArgs({
			args: Bun.argv.slice(2),
			options: {
				seed: { type: "string", default: "1" },
				// 1 simulated hour.
				ticks: { type: "string", default: "3600" },
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

// Spec defaults (docs/spec.md): 500 x 500 grid, 2 shards x 50 drivers,
// 10 trip requests/min.
const config = {
	...args.data,
	grid: { width: 500, height: 500 },
	driverShards: { count: 2, driversPerShard: 50 },
	requestsPerMinute: 10,
};
const summary = summarize(config, runInProcess(config));

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
