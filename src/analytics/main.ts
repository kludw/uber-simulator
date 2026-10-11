// `bun run report`: per-run analytics from ClickHouse (ADR 0029).
// `--list` lists stored runs, `--run <id>` reports one. Exit codes: 0 ok,
// 1 unknown run, 2 invalid args or config, 3 ClickHouse unreachable or a
// query failed.
import { parseArgs } from "node:util";
import * as z from "zod";
import { connectClickHouse } from "../persistence/clickhouse.ts";
import { RunId } from "../shared/messages.ts";
import { dollars } from "../shared/surge.ts";
import { parseClickHouseConfig } from "../sim/config.ts";
import { log, orExit } from "../sim/process.ts";
import {
	listRuns,
	type RunReport,
	reportExitCode,
	runReport,
} from "./report.ts";

const service = "report";

// Exactly one of the two.
const Args = z.union([
	z.strictObject({ list: z.literal(true) }),
	z.strictObject({ run: RunId }),
]);

function readArgs(): ReturnType<typeof parseArgs>["values"] {
	try {
		return parseArgs({
			args: Bun.argv.slice(2),
			options: { list: { type: "boolean" }, run: { type: "string" } },
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
	console.error("usage: bun run report -- --list | --run <run id>");
	process.exit(2);
}
const config = orExit(service, parseClickHouseConfig(Bun.env));
const connected = await connectClickHouse(config);
if (!connected.ok) {
	log(service, connected.error);
	process.exit(reportExitCode(connected.error));
}
const clickhouse = connected.value;
process.exitCode =
	"list" in args.data ? await printRuns() : await printReport(args.data.run);
await clickhouse.close();

async function printRuns(): Promise<number> {
	const runs = await listRuns(clickhouse);
	if (!runs.ok) {
		log(service, runs.error);
		return reportExitCode(runs.error);
	}
	if (runs.value.length === 0) console.log("no runs stored");
	for (const run of runs.value) {
		console.log(
			`${run.runId}  ticks ${run.firstTick}-${run.lastTick}  ${run.events} events`,
		);
	}
	return 0;
}

async function printReport(runId: RunId): Promise<number> {
	const report = await runReport(clickhouse, runId);
	if (!report.ok) {
		if (report.error.type === "unknown_run") {
			console.error(
				`unknown run id: ${runId} (bun run report -- --list shows stored runs)`,
			);
		} else {
			log(service, report.error);
		}
		return reportExitCode(report.error);
	}
	print(runId, report.value);
	return 0;
}

function print(runId: RunId, report: RunReport): void {
	console.log(`run id: ${runId}`);
	console.log(`trips requested: ${report.trips.requested}`);
	// Surge runs only (ADR 0054): surge-off runs print as before.
	if (report.surge) console.log(`riders declined: ${report.surge.declined}`);
	// Pooling runs only (ADR 0056): pooling-off runs print as before.
	if (report.pooled > 0) console.log(`trips pooled: ${report.pooled}`);
	console.log(`trips completed: ${report.trips.completed}`);
	console.log(`trips cancelled: ${report.trips.cancelled}`);
	console.log(
		`mean ticks from request to pickup: ${decimal(report.meanTicksToPickup)}`,
	);
	console.log(
		`mean ticks from pickup to completion: ${decimal(report.meanTripTicks)}`,
	);
	console.log(
		`completed trips per simulated minute: ${decimal(report.completedPerMinute)}`,
	);
	if (report.surge) console.log(`revenue: ${dollars(report.surge.revenue)}`);
}

function decimal(value: number | null): string {
	return value?.toFixed(1) ?? "n/a";
}
