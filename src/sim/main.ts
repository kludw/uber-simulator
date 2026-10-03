// Headless CLI: one seeded run, in process or over NATS, summary on stdout;
// or --compare: greedy and batched matching in process on the same seed,
// side by side (ADR 0030).
// Exit codes: 0 ok, 1 invariant violated, 2 invalid args or NATS_URL,
// 3 NATS unreachable.
import * as z from "zod";
import type { Matching } from "../dispatch/brain.ts";
import { parseSimArgs } from "./args.ts";
import { type RunConfig, runInProcess, runOverNats } from "./run.ts";
import {
	compareSummaries,
	createSummary,
	type Summary,
	summarize,
} from "./summary.ts";

const args = parseSimArgs(Bun.argv.slice(2));
if (!args.ok) {
	console.error(args.error.message);
	process.exit(2);
}

const { bus, compare, windowTicks, demandName, shiftsName, config } =
	args.value;
const { count, driversPerShard } = config.driverShards;
const loadLines = [
	`demand: ${demandName}`,
	`requests per minute: ${config.requestsPerMinute}`,
	`driver shards: ${count} x ${driversPerShard}`,
	`shifts: ${shiftsName}`,
];
const batched: Matching = { type: "batched", windowTicks };

if (compare) {
	const greedySummary = summarizeInProcess({
		...config,
		matching: { type: "greedy" },
	});
	const batchedSummary = summarizeInProcess({ ...config, matching: batched });
	console.log(`seed: ${config.seed}`);
	console.log(`ticks: ${config.ticks}`);
	console.log(`batch window: ${windowTicks} ticks`);
	for (const line of loadLines) console.log(line);
	printComparison(greedySummary, batchedSummary);
	printAndFailOnViolations("greedy", greedySummary);
	printAndFailOnViolations("batched", batchedSummary);
} else {
	const matching: Matching =
		args.value.matching === "batched" ? batched : { type: "greedy" };
	const summary = await run({ ...config, matching });

	console.log(`seed: ${summary.seed}`);
	console.log(`ticks: ${summary.ticks}`);
	console.log(
		`matching: ${matching.type === "batched" ? `batched (window ${windowTicks} ticks)` : "greedy"}`,
	);
	for (const line of loadLines) console.log(line);
	console.log(`drivers: ${summary.drivers}`);
	console.log(`trips requested: ${summary.trips.requested}`);
	console.log(`trips completed: ${summary.trips.completed}`);
	console.log(`trips cancelled: ${summary.trips.cancelled}`);
	console.log(
		`mean ticks from request to pickup: ${summary.meanTicksToPickup?.toFixed(1) ?? "n/a"}`,
	);
	console.log(`rejected inputs: ${summary.rejectedInputs}`);
	console.log(`invariant violations: ${summary.violations.length}`);
	printAndFailOnViolations(null, summary);
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

// Prints each violation and fails the command (exit code 1) if any.
function printAndFailOnViolations(
	strategy: string | null,
	summary: Summary,
): void {
	for (const violation of summary.violations) {
		console.log(
			JSON.stringify(strategy ? { strategy, ...violation } : violation),
		);
	}
	if (summary.violations.length > 0) process.exitCode = 1;
}

// Summarized as the run happens, so no event log is kept (ADR 0033).
function summarizeInProcess(config: RunConfig): Summary {
	const summary = createSummary(config);
	const { rejected } = runInProcess(config, { onMessage: summary.observe });
	return summary.result(rejected.length);
}

async function run(config: RunConfig): Promise<Summary> {
	if (bus === "in-memory") return summarizeInProcess(config);
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
	return summarize(config, result.value);
}
