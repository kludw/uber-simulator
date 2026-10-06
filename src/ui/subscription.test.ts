import { describe, expect, test } from "bun:test";
import { Cell } from "../shared/grid.ts";
import { DriverId, driversMoved, RunId, Tick } from "../shared/messages.ts";
import { replaySubject } from "../shared/subjects.ts";
import { subscriptionFor } from "./subscription.ts";

// NATS subject matching (https://docs.nats.io/nats-concepts/subjects):
// `*` matches one token, a trailing `>` one or more.
function covers(wildcard: string, subject: string): boolean {
	const patternTokens = wildcard.split(".");
	const subjectTokens = subject.split(".");
	for (const [index, token] of patternTokens.entries()) {
		if (token === ">") return subjectTokens.length > index;
		if (token !== "*" && token !== subjectTokens[index]) return false;
	}
	return patternTokens.length === subjectTokens.length;
}

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

	test("a replay subscription receives what the replay publishes for its run", () => {
		const watched = subscriptionFor("?replay=run-42");
		if (!watched.ok) throw new Error("expected a subscription");
		const published = replaySubject(
			RunId.parse("run-42"),
			driversMoved(Tick.parse(3), [
				{ driverId: DriverId.parse("d-1"), cell: Cell.parse({ x: 0, y: 0 }) },
			]),
		);
		expect(covers(watched.value.subject, published)).toBe(true);
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
