// `bun run bench` arguments (src/bench/main.ts), parsed into the config of
// one in-process run at a given fleet size.
import { parseArgs } from "node:util";
import * as z from "zod";
import { specGrid } from "../shared/grid.ts";
import { RegionLayout } from "../shared/regions.ts";
import type { Result } from "../shared/result.ts";
import { SurgeName } from "../sim/config.ts";
import type { RunConfig } from "../sim/run.ts";

// Message is for the terminal: parseArgs and Zod both describe the problem.
export type InvalidArgs = { type: "invalid_args"; message: string };

const integerArg = z
	.string()
	.regex(z.regexes.integer, { error: "expected an integer" })
	.transform(Number);

const Args = z
	.strictObject({
		seed: integerArg.pipe(
			z
				.int()
				.min(0)
				.max(2 ** 32 - 1),
		),
		ticks: integerArg.pipe(z.int().positive()),
		drivers: integerArg.pipe(z.int().positive()),
		matching: z.enum(["greedy", "batched"]),
		"batch-window": integerArg.pipe(z.int().positive()),
		shards: integerArg.pipe(z.int().positive()),
		"max-minutes": z
			.string()
			.regex(z.regexes.number, { error: "expected a number" })
			.transform(Number)
			.pipe(z.number().positive())
			.optional(),
		regions: RegionLayout,
		surge: SurgeName,
	})
	.refine((args) => args.drivers % args.shards === 0, {
		error: "--drivers must split evenly over --shards",
		path: ["drivers"],
	})
	.refine(
		({ regions }) =>
			regions.columns <= specGrid.width && regions.rows <= specGrid.height,
		{ error: "more regions than grid cells across", path: ["regions"] },
	);

export type BenchArgs = {
	config: RunConfig;
	// Wall-time budget for the run; unlimited when undefined.
	maxMinutes: number | undefined;
};

export function parseBenchArgs(argv: string[]): Result<BenchArgs, InvalidArgs> {
	let values: ReturnType<typeof parseArgs>["values"];
	try {
		values = parseArgs({
			args: argv,
			options: {
				seed: { type: "string", default: "1" },
				ticks: { type: "string", default: "600" },
				drivers: { type: "string", default: "1000" },
				matching: { type: "string", default: "greedy" },
				"batch-window": { type: "string", default: "5" },
				// Spec shard count (docs/spec.md).
				shards: { type: "string", default: "2" },
				// No limit when unset.
				"max-minutes": { type: "string" },
				// One dispatch instance (ADR 0050).
				regions: { type: "string", default: "1x1" },
				// Off: no message carries a price (ADR 0054).
				surge: { type: "string", default: "off" },
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
			config: {
				seed: args.seed,
				ticks: args.ticks,
				grid: specGrid,
				driverShards: {
					count: args.shards,
					driversPerShard: args.drivers / args.shards,
				},
				// Spec ratio (docs/spec.md): 10 requests/min per 100 drivers.
				requestsPerMinute: args.drivers / 10,
				matching:
					args.matching === "batched"
						? { type: "batched", windowTicks: args["batch-window"] }
						: { type: "greedy" },
				demand: { type: "uniform" },
				shifts: { type: "always_online" },
				regions: args.regions,
				surge: args.surge === "on",
			},
			maxMinutes: args["max-minutes"],
		},
	};
}
