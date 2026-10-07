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
	type Preferences,
	type Shifts,
	startDriverShard,
} from "../driver/brain.ts";
import { decideRiders, type RidersInput, startRiders } from "../rider/brain.ts";
import type { Demand } from "../rider/demand.ts";
import { DriverIndex, driverIdAt } from "../shared/fleet.ts";
import type { Grid } from "../shared/grid.ts";
import {
	type InputRejected,
	type Message,
	type MessageType,
	Tick,
} from "../shared/messages.ts";
import { createRandom } from "../shared/random.ts";
import type { Region, RegionLayout } from "../shared/regions.ts";

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
	// Driver shards' offer preferences (ADR 0035); accept all when unset.
	preferences?: Preferences | undefined;
	// Region layout, one dispatch instance per region (ADR 0050); one region
	// when unset.
	regions?: RegionLayout | undefined;
};

export type Rejected = InputRejected<Message, string>;

// One service wired for the bus. The name labels its seed stream and its logs.
// inputs: every message type it subscribes to, known before it starts so a
// NATS bus subscribes before anyone publishes (ADR 0042). region: the one
// region whose messages it takes (dispatch k, ADR 0050), known before it
// starts for the same reason; every region's when unset.
export type SimService = {
	name: string;
	inputs: readonly MessageType[];
	region?: Region;
	start(bus: Bus, logRejected: (rejected: Rejected) => void): void;
};

// What each brain takes (its Input type); the bus delivers nothing else.
const driverShardInputs = [
	"clock.ticked",
	"offer",
	"trip.picked_up",
	"trip.completed",
	"trip.cancelled",
	"trip.offer_expired",
	"trip_status",
] as const satisfies readonly DriverShardInput["type"][];

const dispatchInputs = [
	"clock.ticked",
	"request_trip",
	"cancel_trip",
	"drivers.went_online",
	"driver.went_offline",
	"drivers.moved",
	"driver.arrived_at_pickup",
	"driver.arrived_at_dropoff",
	"offer_accepted",
	"offer_declined",
	"confirm_trip",
] as const satisfies readonly DispatchInput["type"][];

// Not request_trip_accepted / cancel_trip_accepted: no service takes them.
const ridersInputs = [
	"clock.ticked",
	"trip.picked_up",
	"trip.completed",
	"trip.cancelled",
	"request_trip_rejected",
	"cancel_trip_rejected",
] as const satisfies readonly RidersInput["type"][];

// Compile-time completeness: true only when the list names every type of the
// brain's Input; a missed type would never reach the brain.
type Complete<Input extends Message, Listed extends MessageType> = [
	Exclude<Input["type"], Listed>,
] extends [never]
	? true
	: false;
const inputsComplete: [
	Complete<DriverShardInput, (typeof driverShardInputs)[number]>,
	Complete<DispatchInput, (typeof dispatchInputs)[number]>,
	Complete<RidersInput, (typeof ridersInputs)[number]>,
] = [true, true, true];
void inputsComplete;

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
	// Same drivers in every process: fixed by shard index and shard sizes
	// (ADR 0052).
	const fleetSize = count * driversPerShard;
	const firstIndex = DriverIndex.parse(shard * driversPerShard);
	const owned = new Set<string>(
		Array.from({ length: driversPerShard }, (_, i) =>
			driverIdAt(fleetSize, DriverIndex.parse(firstIndex + i)),
		),
	);
	return {
		name,
		inputs: driverShardInputs,
		start(bus, logRejected) {
			const random = createRandom(config.seed).child(name);
			startService(bus, {
				start: startDriverShard(
					{
						grid: config.grid,
						fleetSize,
						firstIndex,
						driverCount: driversPerShard,
						tick: startTick,
						shifts: config.shifts,
						preferences: config.preferences,
						regions: config.regions,
					},
					random,
				),
				inputs: driverShardInputs,
				// The brain throws on offers for drivers it doesn't own.
				accepts: (input) => input.type !== "offer" || owned.has(input.driverId),
				decide: decideDriverShard,
				random,
				log: logRejected,
			});
		},
	};
}

// One instance per region of config.regions (ADR 0050).
export function dispatchService(config: SimConfig, region: Region): SimService {
	const name = `dispatch-${region}`;
	return {
		name,
		inputs: dispatchInputs,
		region,
		start(bus, logRejected) {
			startService(bus, {
				// Bare-state start: dispatch publishes nothing when it starts.
				start: {
					state: startDispatch({
						grid: config.grid,
						tick: startTick,
						matching: config.matching,
						regions: config.regions,
						region,
					}),
					outputs: [],
				},
				inputs: dispatchInputs,
				region,
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
		inputs: ridersInputs,
		start(bus, logRejected) {
			startService(bus, {
				start: {
					state: startRiders({
						grid: config.grid,
						requestsPerMinute: config.requestsPerMinute,
						demand: config.demand,
						regions: config.regions,
					}),
					outputs: [],
				},
				inputs: ridersInputs,
				decide: decideRiders,
				random: createRandom(config.seed).child(name),
				log: logRejected,
			});
		},
	};
}
