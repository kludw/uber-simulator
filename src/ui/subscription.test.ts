import { describe, expect, test } from "bun:test";
import { subscriptionFor } from "./subscription.ts";

describe("subscriptionFor", () => {
	test("watches live events without a replay parameter", () => {
		expect(subscriptionFor("")).toEqual({
			ok: true,
			value: { subject: "sim.events.>", label: "live" },
		});
	});

	test("watches a stored run's replay subjects with ?replay=<runId>", () => {
		expect(subscriptionFor("?replay=run-42")).toEqual({
			ok: true,
			value: {
				subject: "replay.run-42.sim.events.>",
				label: "replay run-42",
			},
		});
	});

	test.each([
		["empty", "?replay="],
		["extra subject tokens", "?replay=run-1.sim"],
		["a wildcard", "?replay=%3E"],
	])("rejects a replay run id with %s", (_, search) => {
		expect(subscriptionFor(search)).toEqual({
			ok: false,
			error: { type: "invalid_replay_run_id" },
		});
	});
});
