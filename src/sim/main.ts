// Headless CLI: one seeded run, in process or over NATS, summary on stdout;
// or --compare: greedy and batched matching in process on the same seed,
// side by side (ADR 0030).
// Exit codes: 0 ok, 1 invariant violated, 2 invalid args or NATS_URL,
// 3 NATS unreachable.
import { parseArgs } from "node:util";
import * as z from "zod";
import type { Matching } from "../dispatch/brain.ts";
import { specGrid } from "../shared/grid.ts";
import {
	type RunConfig,
	type RunResult,
	runInProcess,
	runOverNats,
} from "./run.ts";
import { compareSummaries, type Summary, summarize } from "./summary.ts";

const integerArg = z
	.string()
	.regex(z.regexes.integer, { error: "expected an integer" })
	.transform(Number);

const Args = z
	.strictObject({
		// createRandom folds the seed to 32 bits; larger seeds would alias.
		seed: integerArg.pipe(
			z
				.int()
				.min(0)
				.max(2 ** 32 - 1),
		),
		ticks: integerArg.pipe(z.int().positive()),
		bus: z.enum(["in-memory", "nats"]),
		matching: z.enum(["greedy", "batched"]),
		"batch-window": integerArg.pipe(z.int().positive()),
		compare: z.boolean(),
	})
	.refine((args) => !(args.compare && args.bus === "nats"), {
		error: "--compare runs in process only",
		path: ["compare"],
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
				matching: { type: "string", default: "greedy" },
				// Batched only.
				"batch-window": { type: "string", default: "5" },
				compare: { type: "boolean", default: false },
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
const { bus, compare, "batch-window": windowTicks, ...runArgs } = args.data;
const config = {
	seed: runArgs.seed,
	ticks: runArgs.ticks,
	grid: specGrid,
	driverShards: { count: 2, driversPerShard: 50 },
	requestsPerMinute: 10,
};
const batched: Matching = { type: "batched", windowTicks };

if (compare) {
	const greedySummary = summarize(
		config,
		runInProcess({ ...config, matching: { type: "greedy" } }),
	);
	const batchedSummary = summarize(
		config,
		runInProcess({ ...config, matching: batched }),
	);
	console.log(`seed: ${config.seed}`);
	console.log(`ticks: ${config.ticks}`);
	console.log(`batch window: ${windowTicks} ticks`);
	printComparison(greedySummary, batchedSummary);
	printViolations("greedy", greedySummary);
	printViolations("batched", batchedSummary);
} else {
	const matching: Matching =
		runArgs.matching === "batched" ? batched : { type: "greedy" };
	const summary = summarize(config, await run({ ...config, matching }));

	console.log(`seed: ${summary.seed}`);
	console.log(`ticks: ${summary.ticks}`);
	console.log(
		`matching: ${matching.type === "batched" ? `batched (window ${windowTicks} ticks)` : "greedy"}`,
	);
	console.log(`drivers: ${summary.drivers}`);
	console.log(`trips requested: ${summary.trips.requested}`);
	console.log(`trips completed: ${summary.trips.completed}`);
	console.log(`trips cancelled: ${summary.trips.cancelled}`);
	console.log(
		`mean ticks from request to pickup: ${summary.meanTicksToPickup?.toFixed(1) ?? "n/a"}`,
	);
	console.log(`rejected inputs: ${summary.rejectedInputs}`);
	console.log(`invariant violations: ${summary.violations.length}`);
	printViolations(null, summary);
}

function printComparison(greedy: Summary, batched: Summary): void {
	const rows = [
		{ metric: "", greedy: "greedy", batched: "batched" },
		...compareSummaries(greedy, batched),
	];
	const width = (column: "metric" | "greedy" | "batched") =>
		Math.max(...rows.map((row) => row[column].length));
	for (const row of rows) {
		console.log(
			`${row.metric.padEnd(width("metric"))}  ${row.greedy.padStart(width("greedy"))}  ${row.batched.padStart(width("batched"))}`,
		);
	}
}

// Any violation fails the command.
function printViolations(strategy: string | null, summary: Summary): void {
	for (const violation of summary.violations) {
		console.log(
			JSON.stringify(strategy ? { strategy, ...violation } : violation),
		);
	}
	if (summary.violations.length > 0) process.exitCode = 1;
}

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
	// Key for this run's persisted events (ADR 0029).
	console.log(`run id: ${result.value.runId}`);
	return result.value;
}
