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
	persisterBacklog: [0, 1200, 800, 1000, 900, 400],
	persisterAckPendingMax: 1000,
	sampleIntervalMs: 5000,
	settleGraceMs: 2000,
	drain: { type: "drained", ms: 2500 },
	slowConsumers: 0,
	pendingBytes: { observerMax: 0, anyMax: 2048 },
	host: {
		cpus: 4,
		cpuModel: "AMD EPYC 7763 64-Core Processor",
		loadAverage: [3.5, 2.25, 1],
	},
	peakRssBytes: [
		{ service: "persister", bytes: 125_829_120 },
		{ service: "dispatch", bytes: 83_886_080 },
	],
	cpuTime: [
		{
			service: "persister",
			userMicros: 90_000_000,
			systemMicros: 30_500_000,
			wallMs: 700_000,
		},
		{
			service: "dispatch",
			userMicros: 540_250_000,
			systemMicros: 9_750_000,
			wallMs: 610_000,
		},
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
				"host: 4 CPUs (AMD EPYC 7763 64-Core Processor), load average 3.50 2.25 1.00 (1, 5, 15 min, at end)",
				"settle ms: mean 12.3, p95 40.0, max 95.5",
				"overruns: 0 of 600 ticks (0.0%)",
				"last tick: events after the 2 s grace window not observed, so its settle may be understated",
				"message rate: 1050.0 per tick (630000 events of ticks 1..600)",
				"observer: clock.ticked max deviation 3.3 ms, pending bytes max 0",
				"nats: slow consumers 0, pending bytes max 2048 (any connection)",
				"persister backlog (pending + ack pending, every 5 s): 0 1200 800 1000 900 400",
				"persister ack pending max: 1000",
				"persister backlog second-half max: 1000, limit 3150 (3 ticks of 1050.0 events)",
				"persister drain: 2.5 s",
				"peak rss MiB: persister 120.0, dispatch 80.0",
				"cpu s (user + system, share of the service's wall time): persister 90.0 + 30.5 (17%), dispatch 540.3 + 9.8 (90%)",
				"criteria (ADRs 0037, 0038; supported live = the slower of two runs passes all):",
				"  pass: ticks >= 600",
				"  pass: settle p95 <= 610 ms",
				"  pass: overruns <= 1% of ticks",
				"  pass: persister backlog <= 3 ticks of events",
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
				persisterBacklog: [5],
				drain: { type: "did_not_drain", pending: 4321 },
				slowConsumers: 2,
			},
		);
		expect(report.split("\n").slice(-13)).toEqual([
			"persister backlog (pending + ack pending, every 5 s): 5",
			"persister ack pending max: 1000",
			"persister backlog second-half max: too few samples",
			"persister drain: did not drain in 5 min (pending 4321)",
			"peak rss MiB: persister 120.0, dispatch 80.0",
			"cpu s (user + system, share of the service's wall time): persister 90.0 + 30.5 (17%), dispatch 540.3 + 9.8 (90%)",
			"criteria (ADRs 0037, 0038; supported live = the slower of two runs passes all):",
			"  FAIL: ticks >= 600",
			"  FAIL: settle p95 <= 610 ms",
			"  FAIL: overruns <= 1% of ticks",
			"  FAIL: persister backlog <= 3 ticks of events",
			"  FAIL: persister drained within 5 min",
			"  FAIL: no slow consumers",
		]);
	});
});
