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
				matching: "greedy",
				windowTicks: 5,
				config: {
					seed: 1,
					ticks: 3600,
					grid: { width: 500, height: 500 },
					driverShards: { count: 2, driversPerShard: 50 },
					requestsPerMinute: 10,
					demand: { type: "uniform" },
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
		[["--requests-per-minute", "-1"]],
		[["--requests-per-minute", "ten"]],
		[["--drivers-per-shard", "0"]],
		[["--seed", "1.5"]],
		[["--compare", "--bus", "nats"]],
		[["--unknown"]],
	])("rejects %p", (argv) => {
		expect(parseSimArgs(argv)).toMatchObject({
			ok: false,
			error: { type: "invalid_args" },
		});
	});
});
