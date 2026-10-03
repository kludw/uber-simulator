import { describe, expect, test } from "bun:test";
import { RunId, Tick } from "../shared/messages.ts";
import { parseReplayArgs } from "./args.ts";

describe("parseReplayArgs", () => {
	test("a run replays from its first tick in real time by default", () => {
		expect(parseReplayArgs(["--run", "run-1"])).toEqual({
			ok: true,
			value: { runId: RunId.parse("run-1"), speed: 1, fromTick: undefined },
		});
	});

	test("speed and start tick are set per replay", () => {
		expect(
			parseReplayArgs(["--run", "run-1", "--speed", "2.5", "--from-tick", "0"]),
		).toEqual({
			ok: true,
			value: {
				runId: RunId.parse("run-1"),
				speed: 2.5,
				fromTick: Tick.parse(0),
			},
		});
	});

	test.each([
		["no run", []],
		["a run id that isn't a subject token", ["--run", "run.1"]],
		["a speed of zero", ["--run", "r", "--speed", "0"]],
		["a speed that isn't a number", ["--run", "r", "--speed", "fast"]],
		["a negative start tick", ["--run", "r", "--from-tick", "-1"]],
		["a fractional start tick", ["--run", "r", "--from-tick", "1.5"]],
		["an unknown option", ["--run", "r", "--loop"]],
	])("%s is invalid", (_, argv) => {
		expect(parseReplayArgs(argv)).toMatchObject({
			ok: false,
			error: { type: "invalid_args" },
		});
	});
});
