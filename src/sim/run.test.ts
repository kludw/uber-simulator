import { describe, expect, test } from "bun:test";
import { connect } from "@nats-io/transport-node";
import * as z from "zod";
import type { Matching } from "../dispatch/brain.ts";
import { checkInvariants } from "./invariants.ts";
import {
	type RunConfig,
	type RunResult,
	runInProcess,
	runOverNats,
} from "./run.ts";

const quietConfig = {
	seed: 1,
	ticks: 3,
	grid: { width: 10, height: 10 },
	driverShards: { count: 2, driversPerShard: 2 },
	requestsPerMinute: 0,
};

// Two shards of one driver each: offers must route to the owning shard.
const busyConfig = {
	seed: 7,
	ticks: 300,
	grid: { width: 10, height: 10 },
	driverShards: { count: 2, driversPerShard: 1 },
	requestsPerMinute: 30,
};

// Two drivers, far more requests than they can serve: riders lose patience
// while queued, offered, and matched.
const scarceConfig = {
	seed: 1,
	ticks: 600,
	grid: { width: 20, height: 20 },
	driverShards: { count: 1, driversPerShard: 2 },
	requestsPerMinute: 30,
};

describe("runInProcess", () => {
	test("riders' trips get completed by drivers across shards", () => {
		const { eventLog } = runInProcess(busyConfig);

		expect(eventLog.map((message) => message.type)).toContain("trip.completed");
	});

	test("same seed and config give an identical event log", () => {
		expect(runInProcess(busyConfig).eventLog).toEqual(
			runInProcess(busyConfig).eventLog,
		);
	});

	test("a different seed gives a different event log", () => {
		expect(runInProcess({ ...busyConfig, seed: 8 }).eventLog).not.toEqual(
			runInProcess(busyConfig).eventLog,
		);
	});

	// FIFO delivery leaves no stale or out-of-order inputs in process.
	test("a busy run rejects no inputs", () => {
		expect(runInProcess(busyConfig).rejected).toEqual([]);
	});

	test.each<[string, Matching]>([
		["greedy", { type: "greedy" }],
		["batched", { type: "batched", windowTicks: 5 }],
	])(
		"a 3600-tick %s run at spec defaults breaks no invariant",
		(_, matching) => {
			const grid = { width: 500, height: 500 };
			const { eventLog } = runInProcess({
				seed: 1,
				ticks: 3600,
				grid,
				driverShards: { count: 2, driversPerShard: 50 },
				requestsPerMinute: 10,
				matching,
			});

			expect(checkInvariants(eventLog, grid)).toEqual([]);
		},
		// A simulated hour takes seconds in process.
		30_000,
	);

	// ADR 0030: batched dispatch offers trips only on window ticks.
	test("batched matching offers trips only on multiples of its window", () => {
		const { eventLog } = runInProcess({
			...busyConfig,
			matching: { type: "batched", windowTicks: 4 },
		});

		const offerTicks = eventLog.flatMap((message) =>
			message.type === "trip.offered" ? [message.tick] : [],
		);
		expect({
			offered: offerTicks.length > 0,
			offWindow: offerTicks.filter((tick) => tick % 4 !== 0),
		}).toEqual({ offered: true, offWindow: [] });
	});

	test("a scarce-supply run breaks no invariant", () => {
		const { eventLog } = runInProcess(scarceConfig);

		expect(checkInvariants(eventLog, scarceConfig.grid)).toEqual([]);
	});

	// Guards the test above: it must exercise cancels that free a driver.
	test("a scarce-supply run cancels trips that name a driver to free", () => {
		const { eventLog } = runInProcess(scarceConfig);

		const freeingDriver = eventLog.filter(
			(message) =>
				message.type === "trip.cancelled" && message.driverId !== null,
		);
		expect(freeingDriver).not.toBeEmpty();
	});

	test("publishes clock.ticked for ticks 1..N in order", () => {
		const { eventLog } = runInProcess(quietConfig);

		const ticks = eventLog.flatMap((message) =>
			message.type === "clock.ticked" ? [message.tick] : [],
		);
		expect<number[]>(ticks).toEqual([1, 2, 3]);
	});

	test("starts every driver of every shard online at tick 0, before the first tick", () => {
		const { eventLog } = runInProcess(quietConfig);

		const start: unknown[][] = eventLog
			.slice(0, 5)
			.map((message) =>
				message.type === "driver.went_online"
					? [message.type, message.tick, message.driverId]
					: [message.type],
			);
		expect(start).toEqual([
			["driver.went_online", 0, "d-0"],
			["driver.went_online", 0, "d-1"],
			["driver.went_online", 0, "d-2"],
			["driver.went_online", 0, "d-3"],
			["clock.ticked"],
		]);
	});

	test("driver IDs sort in shard order under plain string comparison", () => {
		const { eventLog } = runInProcess({
			...quietConfig,
			ticks: 0,
			driverShards: { count: 2, driversPerShard: 6 },
		});

		const driverIds = eventLog.flatMap((message) =>
			message.type === "driver.went_online" ? [message.driverId] : [],
		);
		expect<string[]>(driverIds).toEqual([
			"d-00",
			"d-01",
			"d-02",
			"d-03",
			"d-04",
			"d-05",
			"d-06",
			"d-07",
			"d-08",
			"d-09",
			"d-10",
			"d-11",
		]);
	});
});

// Integration tests need a real server: `docker compose up -d --wait`, then
// NATS_URL from .env (Bun loads it) or the environment. The runs publish on
// sim.>, so nothing else (e.g. `bun run dev`) may run on the same server.
const natsUrl = z.url().optional().parse(Bun.env.NATS_URL);
if (!natsUrl) {
	console.warn("NATS_URL unset: skipping distributed run tests");
}

describe.skipIf(!natsUrl)("runOverNats", () => {
	async function runOnServer(config: RunConfig): Promise<RunResult> {
		const result = await runOverNats({ ...config, url: natsUrl ?? "" });
		if (!result.ok) throw new Error("NATS unavailable", { cause: result });
		return result.value;
	}

	const specDefaultConfig = {
		seed: 1,
		ticks: 600,
		grid: { width: 500, height: 500 },
		driverShards: { count: 2, driversPerShard: 50 },
		requestsPerMinute: 10,
	};

	// Matches only: at this size the first completion lands near tick 400, too
	// close to 600 once overtaken messages (ADR 0028) delay matching under load.
	// The scarce-supply run's short trips cover completion.
	test("a 600-tick run at spec defaults breaks no invariant and matches trips", async () => {
		const { eventLog } = await runOnServer(specDefaultConfig);

		expect({
			violations: checkInvariants(eventLog, specDefaultConfig.grid),
			matched: eventLog.some((message) => message.type === "trip.matched"),
		}).toEqual({ violations: [], matched: true });
	}, 60_000);

	test("every message of a run carries the run id it returns", async () => {
		// A raw connection sees headers, which the bus port hides.
		const raw = await connect({ servers: natsUrl });
		const runIds = new Set<string | undefined>();
		const subscription = raw.subscribe("sim.>", {
			callback: (_, message) => {
				runIds.add(message.headers?.get("Run-Id"));
			},
		});
		await raw.flush();

		const result = await runOverNats({ ...quietConfig, url: natsUrl ?? "" });
		await raw.flush();
		subscription.unsubscribe();
		await raw.close();

		if (!result.ok) throw new Error("NATS unavailable", { cause: result });
		expect(runIds).toEqual(new Set([result.value.runId]));
	});

	test("a scarce-supply run breaks no invariant, completes and cancels trips", async () => {
		const { eventLog } = await runOnServer(scarceConfig);

		expect({
			violations: checkInvariants(eventLog, scarceConfig.grid),
			completed: eventLog.some((message) => message.type === "trip.completed"),
			cancelled: eventLog.some((message) => message.type === "trip.cancelled"),
		}).toEqual({ violations: [], completed: true, cancelled: true });
	}, 60_000);
});
