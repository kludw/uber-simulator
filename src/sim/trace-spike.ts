// SPIKE (#327): prints every trip event and offer of one driver (TRACE_DRIVER)
// for a run with `bun run sim` args, with trip.requested of its trips.
import type { Matching } from "../dispatch/brain.ts";
import type { Message } from "../shared/messages.ts";
import { parseSimArgs } from "./args.ts";
import { runInProcess } from "./run.ts";

const args = parseSimArgs(Bun.argv.slice(2));
if (!args.ok) throw new Error(args.error.message);
const { config, windowTicks } = args.value;
const matching: Matching =
	args.value.matching === "batched"
		? { type: "batched", windowTicks }
		: { type: "greedy" };
const driver = process.env.TRACE_DRIVER;
const requested = new Map<string, Message>();
let tick = 0;
runInProcess(
	{ ...config, matching },
	{
		onMessage: (message) => {
			if (message.type === "clock.ticked") tick = message.tick;
			if (message.type === "trip.requested") {
				requested.set(message.tripId, message);
			}
			if (!("driverId" in message) || message.driverId !== driver) return;
			if (message.type === "trip.offered" && "tripId" in message) {
				console.log(JSON.stringify(requested.get(message.tripId)));
			}
			console.log(tick, JSON.stringify(message));
		},
	},
);
