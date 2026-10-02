import { createInMemoryBus } from "../bus/in-memory.ts";
import { startService } from "../bus/service.ts";
import {
	type DispatchInput,
	decideDispatch,
	startDispatch,
} from "../dispatch/brain.ts";
import {
	type DriverShardInput,
	decideDriverShard,
	startDriverShard,
} from "../driver/brain.ts";
import { decideRiders, type RidersInput, startRiders } from "../rider/brain.ts";
import type { Grid } from "../shared/grid.ts";
import {
	DriverId,
	type InputRejected,
	type Message,
	Tick,
} from "../shared/messages.ts";
import { createRandom } from "../shared/random.ts";

type Rejected = { service: string; rejected: InputRejected<Message, string> };

export type RunConfig = {
	seed: number;
	ticks: number;
	grid: Grid;
	driverShards: { count: number; driversPerShard: number };
	requestsPerMinute: number;
};

export type RunResult = { eventLog: Message[]; rejected: Rejected[] };

// Runs every service over one in-memory bus, the runner acting as clock
// (ADR 0027). Same config gives the same eventLog.
export function runInProcess(config: RunConfig): RunResult {
	const bus = createInMemoryBus();
	const eventLog: Message[] = [];
	const rejected: Rejected[] = [];
	bus.subscribe(
		(message): message is Message => true,
		(message) => eventLog.push(message),
	);
	const root = createRandom(config.seed);
	const startTick = Tick.parse(0);

	const { count, driversPerShard } = config.driverShards;
	// Zero-padded so plain string order (ordered by ID) is numeric order.
	const idWidth = String(count * driversPerShard - 1).length;
	for (let shard = 0; shard < count; shard++) {
		const service = `driver-shard-${shard}`;
		const random = root.child(service);
		const driverIds = Array.from({ length: driversPerShard }, (_, i) =>
			DriverId.parse(
				`d-${String(shard * driversPerShard + i).padStart(idWidth, "0")}`,
			),
		);
		const owned = new Set<string>(driverIds);
		startService(bus, {
			start: startDriverShard(
				{ grid: config.grid, driverIds, tick: startTick },
				random,
			),
			accepts: (message): message is DriverShardInput => {
				switch (message.type) {
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
			log: (input) => rejected.push({ service, rejected: input }),
		});
	}
	startService(bus, {
		// Bare-state start: dispatch publishes nothing when it starts.
		start: {
			state: startDispatch({ grid: config.grid, tick: startTick }),
			outputs: [],
		},
		accepts: (message): message is DispatchInput => {
			switch (message.type) {
				case "clock.ticked":
				case "request_trip":
				case "cancel_trip":
				case "driver.went_online":
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
		random: root.child("dispatch"),
		log: (input) => rejected.push({ service: "dispatch", rejected: input }),
	});

	startService(bus, {
		start: {
			state: startRiders({
				grid: config.grid,
				requestsPerMinute: config.requestsPerMinute,
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
		random: root.child("riders"),
		log: (input) => rejected.push({ service: "riders", rejected: input }),
	});
	bus.drain();

	for (let tick = 1; tick <= config.ticks; tick++) {
		bus.publish({ type: "clock.ticked", tick: Tick.parse(tick) });
		bus.drain();
	}
	return { eventLog, rejected };
}
