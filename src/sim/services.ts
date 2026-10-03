import type { Bus } from "../bus/bus.ts";
import { startService } from "../bus/service.ts";
import {
	type DispatchInput,
	decideDispatch,
	type Matching,
	startDispatch,
} from "../dispatch/brain.ts";
import {
	type DriverShardInput,
	decideDriverShard,
	type Shifts,
	startDriverShard,
} from "../driver/brain.ts";
import { decideRiders, type RidersInput, startRiders } from "../rider/brain.ts";
import type { Demand } from "../rider/demand.ts";
import type { Grid } from "../shared/grid.ts";
import {
	DriverId,
	type InputRejected,
	type Message,
	Tick,
} from "../shared/messages.ts";
import { createRandom } from "../shared/random.ts";

// What every service of one simulation must agree on, whether they share a
// process (src/sim/run.ts) or not (src/*/main.ts).
export type SimConfig = {
	seed: number;
	grid: Grid;
	driverShards: { count: number; driversPerShard: number };
	requestsPerMinute: number;
	// Dispatch's strategy (ADR 0030); greedy when unset.
	matching?: Matching | undefined;
	// Riders' demand model (ADR 0031); uniform when unset.
	demand?: Demand | undefined;
	// Driver shards' shift model (ADR 0032); always online when unset.
	shifts?: Shifts | undefined;
};

export type Rejected = InputRejected<Message, string>;

// One service wired for the bus. The name labels its seed stream and its logs.
export type SimService = {
	name: string;
	start(bus: Bus, logRejected: (rejected: Rejected) => void): void;
};

// Services start before the clock's first tick (tick 1).
const startTick = Tick.parse(0);

export function driverShardService(
	config: SimConfig,
	shard: number,
): SimService {
	const { count, driversPerShard } = config.driverShards;
	if (!Number.isInteger(shard) || shard < 0 || shard >= count) {
		throw new Error(`shard ${shard} outside 0..${count - 1}`);
	}
	const name = `driver-shard-${shard}`;
	// Same IDs in every process: fixed by shard index and shard sizes, and
	// zero-padded so plain string order (ordered by ID) is numeric order.
	const idWidth = String(count * driversPerShard - 1).length;
	const driverIds = Array.from({ length: driversPerShard }, (_, i) =>
		DriverId.parse(
			`d-${String(shard * driversPerShard + i).padStart(idWidth, "0")}`,
		),
	);
	const owned = new Set<string>(driverIds);
	return {
		name,
		start(bus, logRejected) {
			const random = createRandom(config.seed).child(name);
			startService(bus, {
				start: startDriverShard(
					{
						grid: config.grid,
						driverIds,
						tick: startTick,
						shifts: config.shifts,
					},
					random,
				),
				accepts: (message): message is DriverShardInput => {
					switch (message.type) {
						// The brain throws on offers for drivers it doesn't own.
						case "offer":
							return owned.has(message.driverId);
						case "clock.ticked":
						case "trip.picked_up":
						case "trip.completed":
						case "trip.cancelled":
						case "trip.offer_expired":
							return true;
						default:
							return false;
					}
				},
				decide: decideDriverShard,
				random,
				log: logRejected,
			});
		},
	};
}

export function dispatchService(config: SimConfig): SimService {
	const name = "dispatch";
	return {
		name,
		start(bus, logRejected) {
			startService(bus, {
				// Bare-state start: dispatch publishes nothing when it starts.
				start: {
					state: startDispatch({
						grid: config.grid,
						tick: startTick,
						matching: config.matching,
					}),
					outputs: [],
				},
				accepts: (message): message is DispatchInput => {
					switch (message.type) {
						case "clock.ticked":
						case "request_trip":
						case "cancel_trip":
						case "driver.went_online":
						case "driver.went_offline":
						case "driver.moved":
						case "driver.arrived_at_pickup":
						case "driver.arrived_at_dropoff":
						case "offer_accepted":
						case "offer_declined":
							return true;
						default:
							return false;
					}
				},
				decide: decideDispatch,
				random: createRandom(config.seed).child(name),
				log: logRejected,
			});
		},
	};
}

export function ridersService(config: SimConfig): SimService {
	const name = "riders";
	return {
		name,
		start(bus, logRejected) {
			startService(bus, {
				start: {
					state: startRiders({
						grid: config.grid,
						requestsPerMinute: config.requestsPerMinute,
						demand: config.demand,
					}),
					outputs: [],
				},
				// request_trip_accepted / cancel_trip_accepted: no subscriber, dropped.
				accepts: (message): message is RidersInput => {
					switch (message.type) {
						case "clock.ticked":
						case "trip.picked_up":
						case "trip.completed":
						case "trip.cancelled":
						case "request_trip_rejected":
						case "cancel_trip_rejected":
							return true;
						default:
							return false;
					}
				},
				decide: decideRiders,
				random: createRandom(config.seed).child(name),
				log: logRejected,
			});
		},
	};
}
