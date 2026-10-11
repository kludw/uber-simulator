import { describe, expect, test } from "bun:test";
import { DriverIndex, driverIdAt } from "../shared/fleet.ts";
import { type Cell, cellIn, type Grid } from "../shared/grid.ts";
import {
	driversMoved,
	driversWentOnline,
	type Message,
	RiderId,
	Tick,
	TripId,
} from "../shared/messages.ts";
import { Region } from "../shared/regions.ts";
import { Fare, Surge } from "../shared/surge.ts";
import {
	compareSummaries,
	createSummary,
	createTripSummary,
	type Summary,
	summarize,
} from "./summary.ts";

const grid: Grid = { width: 10, height: 10 };
// Drivers of a fleet of 10: IDs d-0 to d-9 (ADR 0052).
const fleetSize = 10;
const i1 = DriverIndex.parse(1);
const d1 = driverIdAt(fleetSize, i1);
const r1 = RiderId.parse("r-1");
const t1 = TripId.parse("t-1");
const t2 = TripId.parse("t-2");
const t3 = TripId.parse("t-3");

const config = {
	seed: 42,
	ticks: 20,
	grid,
	driverShards: { count: 2, driversPerShard: 3 },
	requestsPerMinute: 10,
};

function cell(x: number, y: number): Cell {
	const result = cellIn(grid, x, y);
	if (!result.ok) throw new Error(`test cell (${x}, ${y}) outside grid`);
	return result.value;
}

function tick(n: number): Tick {
	return Tick.parse(n);
}

function requested(tripId: TripId, at: number): Message {
	return {
		type: "trip.requested",
		tick: tick(at),
		tripId,
		riderId: r1,
		pickup: cell(1, 0),
		dropoff: cell(2, 0),
	};
}

function tripEvent(
	type: "trip.offered" | "trip.matched" | "trip.picked_up" | "trip.completed",
	tripId: TripId,
	at: number,
): Message {
	return { type, tick: tick(at), tripId, driverId: d1 };
}

// d1 starts at (0,0). t1 requested at 1, picked up at 2 (1 tick), completed.
// t2 requested at 4, cancelled before any offer. t3 requested at 6, still
// waiting at the end.
const eventLog: Message[] = [
	driversWentOnline(tick(0), Region.parse(0), fleetSize, [
		{ driverIndex: i1, cell: cell(0, 0) },
	]),
	requested(t1, 1),
	tripEvent("trip.offered", t1, 1),
	tripEvent("trip.matched", t1, 1),
	driversMoved(tick(2), Region.parse(0), fleetSize, [
		{ driverIndex: i1, cell: cell(1, 0) },
	]),
	tripEvent("trip.picked_up", t1, 2),
	driversMoved(tick(3), Region.parse(0), fleetSize, [
		{ driverIndex: i1, cell: cell(2, 0) },
	]),
	tripEvent("trip.completed", t1, 3),
	requested(t2, 4),
	{ type: "trip.cancelled", tick: tick(5), tripId: t2, driverId: null },
	requested(t3, 6),
];

describe("summarize", () => {
	test("counts trips requested, completed, and cancelled", () => {
		const summary = summarize(config, { eventLog, rejected: [] });

		expect(summary.trips).toEqual({ requested: 3, completed: 1, cancelled: 1 });
	});

	// Waits of 1 and 4 ticks; t3 never picked up, so it doesn't count.
	test("averages ticks from request to pickup over picked-up trips", () => {
		const waits: Message[] = [
			requested(t1, 1),
			requested(t2, 3),
			requested(t3, 3),
			tripEvent("trip.picked_up", t1, 2),
			tripEvent("trip.picked_up", t2, 7),
		];

		const summary = summarize(config, { eventLog: waits, rejected: [] });

		expect(summary.meanTicksToPickup).toBe(2.5);
	});

	test("has no mean ticks to pickup when no trip was picked up", () => {
		const summary = summarize(config, {
			eventLog: [requested(t1, 1)],
			rejected: [],
		});

		expect(summary.meanTicksToPickup).toBeNull();
	});

	test("reports seed, ticks, drivers across shards, and rejected inputs", () => {
		const rejected = [
			{
				service: "dispatch",
				rejected: {
					type: "input_rejected" as const,
					reason: "unknown_trip",
					input: eventLog[1] as Message,
				},
			},
		];

		const summary = summarize(config, { eventLog, rejected });

		expect({
			seed: summary.seed,
			ticks: summary.ticks,
			drivers: summary.drivers,
			rejectedInputs: summary.rejectedInputs,
		}).toEqual({ seed: 42, ticks: 20, drivers: 6, rejectedInputs: 1 });
	});

	test("a clean log has no invariant violations", () => {
		expect(summarize(config, { eventLog, rejected: [] }).violations).toEqual(
			[],
		);
	});

	test("reports invariant violations in the log", () => {
		const completedTwice = [...eventLog, tripEvent("trip.completed", t1, 7)];

		const summary = summarize(config, {
			eventLog: completedTwice,
			rejected: [],
		});

		expect(summary.violations).toEqual([
			{
				type: "illegal_trip_transition",
				tick: tick(7),
				tripId: t1,
				from: "completed",
				event: "trip.completed",
			},
		]);
	});
});

// ADR 0054: revenue is the fares of completed trips; a trip without one
// (surge off) counts at base fare.
describe("summarize surge", () => {
	const priced: Message = {
		type: "trip.requested",
		tick: tick(1),
		tripId: t1,
		riderId: r1,
		pickup: cell(1, 0),
		dropoff: cell(2, 0),
		surge: Surge.parse(1.5),
		fare: Fare.parse(378),
	};

	test("revenue sums the fares of completed trips only", () => {
		const log: Message[] = [
			priced,
			tripEvent("trip.offered", t1, 1),
			tripEvent("trip.matched", t1, 1),
			tripEvent("trip.picked_up", t1, 2),
			tripEvent("trip.completed", t1, 3),
			{ ...priced, tripId: t2, fare: Fare.parse(1000) },
			{ ...priced, tripId: t3, fare: Fare.parse(2000) },
			{ type: "trip.cancelled", tick: tick(5), tripId: t3, driverId: null },
		];

		expect(summarize(config, { eventLog: log, rejected: [] }).revenue).toBe(
			378,
		);
	});

	// pickup (1,0) to dropoff (2,0): 250 + 2 x 1 cents.
	test("a completed trip without a fare counts at base fare", () => {
		expect(summarize(config, { eventLog, rejected: [] }).revenue).toBe(252);
	});

	test("counts riders declined", () => {
		const declined = (riderId: string, at: number): Message => ({
			type: "rider.declined_surge",
			tick: tick(at),
			riderId: RiderId.parse(riderId),
			pickup: cell(1, 0),
			surge: Surge.parse(2),
		});

		const summary = summarize(config, {
			eventLog: [declined("r-2", 1), declined("r-3", 2)],
			rejected: [],
		});

		expect(summary.declined).toBe(2);
	});
});

// ADR 0056: trips pooled, trips shared (completed trips that had another
// trip on their driver while active), ticks from pickup to completion.
describe("summarize pooling", () => {
	const t4 = TripId.parse("t-4");

	function pooled(tripId: TripId, at: number): Message {
		return {
			type: "trip.requested",
			tick: tick(at),
			tripId,
			riderId: r1,
			pickup: cell(1, 0),
			dropoff: cell(2, 0),
			pooled: true,
		};
	}

	function onDriver(
		type: "trip.matched" | "trip.picked_up" | "trip.completed",
		tripId: TripId,
		at: number,
		driverIndex = i1,
	): Message {
		return {
			type,
			tick: tick(at),
			tripId,
			driverId: driverIdAt(fleetSize, driverIndex),
		};
	}

	const i2 = DriverIndex.parse(2);

	// t1 and t2 share d1 (t2 joins while t1 rides); t3 rides d1 after both
	// ended, alone; t4 rides d2 alongside t1's time on d1, alone.
	const log: Message[] = [
		pooled(t1, 1),
		pooled(t2, 1),
		requested(t3, 1),
		pooled(t4, 1),
		onDriver("trip.matched", t1, 1),
		onDriver("trip.matched", t4, 1, i2),
		onDriver("trip.picked_up", t1, 2),
		onDriver("trip.matched", t2, 3),
		onDriver("trip.picked_up", t2, 4),
		onDriver("trip.picked_up", t4, 4, i2),
		onDriver("trip.completed", t1, 6),
		onDriver("trip.completed", t2, 10),
		onDriver("trip.completed", t4, 10, i2),
		onDriver("trip.matched", t3, 11),
		onDriver("trip.picked_up", t3, 12),
		onDriver("trip.completed", t3, 14),
	];

	test("counts trips pooled", () => {
		expect(summarize(config, { eventLog: log, rejected: [] }).pooled).toBe(3);
	});

	test("counts completed trips that had another trip on their driver as shared", () => {
		expect(summarize(config, { eventLog: log, rejected: [] }).shared).toBe(2);
	});

	// A trip cancelled while t1 rides makes t1 shared, but is not completed.
	test("a cancelled trip is never shared", () => {
		const cancelledJoin: Message[] = [
			pooled(t1, 1),
			pooled(t2, 1),
			onDriver("trip.matched", t1, 1),
			onDriver("trip.matched", t2, 2),
			{ type: "trip.cancelled", tick: tick(3), tripId: t2, driverId: d1 },
			onDriver("trip.picked_up", t1, 4),
			onDriver("trip.completed", t1, 6),
		];

		expect(
			summarize(config, { eventLog: cancelledJoin, rejected: [] }).shared,
		).toBe(1);
	});

	// Rides of 4 (t1), 6 (t2), 6 (t4), 2 (t3).
	test("averages ticks from pickup to completion over completed trips", () => {
		expect(
			summarize(config, { eventLog: log, rejected: [] }).meanTicksToComplete,
		).toBe(4.5);
	});

	test("has no mean ticks to completion when no trip was completed", () => {
		expect(
			summarize(config, { eventLog: [pooled(t1, 1)], rejected: [] })
				.meanTicksToComplete,
		).toBeNull();
	});

	// pickup (1,0) to dropoff (2,0): round((250 + 2 x 1) x 0.75) cents.
	test("a completed pooled trip without a fare counts at the pooled base fare", () => {
		expect(
			summarize(config, { eventLog: log.slice(0, 11), rejected: [] }).revenue,
		).toBe(189);
	});
});

describe("createSummary", () => {
	test("summarizes the messages observed as they come", () => {
		const summary = createSummary(config);
		for (const message of eventLog) summary.observe(message);

		expect(summary.result(2)).toEqual({
			seed: 42,
			ticks: 20,
			drivers: 6,
			trips: { requested: 3, completed: 1, cancelled: 1 },
			meanTicksToPickup: 1,
			declined: 0,
			// t1 at base fare: 250 + 2 x 1 cell.
			revenue: 252,
			pooled: 0,
			shared: 0,
			meanTicksToComplete: 1,
			rejectedInputs: 2,
			violations: [],
		});
	});
});

describe("createTripSummary", () => {
	test("counts trips and mean ticks to pickup without a run config", () => {
		const summary = createTripSummary();
		for (const message of eventLog) summary.observe(message);

		expect(summary.result()).toEqual({
			trips: { requested: 3, completed: 1, cancelled: 1 },
			meanTicksToPickup: 1,
		});
	});
});

describe("compareSummaries", () => {
	const greedy: Summary = {
		seed: 42,
		ticks: 3600,
		drivers: 100,
		trips: { requested: 600, completed: 550, cancelled: 20 },
		meanTicksToPickup: 101.25,
		declined: 0,
		revenue: 432_150,
		pooled: 0,
		shared: 0,
		meanTicksToComplete: 300.04,
		rejectedInputs: 0,
		violations: [],
	};
	const batched: Summary = {
		...greedy,
		trips: { requested: 600, completed: 548, cancelled: 25 },
		meanTicksToPickup: null,
		declined: 25,
		revenue: 1_234_567,
		pooled: 290,
		shared: 180,
		meanTicksToComplete: null,
		violations: [
			{
				type: "illegal_trip_transition",
				tick: tick(7),
				tripId: t1,
				from: "completed",
				event: "trip.completed",
			},
		],
	};

	test("lines up each headline number of both runs", () => {
		expect(
			compareSummaries(greedy, batched, { surge: false, pooling: false }),
		).toEqual([
			{ metric: "trips requested", first: "600", second: "600" },
			{ metric: "trips completed", first: "550", second: "548" },
			{ metric: "trips cancelled", first: "20", second: "25" },
			{
				metric: "mean ticks from request to pickup",
				first: "101.3",
				second: "n/a",
			},
			{ metric: "invariant violations", first: "0", second: "1" },
		]);
	});

	// ADR 0054: --compare-surge's rows.
	test("with surge adds riders declined and revenue in dollars", () => {
		expect(
			compareSummaries(greedy, batched, { surge: true, pooling: false }),
		).toEqual([
			{ metric: "trips requested", first: "600", second: "600" },
			{ metric: "riders declined", first: "0", second: "25" },
			{ metric: "trips completed", first: "550", second: "548" },
			{ metric: "trips cancelled", first: "20", second: "25" },
			{
				metric: "mean ticks from request to pickup",
				first: "101.3",
				second: "n/a",
			},
			{ metric: "revenue", first: "$4,321.50", second: "$12,345.67" },
			{ metric: "invariant violations", first: "0", second: "1" },
		]);
	});

	// ADR 0056: --compare-pooling's rows.
	test("with pooling adds trips pooled and shared, ride ticks and revenue", () => {
		expect(
			compareSummaries(greedy, batched, { surge: false, pooling: true }),
		).toEqual([
			{ metric: "trips requested", first: "600", second: "600" },
			{ metric: "trips pooled", first: "0", second: "290" },
			{ metric: "trips completed", first: "550", second: "548" },
			{ metric: "trips shared", first: "0", second: "180" },
			{ metric: "trips cancelled", first: "20", second: "25" },
			{
				metric: "mean ticks from request to pickup",
				first: "101.3",
				second: "n/a",
			},
			{
				metric: "mean ticks from pickup to completion",
				first: "300.0",
				second: "n/a",
			},
			{ metric: "revenue", first: "$4,321.50", second: "$12,345.67" },
			{ metric: "invariant violations", first: "0", second: "1" },
		]);
	});

	test("with surge and pooling adds both sets of rows, revenue once", () => {
		expect(
			compareSummaries(greedy, batched, { surge: true, pooling: true }).map(
				(row) => row.metric,
			),
		).toEqual([
			"trips requested",
			"riders declined",
			"trips pooled",
			"trips completed",
			"trips shared",
			"trips cancelled",
			"mean ticks from request to pickup",
			"mean ticks from pickup to completion",
			"revenue",
			"invariant violations",
		]);
	});
});
