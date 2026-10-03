// Benchmark: one in-process run at a given fleet size, demand scaled with it,
// reporting wall time per tick and memory on stdout. Profiles come from Bun's
// own flags (README). Exit codes: 0 ok, 2 invalid args, 3 stopped at
// --max-minutes (partial report printed).
import { heapStats } from "bun:jsc";
import { type RunResult, runInProcess } from "../sim/run.ts";
import { parseBenchArgs } from "./args.ts";
import { type BenchMeasurement, benchReport } from "./report.ts";

const args = parseBenchArgs(Bun.argv.slice(2));
if (!args.ok) {
	console.error(args.error.message);
	process.exit(2);
}
const { config, maxMinutes } = args.value;

const tickMs: number[] = [];
const runStart = performance.now();
// Tick 1 also includes starting the services.
let tickStart = runStart;
const result = runInProcess(config, (_tick, soFar) => {
	const now = performance.now();
	tickMs.push(now - tickStart);
	tickStart = now;
	// The run is one synchronous loop, so a signal handler (e.g. for
	// `timeout`'s SIGTERM) would only run once it ends. The limit is checked
	// here instead, between ticks: one slow tick can overshoot it by its own
	// length. process.exit (not a signal) lets Bun write --cpu-prof profiles.
	if (maxMinutes === undefined || now - runStart < maxMinutes * 60_000) return;
	print(soFar, { type: "did_not_finish", maxMinutes });
	process.exit(3);
});
print(result, { type: "finished" });

function print(soFar: RunResult, status: BenchMeasurement["status"]): void {
	const heap = heapStats();
	console.log(
		benchReport(config, {
			tickMs,
			messages: soFar.eventLog.length,
			// maxRSS is in kilobytes.
			peakRssBytes: process.resourceUsage().maxRSS * 1024,
			heapBytes: heap.heapSize,
			heapObjects: heap.objectCount,
			status,
		}),
	);
}
