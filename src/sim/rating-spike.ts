// SPIKE (#331): one in-process run with `bun run sim` args, ratings per
// SPIKE_* env (src/shared/rating.ts); prints one JSON line of metrics.
import type { Matching } from "../dispatch/brain.ts";
import { DriverIndex, driverIdAt } from "../shared/fleet.ts";
import type { DriverId, Message, Tick, TripId } from "../shared/messages.ts";
import { createRandom } from "../shared/random.ts";
import { driverQuality, spikeRatings } from "../shared/rating.ts";
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
const fleetSize =
	config.driverShards.count * config.driverShards.driversPerShard;

// Quality as the rider service sees it (same stream), on or off.
const riders = createRandom(config.seed).child("riders");
const quality = new Map<DriverId, number>();
for (let i = 0; i < fleetSize; i++) {
	const driverId = driverIdAt(fleetSize, DriverIndex.parse(i));
	quality.set(driverId, driverQuality(riders, driverId));
}
const { qualityMin, qualityMax } = spikeRatings;
const topFrom = qualityMin + 0.75 * (qualityMax - qualityMin);
const bottomBelow = qualityMin + 0.25 * (qualityMax - qualityMin);

const checker = createInvariantChecker(config.grid);
const hasher = new Bun.CryptoHasher("sha256");
const requestedAt = new Map<TripId, Tick>();
let completed = 0;
let cancelled = 0;
let declined = 0;
let pickups = 0;
let waitTicks = 0;
let qualityServed = 0;
let topTrips = 0;
let bottomTrips = 0;
let ratings = 0;
let stars = 0;
const histogram = [0, 0, 0, 0, 0];
const ratingSum = new Map<DriverId, number>();
const ratingCount = new Map<DriverId, number>();

const result = runInProcess(
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
					break;
				case "trip.picked_up": {
					const at = requestedAt.get(message.tripId);
					if (at === undefined) break;
					pickups++;
					waitTicks += message.tick - at;
					break;
				}
				case "trip.completed": {
					completed++;
					requestedAt.delete(message.tripId);
					const q = quality.get(message.driverId) ?? 0;
					qualityServed += q;
					if (q >= topFrom) topTrips++;
					if (q < bottomBelow) bottomTrips++;
					break;
				}
				case "trip.cancelled":
					cancelled++;
					requestedAt.delete(message.tripId);
					break;
				case "rider.rated_driver":
					ratings++;
					stars += message.stars;
					histogram[message.stars - 1] =
						(histogram[message.stars - 1] ?? 0) + 1;
					ratingSum.set(
						message.driverId,
						(ratingSum.get(message.driverId) ?? 0) + message.stars,
					);
					ratingCount.set(
						message.driverId,
						(ratingCount.get(message.driverId) ?? 0) + 1,
					);
					break;
			}
		},
	},
);

// Pearson correlation of rated drivers' average rating with their quality.
function correlation(): number | null {
	const xs: number[] = [];
	const ys: number[] = [];
	for (const [driverId, count] of ratingCount) {
		xs.push(quality.get(driverId) ?? 0);
		ys.push((ratingSum.get(driverId) ?? 0) / count);
	}
	if (xs.length < 2) return null;
	const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
	const mx = mean(xs);
	const my = mean(ys);
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (let i = 0; i < xs.length; i++) {
		const dx = (xs[i] ?? 0) - mx;
		const dy = (ys[i] ?? 0) - my;
		sxy += dx * dy;
		sxx += dx * dx;
		syy += dy * dy;
	}
	return sxy / Math.sqrt(sxx * syy);
}

const round = (n: number, digits = 1) => Number(n.toFixed(digits));
const r = correlation();
console.log(
	JSON.stringify({
		config: spikeRatings.on
			? {
					weight: spikeRatings.weight,
					prior: spikeRatings.priorCount,
					priorMean: spikeRatings.priorMean,
				}
			: "off",
		completed,
		cancelled,
		declined,
		meanWait: round(waitTicks / pickups),
		qualityServed: round(qualityServed / completed, 3),
		topSharePct: round((100 * topTrips) / completed),
		bottomSharePct: round((100 * bottomTrips) / completed),
		ratings: ratings,
		meanStars: ratings === 0 ? null : round(stars / ratings, 2),
		histogram,
		ratedDrivers: ratingCount.size,
		ratingQualityR: r === null ? null : round(r, 2),
		rejected: result.rejected.length,
		violations: checker.violations().length,
		firstViolation: checker.violations()[0] ?? null,
		logHash: hasher.digest("hex").slice(0, 16),
	}),
);
