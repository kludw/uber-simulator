// Which events the page watches, from its query string (ADR 0034): live
// without parameters, a stored run's replay with ?replay=<runId>.
import { RunId } from "../shared/messages.ts";
import type { Result } from "../shared/result.ts";

export type Subscription = { subject: string; label: string };

export type SubscriptionError = { type: "invalid_replay_run_id" };

export function subscriptionFor(
	search: string,
): Result<Subscription, SubscriptionError> {
	const replay = new URLSearchParams(search).get("replay");
	if (replay === null) {
		return { ok: true, value: { subject: "sim.events.>", label: "live" } };
	}
	// A RunId is one subject token, so the value can't add tokens or wildcards.
	const runId = RunId.safeParse(replay);
	if (!runId.success) {
		return { ok: false, error: { type: "invalid_replay_run_id" } };
	}
	return {
		ok: true,
		value: {
			// Same prefix as replaySubject in src/replay/replay.ts, which the
			// browser bundle can't import (it pulls in the Node NATS transport).
			subject: `replay.${runId.data}.sim.events.>`,
			label: `replay ${runId.data}`,
		},
	};
}
