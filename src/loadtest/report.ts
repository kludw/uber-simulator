// The load test report (ADR 0037): what src/loadtest/main.ts measured over one
// run, and that run's verdict on each criterion for a supported fleet size.
import type { LoadtestArgs } from "./args.ts";
import type { SettleSummary } from "./settle.ts";
import { pendingTrend } from "./trend.ts";

export type LoadtestMeasurement = {
	settle: SettleSummary;
	// Persister consumer num_pending from the start to tick T, one sample per
	// sampleIntervalMs.
	persisterPending: number[];
	persisterAckPendingMax: number;
	sampleIntervalMs: number;
	// How long after tick T the observer still counted events of ticks <= T.
	settleGraceMs: number;
	drain:
		| { type: "drained"; ms: number }
		| { type: "did_not_drain"; pending: number };
	// Clients the server disconnected during the run (/varz).
	slowConsumers: number;
	// Largest /connz pending_bytes sampled.
	pendingBytes: { observerMax: number; anyMax: number };
	host: { cpus: number; loadAverage: [number, number, number] };
	peakRssBytes: { service: string; bytes: number }[];
};

// ADR 0037's criteria; ADR 0036's band for settle p95.
const minTicks = 600;
const maxSettleP95Ms = 610;
const maxOverrunShare = 0.01;

export function loadtestReport(
	args: LoadtestArgs,
	measurement: LoadtestMeasurement,
): string {
	const { count, driversPerShard } = args.driverShards;
	const { matching } = args;
	const { settle, drain } = measurement;
	const trend = pendingTrend(measurement.persisterPending);
	const overrunShare = settle.overruns / settle.ticksObserved;
	const drainMinutes = args.drainBoundMs / 60_000;
	const criteria: [boolean, string][] = [
		[args.ticks >= minTicks, `ticks >= ${minTicks}`],
		[
			settle.settleMs.p95 <= maxSettleP95Ms,
			`settle p95 <= ${maxSettleP95Ms} ms`,
		],
		[
			overrunShare <= maxOverrunShare,
			`overruns <= ${maxOverrunShare * 100}% of ticks`,
		],
		[trend !== undefined && !trend.rising, "persister pending not rising"],
		[drain.type === "drained", `persister drained within ${drainMinutes} min`],
		[measurement.slowConsumers === 0, "no slow consumers"],
	];
	const [load1, load5, load15] = measurement.host.loadAverage;
	return [
		`drivers: ${count * driversPerShard} (${count} shards x ${driversPerShard})`,
		`requests per minute: ${args.requestsPerMinute}`,
		`matching: ${matching.type === "batched" ? `batched (window ${matching.windowTicks} ticks)` : "greedy"}`,
		`ticks: ${args.ticks} (${settle.ticksObserved} observed), speed 1`,
		`host: ${measurement.host.cpus} CPUs, load average ${load1.toFixed(2)} ${load5.toFixed(2)} ${load15.toFixed(2)} (1, 5, 15 min, at end)`,
		`settle ms: mean ${settle.settleMs.mean.toFixed(1)}, p95 ${settle.settleMs.p95.toFixed(1)}, max ${settle.settleMs.max.toFixed(1)}`,
		`overruns: ${settle.overruns} of ${settle.ticksObserved} ticks (${(overrunShare * 100).toFixed(1)}%)`,
		`last tick: events after the ${measurement.settleGraceMs / 1000} s grace window not observed, so its settle may be understated`,
		`message rate: ${(settle.messages / settle.ticksObserved).toFixed(1)} per tick (${settle.messages} events of ticks 1..${args.ticks})`,
		`observer: clock.ticked max deviation ${settle.clockMaxDeviationMs.toFixed(1)} ms, pending bytes max ${measurement.pendingBytes.observerMax}`,
		`nats: slow consumers ${measurement.slowConsumers}, pending bytes max ${measurement.pendingBytes.anyMax} (any connection)`,
		`persister pending (every ${measurement.sampleIntervalMs / 1000} s): ${measurement.persisterPending.join(" ")}`,
		`persister ack pending max: ${measurement.persisterAckPendingMax}`,
		`persister pending trend: ${trend === undefined ? "too few samples" : `first half mean ${trend.firstHalfMean.toFixed(1)}, second half mean ${trend.secondHalfMean.toFixed(1)} (${trend.rising ? "rising" : "not rising"})`}`,
		`persister drain: ${drain.type === "drained" ? `${(drain.ms / 1000).toFixed(1)} s` : `did not drain in ${drainMinutes} min (pending ${drain.pending})`}`,
		`peak rss MiB: ${measurement.peakRssBytes.map(({ service, bytes }) => `${service} ${(bytes / 2 ** 20).toFixed(1)}`).join(", ")}`,
		"criteria (ADR 0037; supported live = the slower of two runs passes all):",
		...criteria.map(
			([passed, criterion]) => `  ${passed ? "pass" : "FAIL"}: ${criterion}`,
		),
	].join("\n");
}
