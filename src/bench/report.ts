import type { RunConfig } from "../sim/run.ts";

// What src/bench/main.ts measured over one run.
export type BenchMeasurement = {
	// Wall time of each tick, in tick order.
	tickMs: number[];
	messages: number;
	peakRssBytes: number;
	heapBytes: number;
	heapObjects: number;
};

export function benchReport(
	config: RunConfig,
	measurement: BenchMeasurement,
): string {
	const { count, driversPerShard } = config.driverShards;
	const matching = config.matching;
	return [
		`seed: ${config.seed}`,
		`ticks: ${config.ticks}`,
		`drivers: ${count * driversPerShard} (${count} shards x ${driversPerShard})`,
		`requests per minute: ${config.requestsPerMinute}`,
		`matching: ${matching?.type === "batched" ? `batched (window ${matching.windowTicks} ticks)` : "greedy"}`,
		`wall ms per tick: mean ${mean(measurement.tickMs).toFixed(2)}, p95 ${p95(measurement.tickMs).toFixed(2)}`,
		`total messages: ${measurement.messages}`,
		`peak rss: ${mebibytes(measurement.peakRssBytes)} MiB`,
		`heap at end: ${mebibytes(measurement.heapBytes)} MiB, ${measurement.heapObjects} objects`,
	].join("\n");
}

function mean(values: number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Nearest rank: the smallest value at or above 95% of all values.
function p95(values: number[]): number {
	const sorted = values.toSorted((a, b) => a - b);
	const value = sorted[Math.ceil(0.95 * sorted.length) - 1];
	if (value === undefined) throw new Error("p95 of no values");
	return value;
}

function mebibytes(bytes: number): string {
	return (bytes / 2 ** 20).toFixed(1);
}
