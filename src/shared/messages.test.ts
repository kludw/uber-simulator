import { expect, test } from "bun:test";
import type { DispatchInput, decideDispatch } from "../dispatch/brain.ts";
import type {
	DriverShardInput,
	decideDriverShard,
	startDriverShard,
} from "../driver/brain.ts";
import type { decideRiders, RidersInput } from "../rider/brain.ts";
import { type ClockTicked, type Message, Tick } from "./messages.ts";

type OutputOf<Brain extends (...args: never[]) => { outputs: unknown[] }> =
	ReturnType<Brain>["outputs"][number];

type BrainMessage = Exclude<
	| DriverShardInput
	| DispatchInput
	| RidersInput
	| OutputOf<typeof startDriverShard>
	| OutputOf<typeof decideDriverShard>
	| OutputOf<typeof decideDispatch>
	| OutputOf<typeof decideRiders>,
	{ type: "input_rejected" }
>;

// The real check is `bun run typecheck`: this fails to compile when a brain
// consumes or publishes a type missing from Message.
const asMessage = (message: BrainMessage): Message => message;

test("every brain input and output is a Message", () => {
	const ticked: ClockTicked = { type: "clock.ticked", tick: Tick.parse(1) };
	expect(asMessage(ticked)).toBe(ticked);
});
