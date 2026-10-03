// `bun run sim` arguments (src/sim/main.ts), parsed into a run config.
import { parseArgs } from "node:util";
import * as z from "zod";
import { specGrid } from "../shared/grid.ts";
import type { Result } from "../shared/result.ts";
import { DemandName, demandNamed } from "./config.ts";
import type { RunConfig } from "./run.ts";

export type SimArgs = {
	bus: "in-memory" | "nats";
	// Greedy and batched on the same config, side by side (ADR 0030).
	compare: boolean;
	matching: "greedy" | "batched";
	// Batched only.
	windowTicks: number;
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
		demand: DemandName,
		"requests-per-minute": integerArg.pipe(z.int().min(0)),
		"drivers-per-shard": integerArg.pipe(z.int().positive()),
	})
	.refine((args) => !(args.compare && args.bus === "nats"), {
		error: "--compare runs in process only",
		path: ["compare"],
	});

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
				// Spec defaults (docs/spec.md).
				demand: { type: "string", default: "uniform" },
				"requests-per-minute": { type: "string", default: "10" },
				"drivers-per-shard": { type: "string", default: "50" },
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
			matching: args.matching,
			windowTicks: args["batch-window"],
			config: {
				seed: args.seed,
				ticks: args.ticks,
				grid: specGrid,
				// Spec shard count (docs/spec.md).
				driverShards: { count: 2, driversPerShard: args["drivers-per-shard"] },
				requestsPerMinute: args["requests-per-minute"],
				demand: demandNamed(args.demand),
			},
		},
	};
}
