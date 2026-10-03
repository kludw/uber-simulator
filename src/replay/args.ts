// `bun run replay` arguments (src/replay/main.ts).
import { parseArgs } from "node:util";
import * as z from "zod";
import { RunId, Tick } from "../shared/messages.ts";
import type { Result } from "../shared/result.ts";
import type { InvalidArgs } from "../sim/args.ts";

const Args = z.strictObject({
	// Parsed before any subject is built from it (ADR 0034).
	run: RunId,
	speed: z
		.string()
		.regex(z.regexes.number, { error: "expected a number" })
		.transform(Number)
		.pipe(z.number().positive()),
	"from-tick": z
		.string()
		.regex(z.regexes.integer, { error: "expected an integer" })
		.transform(Number)
		.pipe(Tick)
		.optional(),
});

export type ReplayArgs = {
	runId: RunId;
	// Sim seconds per wall second, like the clock's SPEED.
	speed: number;
	// Unset: from the run's first tick.
	fromTick: Tick | undefined;
};

export function parseReplayArgs(
	argv: string[],
): Result<ReplayArgs, InvalidArgs> {
	let values: ReturnType<typeof parseArgs>["values"];
	try {
		values = parseArgs({
			args: argv,
			options: {
				run: { type: "string" },
				speed: { type: "string", default: "1" },
				"from-tick": { type: "string" },
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
	return {
		ok: true,
		value: {
			runId: parsed.data.run,
			speed: parsed.data.speed,
			fromTick: parsed.data["from-tick"],
		},
	};
}
