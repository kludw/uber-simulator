// `bun run loadtest` arguments (src/loadtest/main.ts): the fleet and run
// length of one load test of the distributed stack (ADR 0037).
import { parseArgs } from "node:util";
import * as z from "zod";
import type { Matching } from "../dispatch/brain.ts";
import type { Result } from "../shared/result.ts";
import type { SimConfig } from "../sim/services.ts";

// Message is for the terminal: parseArgs and Zod both describe the problem.
export type InvalidArgs = { type: "invalid_args"; message: string };

const integerArg = z
	.string()
	.regex(z.regexes.integer, { error: "expected an integer" })
	.transform(Number);

const Args = z
	.strictObject({
		ticks: integerArg.pipe(z.int().positive()),
		drivers: integerArg.pipe(z.int().positive()),
		matching: z.enum(["greedy", "batched"]),
		"batch-window": integerArg.pipe(z.int().positive()),
		shards: integerArg.pipe(z.int().positive()),
		"drain-minutes": z
			.string()
			.regex(z.regexes.number, { error: "expected a number" })
			.transform(Number)
			.pipe(z.number().positive()),
		"nats-monitoring-url": z.url({ protocol: /^https?$/ }),
	})
	.refine((args) => args.drivers % args.shards === 0, {
		error: "--drivers must split evenly over --shards",
		path: ["drivers"],
	});

export type LoadtestArgs = Pick<
	SimConfig,
	"driverShards" | "requestsPerMinute"
> & {
	matching: Matching;
	ticks: number;
	// How long to wait after tick T for the persister's backlog to empty.
	drainBoundMs: number;
	// NATS HTTP monitoring (/varz, /connz).
	natsMonitoringUrl: string;
};

export function parseLoadtestArgs(
	argv: string[],
): Result<LoadtestArgs, InvalidArgs> {
	let values: ReturnType<typeof parseArgs>["values"];
	try {
		values = parseArgs({
			args: argv,
			options: {
				ticks: { type: "string", default: "600" },
				drivers: { type: "string", default: "1000" },
				matching: { type: "string", default: "greedy" },
				"batch-window": { type: "string", default: "5" },
				// Spec shard count (docs/spec.md).
				shards: { type: "string", default: "2" },
				"drain-minutes": { type: "string", default: "5" },
				// compose.yaml's monitoring port.
				"nats-monitoring-url": {
					type: "string",
					default: "http://localhost:8222",
				},
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
			ticks: args.ticks,
			driverShards: {
				count: args.shards,
				driversPerShard: args.drivers / args.shards,
			},
			// Spec ratio (docs/spec.md): 10 requests/min per 100 drivers, rounded
			// since REQUESTS_PER_MINUTE is an integer.
			requestsPerMinute: Math.round(args.drivers / 10),
			matching:
				args.matching === "batched"
					? { type: "batched", windowTicks: args["batch-window"] }
					: { type: "greedy" },
			drainBoundMs: args["drain-minutes"] * 60_000,
			natsMonitoringUrl: args["nats-monitoring-url"],
		},
	};
}
