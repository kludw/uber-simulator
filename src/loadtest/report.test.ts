import { describe, expect, test } from "bun:test";
import { type LoadtestMeasurement, loadtestReport } from "./report.ts";

const args = {
	ticks: 600,
	driverShards: { count: 2, driversPerShard: 500 },
	requestsPerMinute: 100,
	matching: { type: "batched", windowTicks: 5 },
	drainBoundMs: 300_000,
	natsMonitoringUrl: "http://localhost:8222",
} as const;

const healthy: LoadtestMeasurement = {
	settle: {
		settleMs: { mean: 12.345, p95: 40, max: 95.5 },
		overruns: 0,
		ticksObserved: 600,
		messages: 630_000,
		clockMaxDeviationMs: 3.25,
	},
	persisterPending: [0, 1200, 800, 1000, 900, 400],
	persisterAckPendingMax: 1000,
	sampleIntervalMs: 5000,
	drain: { type: "drained", ms: 2500 },
	slowConsumers: 0,
	pendingBytes: { observerMax: 0, anyMax: 2048 },
	host: { cpus: 4, loadAverage: [3.5, 2.25, 1] },
	peakRssBytes: [
		{ service: "persister", bytes: 125_829_120 },
		{ service: "dispatch", bytes: 83_886_080 },
	],
};

describe("loadtestReport", () => {
	test("reports the run, the observer's validity, the persister, the host, and a verdict per criterion", () => {
		expect(loadtestReport(args, healthy)).toBe(
			[
				"drivers: 1000 (2 shards x 500)",
				"requests per minute: 100",
				"matching: batched (window 5 ticks)",
				"ticks: 600 (600 observed), speed 1",
				"host: 4 CPUs, load average 3.50 2.25 1.00 (1, 5, 15 min, at end)",
				"settle ms: mean 12.3, p95 40.0, max 95.5",
				"overruns: 0 of 600 ticks (0.0%)",
				"message rate: 1050.0 per tick (630000 events of ticks 1..600)",
				"observer: clock.ticked max deviation 3.3 ms, pending bytes max 0",
				"nats: slow consumers 0, pending bytes max 2048 (any connection)",
				"persister pending (every 5 s): 0 1200 800 1000 900 400",
				"persister ack pending max: 1000",
				"persister pending trend: first half mean 666.7, second half mean 766.7 (rising)",
				"persister drain: 2.5 s",
				"peak rss MiB: persister 120.0, dispatch 80.0",
				"criteria (ADR 0037; supported live = the slower of two runs passes all):",
				"  pass: ticks >= 600",
				"  pass: settle p95 <= 610 ms",
				"  pass: overruns <= 1% of ticks",
				"  FAIL: persister pending not rising",
				"  pass: persister drained within 5 min",
				"  pass: no slow consumers",
			].join("\n"),
		);
	});

	test("a short, slow run that never drains fails those criteria", () => {
		const report = loadtestReport(
			{ ...args, ticks: 120 },
			{
				...healthy,
				settle: {
					...healthy.settle,
					settleMs: { mean: 500, p95: 980, max: 1500 },
					overruns: 3,
					ticksObserved: 120,
				},
				persisterPending: [5],
				drain: { type: "did_not_drain", pending: 4321 },
				slowConsumers: 2,
			},
		);
		expect(report.split("\n").slice(-12)).toEqual([
			"persister pending (every 5 s): 5",
			"persister ack pending max: 1000",
			"persister pending trend: too few samples",
			"persister drain: did not drain in 5 min (pending 4321)",
			"peak rss MiB: persister 120.0, dispatch 80.0",
			"criteria (ADR 0037; supported live = the slower of two runs passes all):",
			"  FAIL: ticks >= 600",
			"  FAIL: settle p95 <= 610 ms",
			"  FAIL: overruns <= 1% of ticks",
			"  FAIL: persister pending not rising",
			"  FAIL: persister drained within 5 min",
			"  FAIL: no slow consumers",
		]);
	});
});
