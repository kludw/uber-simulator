import { describe, expect, test } from "bun:test";
import { connect } from "@nats-io/transport-node";
import * as z from "zod";
import type { Matching } from "../dispatch/brain.ts";
import { cityDemand } from "../rider/demand.ts";
import { driverIdAt } from "../shared/fleet.ts";
import { Cell, cellAt, distance } from "../shared/grid.ts";
import type { Message } from "../shared/messages.ts";
import {
	forEachDriverAt,
	forEachMove,
	forEachWentOnline,
} from "../shared/messages.ts";
import { regionOf } from "../shared/regions.ts";
import { preferencesNamed, shiftsNamed } from "./config.ts";
import { checkInvariants } from "./invariants.ts";
import {
	type RunConfig,
	type RunResult,
	runInProcess,
	runOverNats,
} from "./run.ts";
import { createSummary, summarize } from "./summary.ts";

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

// Four regions of 25 x 25 cells, about five drivers each.
const regionsConfig = {
	seed: 1,
	ticks: 3600,
	grid: { width: 50, height: 50 },
	driverShards: { count: 2, driversPerShard: 10 },
	requestsPerMinute: 20,
	regions: { columns: 2, rows: 2 },
};

// ADR 0054: four surge zones, four drivers, far more requests than they
// serve, so zones surge, riders decline and idle drivers chase (ADR 0055).
const surgeConfig = {
	seed: 1,
	ticks: 1200,
	grid: { width: 100, height: 100 },
	driverShards: { count: 1, driversPerShard: 4 },
	requestsPerMinute: 20,
	surge: true,
};

// What a run shows of surge: zones priced above 1.0, riders declined, and
// trips requested with a fare.
function surgeSeen(eventLog: readonly Message[]): {
	surging: boolean;
	declined: boolean;
	priced: boolean;
} {
	return {
		surging: eventLog.some(
			(message) => message.type === "zones.priced" && message.zones.length > 0,
		),
		declined: eventLog.some(
			(message) => message.type === "rider.declined_surge",
		),
		priced: eventLog.some(
			(message) =>
				message.type === "trip.requested" && message.fare !== undefined,
		),
	};
}

const regionOfCell = (cell: Cell): number =>
	regionOf(regionsConfig.regions, regionsConfig.grid, cell);

describe("runInProcess", () => {
	test("riders' trips get completed by drivers across shards", () => {
		const { eventLog } = runInProcess({ ...busyConfig, keepEventLog: true });

		expect(eventLog.map((message) => message.type)).toContain("trip.completed");
	});

	test("same seed and config give an identical event log", () => {
		expect(
			runInProcess({ ...busyConfig, keepEventLog: true }).eventLog,
		).toEqual(runInProcess({ ...busyConfig, keepEventLog: true }).eventLog);
	});

	test("a different seed gives a different event log", () => {
		expect(
			runInProcess({ ...busyConfig, seed: 8, keepEventLog: true }).eventLog,
		).not.toEqual(runInProcess({ ...busyConfig, keepEventLog: true }).eventLog);
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
				keepEventLog: true,
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

	// ADR 0031: downtown is (250, 250), radius 50, about 2% of the spec grid,
	// so uniform demand puts few pickups there and city demand nearly half.
	test("city demand puts most pickups downtown that uniform demand spreads out", () => {
		const config = {
			seed: 1,
			ticks: 600,
			grid: { width: 500, height: 500 },
			driverShards: { count: 1, driversPerShard: 10 },
			requestsPerMinute: 60,
		};
		const downtownShare = (result: { eventLog: Message[] }) => {
			const pickups = result.eventLog.flatMap((message) =>
				message.type === "trip.requested" ? [message.pickup] : [],
			);
			const downtown = pickups.filter(
				(pickup) => distance(pickup, Cell.parse({ x: 250, y: 250 })) <= 50,
			);
			return downtown.length / pickups.length;
		};

		expect({
			uniform:
				downtownShare(runInProcess({ ...config, keepEventLog: true })) < 0.1,
			city:
				downtownShare(
					runInProcess({ ...config, demand: cityDemand, keepEventLog: true }),
				) > 0.3,
		}).toEqual({ uniform: true, city: true });
	});

	test.each<[string, Matching]>([
		["greedy", { type: "greedy" }],
		["batched", { type: "batched", windowTicks: 5 }],
	])(
		"a 3600-tick %s run under city demand breaks no invariant",
		(_, matching) => {
			const grid = { width: 500, height: 500 };
			const { eventLog } = runInProcess({
				keepEventLog: true,
				seed: 1,
				ticks: 3600,
				grid,
				driverShards: { count: 2, driversPerShard: 50 },
				requestsPerMinute: 10,
				matching,
				demand: cityDemand,
			});

			expect(checkInvariants(eventLog, grid)).toEqual([]);
		},
		30_000,
	);

	// ADR 0032: the preset's online periods (at most 2400 ticks) end within
	// the hour, so drivers go offline and some come back.
	test.each<[string, Matching]>([
		["greedy", { type: "greedy" }],
		["batched", { type: "batched", windowTicks: 5 }],
	])(
		"a 3600-tick %s run with shifts breaks no invariant and drivers go offline and come back",
		(_, matching) => {
			const grid = { width: 500, height: 500 };
			const { eventLog } = runInProcess({
				keepEventLog: true,
				seed: 1,
				ticks: 3600,
				grid,
				driverShards: { count: 2, driversPerShard: 50 },
				requestsPerMinute: 10,
				matching,
				shifts: shiftsNamed("on"),
			});

			const firstOffline = eventLog.find(
				(message) => message.type === "driver.went_offline",
			);
			const backOnline = eventLog.some(
				(message) =>
					message.type === "drivers.went_online" &&
					firstOffline !== undefined &&
					message.tick > firstOffline.tick,
			);
			expect({
				violations: checkInvariants(eventLog, grid),
				wentOffline: firstOffline !== undefined,
				backOnline,
			}).toEqual({ violations: [], wentOffline: true, backOnline: true });
		},
		30_000,
	);

	// ADR 0035: drivers with accept_all decline only while on another trip,
	// so a decline from a driver with no active trip is a preference.
	test.each<[string, Matching]>([
		["greedy", { type: "greedy" }],
		["batched", { type: "batched", windowTicks: 5 }],
	])(
		"a 3600-tick %s run with picky drivers breaks no invariant and idle drivers decline offers",
		(_, matching) => {
			const grid = { width: 500, height: 500 };
			const { eventLog } = runInProcess({
				keepEventLog: true,
				seed: 1,
				ticks: 3600,
				grid,
				driverShards: { count: 2, driversPerShard: 50 },
				requestsPerMinute: 10,
				matching,
				preferences: preferencesNamed("picky"),
			});

			const activeTripByDriver = new Map<string, string>();
			let idleDeclines = 0;
			for (const message of eventLog) {
				switch (message.type) {
					case "trip.matched":
						activeTripByDriver.set(message.driverId, message.tripId);
						break;
					case "trip.completed":
					case "trip.cancelled":
						for (const [driverId, tripId] of activeTripByDriver) {
							if (tripId === message.tripId)
								activeTripByDriver.delete(driverId);
						}
						break;
					case "trip.offer_declined":
						if (!activeTripByDriver.has(message.driverId)) idleDeclines++;
						break;
				}
			}
			expect({
				violations: checkInvariants(eventLog, grid),
				idleDeclines: idleDeclines > 0,
			}).toEqual({ violations: [], idleDeclines: true });
		},
		30_000,
	);

	// ADR 0030: batched dispatch offers trips only on window ticks.
	test("batched matching offers trips only on multiples of its window", () => {
		const { eventLog } = runInProcess({
			keepEventLog: true,
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
		const { eventLog } = runInProcess({ ...scarceConfig, keepEventLog: true });

		expect(checkInvariants(eventLog, scarceConfig.grid)).toEqual([]);
	});

	// Guards the test above: it must exercise cancels that free a driver.
	test("a scarce-supply run cancels trips that name a driver to free", () => {
		const { eventLog } = runInProcess({ ...scarceConfig, keepEventLog: true });

		const freeingDriver = eventLog.filter(
			(message) =>
				message.type === "trip.cancelled" && message.driverId !== null,
		);
		expect(freeingDriver).not.toBeEmpty();
	});

	test("a surge run breaks no invariant, surges zones, declines riders and prices trips", () => {
		const { eventLog } = runInProcess({ ...surgeConfig, keepEventLog: true });

		expect({
			violations: checkInvariants(eventLog, surgeConfig.grid),
			...surgeSeen(eventLog),
		}).toEqual({
			violations: [],
			surging: true,
			declined: true,
			priced: true,
		});
	});

	test("a surge run on the same seed gives an identical event log", () => {
		expect(
			runInProcess({ ...surgeConfig, keepEventLog: true }).eventLog,
		).toEqual(runInProcess({ ...surgeConfig, keepEventLog: true }).eventLog);
	});

	// Surge off: every message as before surge existed.
	test("a surge-off run publishes no price", () => {
		const { eventLog } = runInProcess({
			...surgeConfig,
			surge: false,
			keepEventLog: true,
		});

		expect({
			pricedZones: eventLog.some((message) => message.type === "zones.priced"),
			requestedWithSurge: eventLog.some(
				(message) =>
					(message.type === "request_trip" ||
						message.type === "trip.requested") &&
					message.surge !== undefined,
			),
			...surgeSeen(eventLog),
		}).toEqual({
			pricedZones: false,
			requestedWithSurge: false,
			surging: false,
			declined: false,
			priced: false,
		});
	});

	// ADR 0054: a lost zones.priced leaves a rider on a stale quote until the
	// next, a lost decline reaches no service; neither may break an invariant.
	// 2x2 regions price their zone parts each.
	test("with 1% of messages lost and surge on at 2x2, no invariant breaks", () => {
		const { eventLog } = runInProcess({
			...surgeConfig,
			regions: { columns: 2, rows: 2 },
			lossShare: 0.01,
			keepEventLog: true,
		});

		expect({
			violations: checkInvariants(eventLog, surgeConfig.grid),
			...surgeSeen(eventLog),
		}).toEqual({
			violations: [],
			surging: true,
			declined: true,
			priced: true,
		});
	});

	// ADR 0041: a driver waiting at a pickup or dropoff confirms 10 ticks after
	// arriving and every 10 ticks after, so each lost arrival or trip event
	// costs one 10-tick round. A round fails only if its confirm or the reply
	// is lost too (about 2% at 1% loss), so 3 rounds cover every wait here.
	// Trips: a stage spans at most two waits and the longest drive on the
	// grid. Matched: drive to the pickup, then the pickup wait. Picked up: the
	// driver may miss trip.picked_up and leave the pickup up to a wait later,
	// then drive to the dropoff and wait there. Every spec
	// invariant still holds: the event log keeps every message, and loss only
	// delays the facts dispatch and drivers publish. Riders are not recovered
	// (lost trip events leave them waiting or riding), so they go unchecked.
	test("with 1% of messages lost, waiting drivers move on, matched and picked-up trips end, and no invariant breaks", () => {
		const grid = { width: 50, height: 50 };
		const ticks = 3600;
		const { eventLog } = runInProcess({
			keepEventLog: true,
			seed: 1,
			ticks,
			grid,
			driverShards: { count: 1, driversPerShard: 20 },
			requestsPerMinute: 20,
			lossShare: 0.01,
		});

		const waitBound = 3 * 10 + 1;
		const tripBound = grid.width - 1 + (grid.height - 1) + 2 * waitBound;
		expect({
			confirmed: eventLog.some((message) => message.type === "confirm_trip"),
			stuckDrivers: longWaits(eventLog, ticks, waitBound),
			stuckTrips: longTripStages(eventLog, ticks, tripBound),
			violations: checkInvariants(eventLog, grid),
		}).toEqual({
			confirmed: true,
			stuckDrivers: [],
			stuckTrips: [],
			violations: [],
		});
	}, 30_000);

	// ADR 0050 (6): a lost border-crossing move leaves the old region a ghost,
	// an idle driver at a stale cell inside it; that's allowed. What isn't: an
	// instance offering a driver whose last cell it was told (moves, going
	// online, declines' idleAt, arrivals, confirms) is outside its region.
	// Offers come only on clock.ticked, so the view is the one at that tick.
	test("with 1% of messages lost at 2x2, no invariant breaks and no region offers a driver last seen outside it", () => {
		const views = new Map<string, Map<string, Cell | null>>();
		const viewsAtTick = new Map<string, Map<string, Cell | null>>();
		const viewOf = (service: string) => {
			const view = views.get(service) ?? new Map<string, Cell | null>();
			views.set(service, view);
			return view;
		};
		let crossingMoves = 0;
		let crossingMovesDelivered = 0;
		const offersOutside: string[] = [];
		const { eventLog } = runInProcess(
			{ ...regionsConfig, lossShare: 0.01, keepEventLog: true },
			{
				onDelivered: (service, message) => {
					if (!service.startsWith("dispatch-")) return;
					const view = viewOf(service);
					switch (message.type) {
						case "clock.ticked":
							viewsAtTick.set(service, new Map(view));
							break;
						case "drivers.went_online":
						case "drivers.moved":
							forEachDriverAt(message, (driverIndex, x, y) => {
								const cell = cellAt(x, y);
								if (regionOfCell(cell) !== message.region)
									crossingMovesDelivered++;
								view.set(driverIdAt(message.fleetSize, driverIndex), cell);
							});
							break;
						case "offer_declined":
							view.set(message.driverId, message.idleAt);
							break;
						case "driver.arrived_at_pickup":
						case "driver.arrived_at_dropoff":
						case "confirm_trip":
							view.set(message.driverId, message.cell);
							break;
						case "driver.went_offline":
							view.set(message.driverId, null);
							break;
					}
				},
				onMessage: (message) => {
					if (message.type === "drivers.moved") {
						forEachMove(message, (_, cell) => {
							if (regionOfCell(cell) !== message.region) crossingMoves++;
						});
					}
					if (message.type !== "offer") return;
					const region = regionOfCell(message.pickup);
					const cell = viewsAtTick
						.get(`dispatch-${region}`)
						?.get(message.driverId);
					if (!cell || regionOfCell(cell) !== region)
						offersOutside.push(message.tripId);
				},
			},
		);

		expect({
			violations: checkInvariants(eventLog, regionsConfig.grid),
			crossingMovesLost: crossingMoves > crossingMovesDelivered,
			offersOutside,
		}).toEqual({ violations: [], crossingMovesLost: true, offersOutside: [] });
	}, 30_000);

	// ADR 0050: one dispatch per region, each matching only its region's idle
	// drivers. Without loss every instance knows a driver's last cell. It
	// matches on clock.ticked t, before that tick's moves reach it, so each
	// offer goes to a driver last seen in the pickup's region by tick t - 1.
	test.each<[string, Matching]>([
		["greedy", { type: "greedy" }],
		["batched", { type: "batched", windowTicks: 5 }],
	])(
		"a 2x2 %s run breaks no invariant and each region offers its trips only to drivers last seen in it",
		(_, matching) => {
			const { eventLog } = runInProcess({
				...regionsConfig,
				matching,
				keepEventLog: true,
			});

			const lastCells = new Map<string, Cell>();
			const cellsThisTick = new Map<string, Cell>();
			const offeredRegions = new Set<number>();
			const offersOutside: string[] = [];
			for (const message of eventLog) {
				switch (message.type) {
					case "clock.ticked":
						for (const [driverId, cell] of cellsThisTick)
							lastCells.set(driverId, cell);
						cellsThisTick.clear();
						break;
					case "drivers.went_online":
					case "drivers.moved":
						forEachDriverAt(message, (driverIndex, x, y) =>
							cellsThisTick.set(
								driverIdAt(message.fleetSize, driverIndex),
								cellAt(x, y),
							),
						);
						break;
					case "offer": {
						const region = regionOfCell(message.pickup);
						const cell = lastCells.get(message.driverId);
						offeredRegions.add(region);
						if (cell === undefined || regionOfCell(cell) !== region)
							offersOutside.push(message.tripId);
						break;
					}
				}
			}
			expect({
				violations: checkInvariants(eventLog, regionsConfig.grid),
				offeredRegions: [...offeredRegions].toSorted(),
				offersOutside,
			}).toEqual({
				violations: [],
				offeredRegions: [0, 1, 2, 3],
				offersOutside: [],
			});
		},
		30_000,
	);

	test("publishes clock.ticked for ticks 1..N in order", () => {
		const { eventLog } = runInProcess({ ...quietConfig, keepEventLog: true });

		const ticks = eventLog.flatMap((message) =>
			message.type === "clock.ticked" ? [message.tick] : [],
		);
		expect<number[]>(ticks).toEqual([1, 2, 3]);
	});

	test("tells the caller each tick once it is done, in order", () => {
		const done: number[] = [];

		runInProcess(quietConfig, { onTickDone: (tick) => done.push(tick) });

		expect(done).toEqual([1, 2, 3]);
	});

	test("shows the caller the message count so far at each done tick", () => {
		const seen: Message[] = [];
		const counts: { seen: number; soFar: number }[] = [];

		runInProcess(quietConfig, {
			onMessage: (message) => seen.push(message),
			onTickDone: (_tick, soFar) =>
				counts.push({ seen: seen.length, soFar: soFar.messageCount }),
		});

		expect(counts.map((count) => count.soFar)).toEqual(
			counts.map((count) => count.seen),
		);
	});

	test("keeps no event log unless asked", () => {
		expect("eventLog" in runInProcess(quietConfig)).toBe(false);
	});

	test("counts every message without keeping the log", () => {
		expect(runInProcess(busyConfig).messageCount).toBe(
			runInProcess({ ...busyConfig, keepEventLog: true }).eventLog.length,
		);
	});

	test("shows the caller each message in publish order", () => {
		const seen: Message[] = [];

		const { eventLog } = runInProcess(
			{ ...busyConfig, keepEventLog: true },
			{ onMessage: (message) => seen.push(message) },
		);

		expect(seen).toEqual(eventLog);
	});

	// ADR 0033: what `bun run sim` prints without keeping the log.
	test("a summary fed during a run equals the summary of its event log", () => {
		const live = createSummary(scarceConfig);

		const result = runInProcess(
			{ ...scarceConfig, keepEventLog: true },
			{ onMessage: live.observe },
		);

		expect(live.result(result.rejected.length)).toEqual(
			summarize(scarceConfig, result),
		);
	});

	test("starts every driver of every shard online at tick 0, before the first tick", () => {
		const { eventLog } = runInProcess({ ...quietConfig, keepEventLog: true });

		const start: unknown[][] = eventLog.slice(0, 3).map((message) => {
			if (message.type !== "drivers.went_online") return [message.type];
			const driverIds: string[] = [];
			forEachWentOnline(message, (driverId) => driverIds.push(driverId));
			return [message.type, message.tick, driverIds];
		});
		expect(start).toEqual([
			["drivers.went_online", 0, ["d-0", "d-1"]],
			["drivers.went_online", 0, ["d-2", "d-3"]],
			["clock.ticked"],
		]);
	});

	test("driver IDs sort in shard order under plain string comparison", () => {
		const { eventLog } = runInProcess({
			keepEventLog: true,
			...quietConfig,
			ticks: 0,
			driverShards: { count: 2, driversPerShard: 6 },
		});

		const driverIds: string[] = [];
		for (const message of eventLog) {
			if (message.type !== "drivers.went_online") continue;
			forEachWentOnline(message, (driverId) => driverIds.push(driverId));
		}
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

type Overdue = { id: string; since: number; stage: string };

// Arrivals whose driver did not report again (moved, arrived, went offline)
// within bound ticks. Only the driver's own reports count: a trip event it
// missed would otherwise end a wait the driver never left. Arrivals too close
// to the run's end to tell are skipped.
function longWaits(
	eventLog: readonly Message[],
	ticks: number,
	bound: number,
): Overdue[] {
	const waiting = new Map<string, Overdue>();
	const overdue: Overdue[] = [];
	const resolve = (driverId: string, tick: number) => {
		const wait = waiting.get(driverId);
		if (wait === undefined) return;
		waiting.delete(driverId);
		if (tick - wait.since > bound) overdue.push(wait);
	};
	for (const message of eventLog) {
		switch (message.type) {
			case "driver.arrived_at_pickup":
			case "driver.arrived_at_dropoff":
				resolve(message.driverId, message.tick);
				waiting.set(message.driverId, {
					id: message.driverId,
					since: message.tick,
					stage: message.type,
				});
				break;
			case "drivers.moved":
				forEachMove(message, (driverId) => resolve(driverId, message.tick));
				break;
			case "driver.went_offline":
				resolve(message.driverId, message.tick);
				break;
		}
	}
	for (const wait of waiting.values()) {
		if (ticks - wait.since > bound) overdue.push(wait);
	}
	return overdue;
}

// Trips that stayed matched or picked up longer than bound ticks. Stages
// begun too close to the run's end to tell are skipped.
function longTripStages(
	eventLog: readonly Message[],
	ticks: number,
	bound: number,
): Overdue[] {
	const active = new Map<string, Overdue>();
	const overdue: Overdue[] = [];
	const end = (tripId: string, tick: number) => {
		const stage = active.get(tripId);
		if (stage === undefined) return;
		active.delete(tripId);
		if (tick - stage.since > bound) overdue.push(stage);
	};
	for (const message of eventLog) {
		switch (message.type) {
			case "trip.matched":
			case "trip.picked_up":
				end(message.tripId, message.tick);
				active.set(message.tripId, {
					id: message.tripId,
					since: message.tick,
					stage: message.type,
				});
				break;
			case "trip.completed":
			case "trip.cancelled":
				end(message.tripId, message.tick);
				break;
		}
	}
	for (const stage of active.values()) {
		if (ticks - stage.since > bound) overdue.push(stage);
	}
	return overdue;
}

// Integration tests need a real server: `docker compose up -d --wait`, then
// NATS_URL from .env (Bun loads it) or the environment. The runs publish on
// sim.>, so nothing else (e.g. `bun run dev`) may run on the same server.
const natsUrl = z.url().optional().parse(Bun.env.NATS_URL);
if (!natsUrl) {
	console.warn("NATS_URL unset: skipping distributed run tests");
}

describe.skipIf(!natsUrl)("runOverNats", () => {
	async function runOnServer(
		config: RunConfig,
	): Promise<RunResult & { eventLog: Message[] }> {
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

	// ADR 0050: one dispatch connection per region, each taking only its
	// region's subjects. Offers for pickups in both halves show both work.
	test("a 2x1 run breaks no invariant and both regions offer trips", async () => {
		const config = {
			...regionsConfig,
			ticks: 600,
			regions: { columns: 2, rows: 1 },
		};
		const { eventLog } = await runOnServer(config);

		const offerRegions = new Set<number>();
		for (const message of eventLog) {
			if (message.type !== "offer") continue;
			offerRegions.add(regionOf(config.regions, config.grid, message.pickup));
		}
		expect({
			violations: checkInvariants(eventLog, config.grid),
			offerRegions: [...offerRegions].toSorted(),
		}).toEqual({ violations: [], offerRegions: [0, 1] });
	}, 60_000);

	// ADR 0054: prices reach riders over NATS; which update a rider saw at a
	// spawn varies between runs, the invariants don't.
	test("a surge run breaks no invariant, surges zones, declines riders and prices trips", async () => {
		const { eventLog } = await runOnServer({ ...surgeConfig, ticks: 600 });

		expect({
			violations: checkInvariants(eventLog, surgeConfig.grid),
			...surgeSeen(eventLog),
		}).toEqual({
			violations: [],
			surging: true,
			declined: true,
			priced: true,
		});
	}, 60_000);

	test("a scarce-supply run breaks no invariant, completes and cancels trips", async () => {
		const { eventLog } = await runOnServer(scarceConfig);

		expect({
			violations: checkInvariants(eventLog, scarceConfig.grid),
			completed: eventLog.some((message) => message.type === "trip.completed"),
			cancelled: eventLog.some((message) => message.type === "trip.cancelled"),
		}).toEqual({ violations: [], completed: true, cancelled: true });
	}, 60_000);
});
