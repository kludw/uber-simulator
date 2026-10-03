// Benchmark: one in-process run at a given fleet size, demand scaled with it,
// reporting wall time per tick and memory on stdout. Profiles come from Bun's
// own flags (README). Exit codes: 0 ok, 2 invalid args.
import { heapStats } from "bun:jsc";
import { runInProcess } from "../sim/run.ts";
import { parseBenchArgs } from "./args.ts";
import { benchReport } from "./report.ts";

const config = parseBenchArgs(Bun.argv.slice(2));
if (!config.ok) {
	console.error(config.error.message);
	process.exit(2);
}

const tickMs: number[] = [];
// Tick 1 also includes starting the services.
let tickStart = performance.now();
const { eventLog } = runInProcess(config.value, () => {
	const now = performance.now();
	tickMs.push(now - tickStart);
	tickStart = now;
});
const heap = heapStats();

console.log(
	benchReport(config.value, {
		tickMs,
		messages: eventLog.length,
		// maxRSS is in kilobytes.
		peakRssBytes: process.resourceUsage().maxRSS * 1024,
		heapBytes: heap.heapSize,
		heapObjects: heap.objectCount,
	}),
);
