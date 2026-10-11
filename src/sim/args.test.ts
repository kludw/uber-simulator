import { describe, expect, test } from "bun:test";
import { cityDemand } from "../rider/demand.ts";
import { parseSimArgs } from "./args.ts";

describe("parseSimArgs", () => {
	test("no args run one simulated hour in process at the spec defaults", () => {
		expect(parseSimArgs([])).toEqual({
			ok: true,
			value: {
				bus: "in-memory",
				compare: false,
				compareSurge: false,
				comparePooling: false,
				matching: "greedy",
				windowTicks: 5,
				demandName: "uniform",
				shiftsName: "off",
				preferencesName: "off",
				config: {
					seed: 1,
					ticks: 3600,
					grid: { width: 500, height: 500 },
					driverShards: { count: 2, driversPerShard: 50 },
					requestsPerMinute: 10,
					demand: { type: "uniform" },
					shifts: { type: "always_online" },
					preferences: { type: "accept_all" },
					regions: { columns: 1, rows: 1 },
					surge: false,
					pooling: false,
				},
			},
		});
	});

	// ADR 0050: one dispatch instance per region.
	test("--regions splits dispatch into columns x rows regions", () => {
		expect(parseSimArgs(["--regions", "2x2"])).toMatchObject({
			ok: true,
			value: { config: { regions: { columns: 2, rows: 2 } } },
		});
	});

	// ADR 0054.
	test("--surge on prices trips with zone surge", () => {
		expect(parseSimArgs(["--surge", "on"])).toMatchObject({
			ok: true,
			value: { config: { surge: true } },
		});
	});

	test("--compare-surge runs surge off and on side by side", () => {
		expect(parseSimArgs(["--compare-surge"])).toMatchObject({
			ok: true,
			value: { compareSurge: true },
		});
	});

	// ADR 0056.
	test("--pooling on lets riders opt in to pooling", () => {
		expect(parseSimArgs(["--pooling", "on"])).toMatchObject({
			ok: true,
			value: { config: { pooling: true } },
		});
	});

	test("--compare-pooling runs pooling off and on side by side", () => {
		expect(parseSimArgs(["--compare-pooling"])).toMatchObject({
			ok: true,
			value: { comparePooling: true },
		});
	});

	// One preset (ADR 0035): max pickup 20-80 cells (200-800 m), 10% other declines.
	test("--preferences picky runs drivers on the picky preset", () => {
		expect(parseSimArgs(["--preferences", "picky"])).toMatchObject({
			ok: true,
			value: {
				preferencesName: "picky",
				config: {
					preferences: {
						type: "picky",
						maxPickupDistance: { min: 20, max: 80 },
						declineShare: 0.1,
					},
				},
			},
		});
	});

	// One preset (ADR 0032): 20-40 min online, 5-15 min offline, 80% online at start.
	test("--shifts on runs drivers on the shift preset", () => {
		expect(parseSimArgs(["--shifts", "on"])).toMatchObject({
			ok: true,
			value: {
				shiftsName: "on",
				config: {
					shifts: {
						type: "shifts",
						onlineTicks: { min: 1200, max: 2400 },
						offlineTicks: { min: 300, max: 900 },
						startOnlineShare: 0.8,
					},
				},
			},
		});
	});

	test("demand, load and fleet size are set per run", () => {
		const parsed = parseSimArgs([
			"--demand",
			"city",
			"--requests-per-minute",
			"30",
			"--drivers-per-shard",
			"25",
		]);

		expect(parsed).toMatchObject({
			ok: true,
			value: {
				demandName: "city",
				config: {
					driverShards: { count: 2, driversPerShard: 25 },
					requestsPerMinute: 30,
					demand: cityDemand,
				},
			},
		});
	});

	test.each([
		[["--demand", "rush_hour"]],
		[["--shifts", "yes"]],
		[["--preferences", "on"]],
		[["--requests-per-minute", "-1"]],
		[["--requests-per-minute", "ten"]],
		[["--drivers-per-shard", "0"]],
		[["--seed", "1.5"]],
		[["--compare", "--bus", "nats"]],
		[["--compare-surge", "--bus", "nats"]],
		[["--compare", "--compare-surge"]],
		[["--surge", "yes"]],
		[["--compare-pooling", "--bus", "nats"]],
		[["--compare", "--compare-pooling"]],
		[["--compare-surge", "--compare-pooling"]],
		[["--pooling", "yes"]],
		[["--regions", "2"]],
		// The spec grid is 500 cells wide and high.
		[["--regions", "501x1"]],
		[["--regions", "1x501"]],
		[["--unknown"]],
	])("rejects %p", (argv) => {
		expect(parseSimArgs(argv)).toMatchObject({
			ok: false,
			error: { type: "invalid_args" },
		});
	});
});
