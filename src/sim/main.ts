// Headless CLI: one seeded run, in process or over NATS, summary on stdout;
// or --compare: greedy and batched matching in process on the same seed,
// side by side (ADR 0030); or --compare-surge: the configured matching with
// surge off and on, likewise (ADR 0054).
// Exit codes: 0 ok, 1 invariant violated, 2 invalid args or NATS_URL,
// 3 NATS unreachable.
import * as z from "zod";
import type { Matching } from "../dispatch/brain.ts";
import { oneRegion } from "../shared/regions.ts";
import { dollars } from "../shared/surge.ts";
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

const {
	bus,
	compare,
	compareSurge,
	windowTicks,
	demandName,
	shiftsName,
	preferencesName,
	config,
} = args.value;
const { count, driversPerShard } = config.driverShards;
const regions = config.regions ?? oneRegion;
const loadLines = [
	`demand: ${demandName}`,
	`requests per minute: ${config.requestsPerMinute}`,
	`driver shards: ${count} x ${driversPerShard}`,
	`shifts: ${shiftsName}`,
	`preferences: ${preferencesName}`,
	`regions: ${regions.columns}x${regions.rows}`,
	// Surge-off output stays as before surge existed (ADR 0054).
	...(config.surge && !compareSurge ? ["surge: on"] : []),
];
const batched: Matching = { type: "batched", windowTicks };
const matching: Matching =
	args.value.matching === "batched" ? batched : { type: "greedy" };
const matchingLine = `matching: ${matching.type === "batched" ? `batched (window ${windowTicks} ticks)` : "greedy"}`;

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
	printComparison(["greedy", "batched"], greedySummary, batchedSummary, {
		surge: config.surge ?? false,
	});
	printAndFailOnViolations("greedy", greedySummary);
	printAndFailOnViolations("batched", batchedSummary);
} else if (compareSurge) {
	const offSummary = summarizeInProcess({ ...config, matching, surge: false });
	const onSummary = summarizeInProcess({ ...config, matching, surge: true });
	console.log(`seed: ${config.seed}`);
	console.log(`ticks: ${config.ticks}`);
	console.log(matchingLine);
	for (const line of loadLines) console.log(line);
	printComparison(["surge off", "surge on"], offSummary, onSummary, {
		surge: true,
	});
	printAndFailOnViolations("surge off", offSummary);
	printAndFailOnViolations("surge on", onSummary);
} else {
	const summary = await run({ ...config, matching });

	console.log(`seed: ${summary.seed}`);
	console.log(`ticks: ${summary.ticks}`);
	console.log(matchingLine);
	for (const line of loadLines) console.log(line);
	console.log(`drivers: ${summary.drivers}`);
	console.log(`trips requested: ${summary.trips.requested}`);
	if (config.surge) console.log(`riders declined: ${summary.declined}`);
	console.log(`trips completed: ${summary.trips.completed}`);
	console.log(`trips cancelled: ${summary.trips.cancelled}`);
	console.log(
		`mean ticks from request to pickup: ${summary.meanTicksToPickup?.toFixed(1) ?? "n/a"}`,
	);
	if (config.surge) console.log(`revenue: ${dollars(summary.revenue)}`);
	console.log(`rejected inputs: ${summary.rejectedInputs}`);
	console.log(`invariant violations: ${summary.violations.length}`);
	printAndFailOnViolations(null, summary);
}

function printComparison(
	[firstName, secondName]: [string, string],
	first: Summary,
	second: Summary,
	options: { surge: boolean },
): void {
	const rows = [
		{ metric: "", first: firstName, second: secondName },
		...compareSummaries(first, second, options),
	];
	const width = (column: "metric" | "first" | "second") =>
		Math.max(...rows.map((row) => row[column].length));
	for (const row of rows) {
		console.log(
			`${row.metric.padEnd(width("metric"))}  ${row.first.padStart(width("first"))}  ${row.second.padStart(width("second"))}`,
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
