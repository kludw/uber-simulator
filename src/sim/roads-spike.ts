// SPIKE (#335): one in-process run with `bun run sim` args, roads per
// SPIKE_ROADS (src/shared/roads.ts); prints one JSON line of metrics.
import type { Matching } from "../dispatch/brain.ts";
import type { Message, Tick, TripId } from "../shared/messages.ts";
import { parseSimArgs } from "./args.ts";
import { createInvariantChecker } from "./invariants.ts";
import { runInProcess } from "./run.ts";

const args = parseSimArgs(Bun.argv.slice(2));
if (!args.ok) {
	console.error(args.error.message);
	process.exit(2);
}
const { config, windowTicks } = args.value;
const matching: Matching =
	args.value.matching === "batched"
		? { type: "batched", windowTicks }
		: { type: "greedy" };

const checker = createInvariantChecker(config.grid);
const hasher = new Bun.CryptoHasher("sha256");
const requestedAt = new Map<TripId, Tick>();
const pickedAt = new Map<TripId, Tick>();
let completed = 0;
let cancelled = 0;
let declined = 0;
let pickups = 0;
let waitTicks = 0;
let rideTicks = 0;
let pooled = 0;
let fares = 0;

const started = performance.now();
runInProcess(
	{ ...config, matching, lossShare: Number(process.env.SPIKE_LOSS ?? "0") },
	{
		onMessage: (message: Message) => {
			hasher.update(JSON.stringify(message));
			checker.observe(message);
			switch (message.type) {
				case "rider.declined_surge":
					declined++;
					break;
				case "trip.requested":
					requestedAt.set(message.tripId, message.tick);
					if (message.pooled) pooled++;
					if (message.fare !== undefined) fares += message.fare;
					break;
				case "trip.picked_up": {
					const at = requestedAt.get(message.tripId);
					pickedAt.set(message.tripId, message.tick);
					if (at === undefined) break;
					pickups++;
					waitTicks += message.tick - at;
					break;
				}
				case "trip.completed": {
					completed++;
					const at = pickedAt.get(message.tripId);
					if (at !== undefined) rideTicks += message.tick - at;
					requestedAt.delete(message.tripId);
					pickedAt.delete(message.tripId);
					break;
				}
				case "trip.cancelled":
					cancelled++;
					requestedAt.delete(message.tripId);
					break;
			}
		},
	},
);

const round = (n: number, digits = 1) => Number(n.toFixed(digits));
const violations = checker.violations();
console.log(
	JSON.stringify({
		roads: process.env.SPIKE_ROADS ?? "off",
		completed,
		cancelled,
		declined,
		pooled,
		meanWait: round(waitTicks / pickups),
		meanRide: round(rideTicks / completed),
		violations: violations.length,
		firstViolation: violations[0]?.type,
		wallSeconds: round((performance.now() - started) / 1000),
		sha256: hasher.digest("hex").slice(0, 16),
	}),
);
