// SPIKE (#339): one in-process run with `bun run sim` args, earnings per
// SPIKE_* env (src/shared/earnings.ts); prints one JSON line of metrics.
// Imports only what master has, so the same file runs on master for the
// event-log hash.
import type { Matching } from "../dispatch/brain.ts";
import { driverIndexOf } from "../shared/fleet.ts";
import {
	type DriverId,
	forEachWentOnline,
	type Message,
	type Tick,
	type TripId,
} from "../shared/messages.ts";
import { createRandom } from "../shared/random.ts";
import { baseSurge, fareOf } from "../shared/surge.ts";
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
const { count: shards, driversPerShard } = config.driverShards;
const fleetSize = shards * driversPerShard;
const share = Number(Bun.env.SPIKE_SHARE ?? "0.75");
const targetMin = Math.round(Number(Bun.env.SPIKE_TARGET_MIN ?? "15") * 100);
const targetMax = Math.round(Number(Bun.env.SPIKE_TARGET_MAX ?? "30") * 100);

// The driver shard's target draw, recomputed (src/shared/earnings.ts).
function targetOf(driverId: DriverId): number {
	const index = driverIndexOf(driverId) ?? 0;
	const shard = Math.floor(index / driversPerShard);
	return createRandom(config.seed)
		.child(`driver-shard-${shard}`)
		.child(`earnings:${driverId}`)
		.int(targetMin, targetMax);
}

const checker = createInvariantChecker(config.grid);
const hasher = new Bun.CryptoHasher("sha256");
const requested = new Map<
	TripId,
	{ tick: Tick; fare: number; pickedUp: boolean }
>();
let completed = 0;
let cancelled = 0;
let declined = 0;
let pickups = 0;
let waitTicks = 0;
let revenue = 0;
let faresOnCompleted = 0;
let fareMismatches = 0;
// Driver share by driver index, whole run; and since the driver went online.
const earned = new Float64Array(fleetSize);
const sinceOnline = new Float64Array(fleetSize);
const periods: number[] = [];
let periodsAtTarget = 0;
let earnedMismatches = 0;
let online = 0;
let onlineTickSum = 0;
let lastTick = 0;

const result = runInProcess(
	{ ...config, matching, lossShare: Number(Bun.env.SPIKE_LOSS ?? "0") },
	{
		onMessage: (message: Message) => {
			hasher.update(JSON.stringify(message));
			checker.observe(message);
			switch (message.type) {
				case "clock.ticked":
					if (lastTick > 0) onlineTickSum += online;
					lastTick = message.tick;
					break;
				case "drivers.went_online":
					forEachWentOnline(message, () => {
						online++;
					});
					break;
				case "driver.went_offline": {
					online--;
					const i = driverIndexOf(message.driverId) ?? 0;
					if (message.earned === undefined) break;
					periods.push(message.earned);
					if (message.earned !== Math.round(sinceOnline[i] ?? 0)) {
						earnedMismatches++;
					}
					if (message.earned >= targetOf(message.driverId)) periodsAtTarget++;
					sinceOnline[i] = 0;
					break;
				}
				case "rider.declined_surge":
					declined++;
					break;
				case "trip.requested":
					requested.set(message.tripId, {
						tick: message.tick,
						fare: message.fare ?? fareOf(message, baseSurge),
						pickedUp: false,
					});
					break;
				case "trip.picked_up": {
					const trip = requested.get(message.tripId);
					if (trip === undefined || trip.pickedUp) break;
					trip.pickedUp = true;
					pickups++;
					waitTicks += message.tick - trip.tick;
					break;
				}
				case "trip.completed": {
					completed++;
					const trip = requested.get(message.tripId);
					requested.delete(message.tripId);
					const fare = message.fare ?? trip?.fare ?? 0;
					if (message.fare !== undefined) faresOnCompleted++;
					if (message.fare !== undefined && message.fare !== trip?.fare)
						fareMismatches++;
					revenue += fare;
					const i = driverIndexOf(message.driverId) ?? 0;
					const cut = Math.round(fare * share);
					earned[i] = (earned[i] ?? 0) + cut;
					sinceOnline[i] = (sinceOnline[i] ?? 0) + cut;
					break;
				}
				case "trip.cancelled":
					cancelled++;
					requested.delete(message.tripId);
					break;
			}
		},
	},
);
onlineTickSum += online;

const sorted = Float64Array.from(earned).sort();
const quantile = (values: ArrayLike<number>, q: number) =>
	values.length === 0
		? null
		: Math.round(
				values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0,
			) / 100;
// Gini of per-driver run earnings over the whole fleet.
function gini(values: Float64Array): number {
	let weighted = 0;
	let total = 0;
	for (let i = 0; i < values.length; i++) {
		weighted += (i + 1) * (values[i] ?? 0);
		total += values[i] ?? 0;
	}
	const n = values.length;
	return total === 0 ? 0 : (2 * weighted) / (n * total) - (n + 1) / n;
}
const periodsSorted = periods.toSorted((a, b) => a - b);
const round = (n: number, digits = 1) => Number(n.toFixed(digits));
console.log(
	JSON.stringify({
		earnings: Bun.env.SPIKE_EARNINGS === "on" ? "on" : "off",
		completed,
		cancelled,
		declined,
		meanWait: round(waitTicks / pickups),
		revenue: revenue / 100,
		meanOnline: round(onlineTickSum / lastTick),
		faresOnCompleted,
		fareMismatches,
		driverEarnings: Math.round(sorted.reduce((a, b) => a + b, 0)) / 100,
		perDriver: {
			p10: quantile(sorted, 0.1),
			p50: quantile(sorted, 0.5),
			p90: quantile(sorted, 0.9),
			zero: sorted.filter((value) => value === 0).length,
			gini: round(gini(sorted), 3),
		},
		periods: periods.length,
		periodP50: quantile(periodsSorted, 0.5),
		periodMean:
			periods.length === 0
				? null
				: round(periods.reduce((a, b) => a + b, 0) / periods.length / 100, 2),
		periodsAtTarget,
		earnedMismatches,
		violations: checker.violations().length,
		rejected: result.rejected.length,
		sha256: hasher.digest("hex"),
	}),
);
