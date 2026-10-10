// SPIKE (#327): one in-process run with `bun run sim` args, pooling per
// SPIKE_POOL* env (src/shared/pool.ts); prints one JSON line of metrics.
import type { Matching } from "../dispatch/brain.ts";
import { distance, type Cell } from "../shared/grid.ts";
import type { DriverId, Message, Tick, TripId } from "../shared/messages.ts";
import { spikePool } from "../shared/pool.ts";
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
const runConfig = {
	...config,
	matching,
	lossShare: Number(process.env.SPIKE_LOSS ?? "0"),
};
const drivers = config.driverShards.count * config.driverShards.driversPerShard;

const checker = createInvariantChecker(config.grid);
const hasher = new Bun.CryptoHasher("sha256");
type TripInfo = {
	pickup: Cell;
	dropoff: Cell;
	requestedAt: Tick;
	pickedUpAt?: Tick;
	fare: number;
	pooled: boolean;
	shared: boolean;
	driverId?: DriverId;
};
const trips = new Map<TripId, TripInfo>();
const active = new Map<DriverId, TripId[]>();
const aboard = new Map<DriverId, { count: number; since: number }>();
// Adds the driver's load since its last change, then applies delta.
function changeLoad(driverId: DriverId, tick: number, delta: number): void {
	const load = aboard.get(driverId) ?? { count: 0, since: tick };
	if (load.count > 0) {
		occupiedTicks += tick - load.since;
		riderTicks += load.count * (tick - load.since);
	}
	load.count += delta;
	load.since = tick;
	aboard.set(driverId, load);
}
let requested = 0;
let pooledRequested = 0;
let completed = 0;
let cancelled = 0;
let declined = 0;
let revenue = 0;
let pickups = 0;
let waitTicks = 0;
let rides = 0;
let rideTicks = 0;
let detourSum = 0;
let sharedRides = 0;
let sharedRideTicks = 0;
let sharedDetourSum = 0;
let sharedCompleted = 0;
// Shared trips riding over 1.5 x direct (+ slack ticks), and the worst ratio.
const slack = Number(process.env.SPIKE_SLACK ?? "2");
let overLimit = 0;
let overLimitNoSlack = 0;
let worstRatio = 0;
let occupiedTicks = 0;
let riderTicks = 0;

const result = runInProcess(runConfig, {
	onMessage: (message: Message) => {
		hasher.update(JSON.stringify(message));
		checker.observe(message);
		switch (message.type) {
			case "rider.declined_surge":
				declined++;
				break;
			case "trip.requested": {
				requested++;
				const pooled = message.pooled === true;
				if (pooled) pooledRequested++;
				const base = fareOf(message.pickup, message.dropoff, baseSurge);
				const fare =
					message.fare ??
					(pooled ? Math.round(base * spikePool.fareFactor) : base);
				trips.set(message.tripId, {
					pickup: message.pickup,
					dropoff: message.dropoff,
					requestedAt: message.tick,
					fare,
					pooled,
					shared: false,
				});
				break;
			}
			case "trip.matched": {
				const trip = trips.get(message.tripId);
				if (trip === undefined) break;
				trip.driverId = message.driverId;
				const others = active.get(message.driverId) ?? [];
				for (const other of others) {
					const partner = trips.get(other);
					if (partner !== undefined) partner.shared = true;
					trip.shared = true;
				}
				active.set(message.driverId, [...others, message.tripId]);
				break;
			}
			case "trip.picked_up": {
				const trip = trips.get(message.tripId);
				if (trip === undefined) break;
				trip.pickedUpAt = message.tick;
				pickups++;
				waitTicks += message.tick - trip.requestedAt;
				changeLoad(message.driverId, message.tick, 1);
				break;
			}
			case "trip.completed": {
				completed++;
				const trip = trips.get(message.tripId);
				if (trip === undefined) break;
				revenue += trip.fare;
				if (trip.pickedUpAt !== undefined) {
					const ride = message.tick - trip.pickedUpAt;
					const direct = distance(trip.pickup, trip.dropoff);
					rides++;
					rideTicks += ride;
					detourSum += ride / direct - 1;
					if (trip.shared) {
						if (ride > 1.5 * direct + slack) { overLimit++; if (process.env.SPIKE_DEBUG) console.error(JSON.stringify({ tripId: message.tripId, driverId: message.driverId, ride, direct, pickedUpAt: trip.pickedUpAt, pickup: trip.pickup, dropoff: trip.dropoff })); }
						if (ride > 1.5 * direct) overLimitNoSlack++;
						worstRatio = Math.max(worstRatio, ride / direct);
						sharedRides++;
						sharedRideTicks += ride;
						sharedDetourSum += ride / direct - 1;
					}
				}
				if (trip.shared) sharedCompleted++;
				changeLoad(message.driverId, message.tick, -1);
				endTrip(message.driverId, message.tripId);
				break;
			}
			case "trip.cancelled":
				cancelled++;
				if (message.driverId !== null) {
					endTrip(message.driverId, message.tripId);
				}
				trips.delete(message.tripId);
				break;
		}
	},
});

function endTrip(driverId: DriverId, tripId: TripId): void {
	const left = (active.get(driverId) ?? []).filter((id) => id !== tripId);
	if (left.length === 0) active.delete(driverId);
	else active.set(driverId, left);
	trips.delete(tripId);
}

for (const driverId of aboard.keys()) changeLoad(driverId, config.ticks, 0);
const round = (n: number, digits = 1) => Number(n.toFixed(digits));
console.log(
	JSON.stringify({
		pool: spikePool.on ? spikePool : "off",
		requested,
		pooledRequested,
		declined,
		completed,
		cancelled,
		sharedCompleted,
		meanWait: round(waitTicks / pickups),
		meanRide: round(rideTicks / rides),
		meanDetourPct: round((100 * detourSum) / rides),
		sharedMeanRide: sharedRides === 0 ? null : round(sharedRideTicks / sharedRides),
		sharedDetourPct:
			sharedRides === 0 ? null : round((100 * sharedDetourSum) / sharedRides),
		overLimit,
		overLimitNoSlack,
		worstRatio: round(worstRatio, 2),
		occupiedPct: round((100 * occupiedTicks) / (drivers * config.ticks)),
		ridersPerOccupiedTick: round(riderTicks / Math.max(occupiedTicks, 1), 3),
		revenue: round(revenue / 100, 2),
		rejected: result.rejected.length,
		violations: checker.violations().length,
		firstViolation: checker.violations()[0] ?? null,
		logHash: hasher.digest("hex").slice(0, 16),
	}),
);
