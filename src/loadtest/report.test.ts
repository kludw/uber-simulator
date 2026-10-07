import { describe, expect, test } from "bun:test";
import { type LoadtestMeasurement, loadtestReport } from "./report.ts";

const args = {
	ticks: 600,
	driverShards: { count: 2, driversPerShard: 500 },
	requestsPerMinute: 100,
	matching: { type: "batched", windowTicks: 5 },
	regions: { columns: 2, rows: 1 },
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
		observerLate: { ms: 12.5, tick: 300 },
		lastEventSubjects: [
			{ subject: "sim.events.trip.matched", ticks: 450 },
			{ subject: "sim.events.drivers.moved", ticks: 147 },
		],
		bySubject: [
			{
				subject: "sim.events.drivers.moved",
				events: 600_000,
				bytes: 42_000_000,
			},
			{ subject: "sim.events.trip.matched", events: 29_400, bytes: 3_234_000 },
			{ subject: "sim.events.clock.ticked", events: 600, bytes: 15_000 },
		],
	},
	persisterSamples: [
		[0, 0],
		[200, 1000],
		[0, 800],
		[300, 700],
		[100, 800],
		[0, 400],
	].map(([pending, ackPending]) => ({
		pending: pending ?? 0,
		ackPending: ackPending ?? 0,
	})),
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
	// Start, one per backlog sample, stop.
	infraReadings: [
		[0, 1_000_000, 500_000, 10_000_000, 2_000_000, 1_000_000],
		[2000, 1_500_000, 800_000, 10_400_000, 2_100_000, 1_000_000],
		[7000, 2_700_000, 1_600_000, 11_400_000, 2_350_000, 1_000_000],
		[12_000, 3_900_000, 2_400_000, 16_400_000, 3_350_000, 5_500_000],
		[17_000, 6_900_000, 3_900_000, 17_400_000, 3_600_000, 5_500_000],
		[22_000, 8_100_000, 4_700_000, 18_400_000, 3_850_000, 5_500_000],
		[27_000, 9_300_000, 5_500_000, 19_400_000, 4_100_000, 5_520_000],
		[700_000, 61_000_000, 40_500_000, 110_000_000, 22_000_000, 9_000_000],
	].map(
		([atMs, natsUser, natsSystem, clickhouseUser, clickhouseSystem, rows]) => ({
			atMs: atMs ?? 0,
			natsServer: { userMicros: natsUser ?? 0, systemMicros: natsSystem ?? 0 },
			clickhouse: {
				userMicros: clickhouseUser ?? 0,
				systemMicros: clickhouseSystem ?? 0,
			},
			mergedRows: rows ?? 0,
		}),
	),
	loadtestCpu: { userMicros: 8_000_000, systemMicros: 2_600_000 },
};

describe("loadtestReport", () => {
	test("reports the run, the observer's validity, the persister, the host, and a verdict per criterion", () => {
		expect(loadtestReport(args, healthy)).toBe(
			[
				"drivers: 1000 (2 shards x 500)",
				"requests per minute: 100",
				"matching: batched (window 5 ticks)",
				"regions: 2x1",
				"ticks: 600 (600 observed), speed 1",
				"host: 4 CPUs (AMD EPYC 7763 64-Core Processor), load average 3.50 2.25 1.00 (1, 5, 15 min, at end)",
				"settle ms: mean 12.3, p95 40.0, max 95.5",
				"overruns: 0 of 600 ticks (0.0%)",
				"last tick: events after the 2 s grace window not observed, so its settle may be understated",
				"message rate: 1050.0 per tick (630000 events of ticks 1..600)",
				"events by subject (per tick, payload bytes per tick, share of events, share of bytes): sim.events.drivers.moved 1000.0, 70000 B (95.2%, 92.8%), sim.events.trip.matched 49.0, 5390 B (4.7%, 7.1%), sim.events.clock.ticked 1.0, 25 B (0.1%, 0.0%)",
				"observer: clock.ticked max deviation 3.3 ms, received late max 12.5 ms (tick 300) against the clock's schedule, pending bytes max 0",
				"last event of a tick (share of observed ticks, by subject): sim.events.trip.matched 75.0%, sim.events.drivers.moved 24.5%",
				"nats: slow consumers 0, pending bytes max 2048 (any connection)",
				"persister pending (published, not yet delivered, every 5 s): 0 200 0 300 100 0",
				"persister ack pending (delivered, not yet acked, every 5 s): 0 1000 800 700 800 400",
				"nats server cpu per backlog sample (cores, since the previous reading): 0.40 0.40 0.40 0.90 0.40 0.40",
				"clickhouse cpu per backlog sample (cores, since the previous reading): 0.25 0.25 1.20 0.25 0.25 0.25",
				"clickhouse merged rows per backlog sample (thousands, every table, since the previous reading): 0 0 4500 0 0 20",
				"persister ack pending max: 1000",
				"persister backlog (pending) second-half max: 300, limit 3150 (3 ticks of 1050.0 events)",
				"persister drain: 2.5 s",
				"peak rss MiB: persister 120.0, dispatch 80.0",
				"cpu s (user + system, share of the service's wall time): persister 90.0 + 30.5 (17%), dispatch 540.3 + 9.8 (90%)",
				"runner cpu s (user + system, share of 4 CPUs over the 700.0 s from start to stop): services 670.5 (23.9%), nats server 60.0 + 40.0 (3.6%), clickhouse 100.0 + 20.0 (4.3%), load test 8.0 + 2.6 (0.4%), total 901.1 (32.2%)",
				"criteria (ADRs 0037, 0046; supported live = the slower of two runs passes all):",
				"  pass: ticks >= 600",
				"  pass: settle p95 <= 610 ms",
				"  pass: overruns <= 1% of ticks",
				"  pass: persister backlog (pending) <= 3 ticks of events",
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
				persisterSamples: [{ pending: 5, ackPending: 0 }],
				drain: { type: "did_not_drain", pending: 4321 },
				slowConsumers: 2,
			},
		);
		expect(report.split("\n").slice(-13)).toEqual([
			"persister ack pending max: 0",
			"persister backlog (pending) second-half max: too few samples",
			"persister drain: did not drain in 5 min (pending 4321)",
			"peak rss MiB: persister 120.0, dispatch 80.0",
			"cpu s (user + system, share of the service's wall time): persister 90.0 + 30.5 (17%), dispatch 540.3 + 9.8 (90%)",
			"runner cpu s (user + system, share of 4 CPUs over the 700.0 s from start to stop): services 670.5 (23.9%), nats server 60.0 + 40.0 (3.6%), clickhouse 100.0 + 20.0 (4.3%), load test 8.0 + 2.6 (0.4%), total 901.1 (32.2%)",
			"criteria (ADRs 0037, 0046; supported live = the slower of two runs passes all):",
			"  FAIL: ticks >= 600",
			"  FAIL: settle p95 <= 610 ms",
			"  FAIL: overruns <= 1% of ticks",
			"  FAIL: persister backlog (pending) <= 3 ticks of events",
			"  FAIL: persister drained within 5 min",
			"  FAIL: no slow consumers",
		]);
	});

	test("an observer receiving clock.ticked 100 ms or more late warns that it measured settle late", () => {
		const report = loadtestReport(args, {
			...healthy,
			settle: { ...healthy.settle, observerLate: { ms: 1162, tick: 1 } },
		});
		expect(report).toContain(
			"warning: the observer received clock.ticked 1 1162.0 ms late (limit 100 ms): settle and overruns around tick 1 are measured from its late receipt",
		);
	});

	test("the observer's lateness warning starts at exactly 100 ms", () => {
		const warnings = (ms: number) =>
			loadtestReport(args, {
				...healthy,
				settle: { ...healthy.settle, observerLate: { ms, tick: 7 } },
			})
				.split("\n")
				.filter((line) => line.startsWith("warning:")).length;
		expect([warnings(99.9), warnings(100)]).toEqual([0, 1]);
	});

	test("a persister holding over 3 ticks of events, with none waiting, keeps up", () => {
		const report = loadtestReport(args, {
			...healthy,
			persisterSamples: [
				{ pending: 0, ackPending: 0 },
				{ pending: 0, ackPending: 2000 },
				{ pending: 0, ackPending: 4000 },
				{ pending: 0, ackPending: 4000 },
			],
		});
		expect(report).toContain(
			"  pass: persister backlog (pending) <= 3 ticks of events",
		);
	});
});
