// `bun run sim` arguments (src/sim/main.ts), parsed into a run config.
import { parseArgs } from "node:util";
import * as z from "zod";
import { specGrid } from "../shared/grid.ts";
import { RegionLayout } from "../shared/regions.ts";
import type { Result } from "../shared/result.ts";
import {
	DemandName,
	demandNamed,
	PreferencesName,
	preferencesNamed,
	ShiftsName,
	SurgeName,
	shiftsNamed,
} from "./config.ts";
import type { RunConfig } from "./run.ts";

export type SimArgs = {
	bus: "in-memory" | "nats";
	// Greedy and batched on the same config, side by side (ADR 0030).
	compare: boolean;
	// The configured matching with surge off and on, side by side (ADR 0054).
	compareSurge: boolean;
	matching: "greedy" | "batched";
	// Batched only.
	windowTicks: number;
	// For the printed summary; config.demand is the model it names.
	demandName: z.infer<typeof DemandName>;
	// For the printed summary; config.shifts is the model it names.
	shiftsName: z.infer<typeof ShiftsName>;
	// For the printed summary; config.preferences is the model it names.
	preferencesName: z.infer<typeof PreferencesName>;
	config: Omit<RunConfig, "matching">;
};

// Message is for the terminal: parseArgs and Zod both describe the problem.
export type InvalidArgs = { type: "invalid_args"; message: string };

const integerArg = z
	.string()
	.regex(z.regexes.integer, { error: "expected an integer" })
	.transform(Number);

const Args = z
	.strictObject({
		// createRandom folds the seed to 32 bits; larger seeds would alias.
		seed: integerArg.pipe(
			z
				.int()
				.min(0)
				.max(2 ** 32 - 1),
		),
		ticks: integerArg.pipe(z.int().positive()),
		bus: z.enum(["in-memory", "nats"]),
		matching: z.enum(["greedy", "batched"]),
		"batch-window": integerArg.pipe(z.int().positive()),
		compare: z.boolean(),
		"compare-surge": z.boolean(),
		surge: SurgeName,
		demand: DemandName,
		shifts: ShiftsName,
		preferences: PreferencesName,
		"requests-per-minute": integerArg.pipe(z.int().min(0)),
		"drivers-per-shard": integerArg.pipe(z.int().positive()),
		regions: RegionLayout,
	})
	.refine((args) => !(args.compare && args.bus === "nats"), {
		error: "--compare runs in process only",
		path: ["compare"],
	})
	.refine((args) => !(args["compare-surge"] && args.bus === "nats"), {
		error: "--compare-surge runs in process only",
		path: ["compare-surge"],
	})
	.refine((args) => !(args.compare && args["compare-surge"]), {
		error: "--compare and --compare-surge are exclusive",
		path: ["compare-surge"],
	})
	.refine(
		({ regions }) =>
			regions.columns <= specGrid.width && regions.rows <= specGrid.height,
		{ error: "more regions than grid cells across", path: ["regions"] },
	);

export function parseSimArgs(argv: string[]): Result<SimArgs, InvalidArgs> {
	let values: ReturnType<typeof parseArgs>["values"];
	try {
		values = parseArgs({
			args: argv,
			options: {
				seed: { type: "string", default: "1" },
				// 1 simulated hour.
				ticks: { type: "string", default: "3600" },
				bus: { type: "string", default: "in-memory" },
				matching: { type: "string", default: "greedy" },
				"batch-window": { type: "string", default: "5" },
				compare: { type: "boolean", default: false },
				"compare-surge": { type: "boolean", default: false },
				// Off: no message carries a price (ADR 0054).
				surge: { type: "string", default: "off" },
				// Spec defaults (docs/spec.md).
				demand: { type: "string", default: "uniform" },
				shifts: { type: "string", default: "off" },
				preferences: { type: "string", default: "off" },
				"requests-per-minute": { type: "string", default: "10" },
				"drivers-per-shard": { type: "string", default: "50" },
				// One dispatch instance (ADR 0050).
				regions: { type: "string", default: "1x1" },
			},
			strict: true,
		}).values;
	} catch (error) {
		// parseArgs throws TypeError only for malformed argv.
		if (!(error instanceof TypeError)) throw error;
		return {
			ok: false,
			error: { type: "invalid_args", message: error.message },
		};
	}
	const parsed = Args.safeParse(values);
	if (!parsed.success) {
		return {
			ok: false,
			error: { type: "invalid_args", message: z.prettifyError(parsed.error) },
		};
	}
	const args = parsed.data;
	return {
		ok: true,
		value: {
			bus: args.bus,
			compare: args.compare,
			compareSurge: args["compare-surge"],
			matching: args.matching,
			windowTicks: args["batch-window"],
			demandName: args.demand,
			shiftsName: args.shifts,
			preferencesName: args.preferences,
			config: {
				seed: args.seed,
				ticks: args.ticks,
				grid: specGrid,
				// Spec shard count (docs/spec.md).
				driverShards: { count: 2, driversPerShard: args["drivers-per-shard"] },
				requestsPerMinute: args["requests-per-minute"],
				demand: demandNamed(args.demand),
				shifts: shiftsNamed(args.shifts),
				preferences: preferencesNamed(args.preferences),
				regions: args.regions,
				surge: args.surge === "on",
			},
		},
	};
}
