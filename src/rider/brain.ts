import { distance, type Grid, randomCell } from "../shared/grid.ts";
import type {
	ClockTicked,
	RequestTrip,
	RiderId,
	Tick,
	TripId,
} from "../shared/messages.ts";
import type { Random } from "../shared/random.ts";

// Riding comes with trip outcomes (out of scope so far).
type Rider = {
	state: "waiting";
	id: RiderId;
	tripId: TripId;
	requestedAt: Tick;
	patience: number;
};

// spawned: riders spawned so far; numbers both rider and trip IDs.
export type RidersState = {
	grid: Grid;
	requestsPerMinute: number;
	spawned: number;
	riders: Rider[];
};

export type RidersInput = ClockTicked;

type RidersOutput = RequestTrip;

type Decision = { state: RidersState; outputs: RidersOutput[] };

export function startRiders(config: {
	grid: Grid;
	requestsPerMinute: number;
}): RidersState {
	return {
		grid: config.grid,
		requestsPerMinute: config.requestsPerMinute,
		spawned: 0,
		riders: [],
	};
}

export function decideRiders(
	state: RidersState,
	input: RidersInput,
	random: Random,
): Decision {
	switch (input.type) {
		case "clock.ticked":
			return onTick(state, input, random);
		default: {
			const unhandled: never = input.type;
			throw new Error(`unhandled riders input: ${unhandled}`);
		}
	}
}

function onTick(
	state: RidersState,
	input: ClockTicked,
	random: Random,
): Decision {
	// Children keyed by tick: the same label would replay the same draws every tick.
	const demand = random.child(`demand:${input.tick}`);
	const patience = random.child(`patience:${input.tick}`);
	const spawnCount = poisson(state.requestsPerMinute / 60, demand);
	let spawned = state.spawned;
	const riders = [...state.riders];
	const outputs: RidersOutput[] = [];
	for (let i = 0; i < spawnCount; i++) {
		spawned++;
		const pickup = randomCell(state.grid, demand);
		let dropoff = randomCell(state.grid, demand);
		while (distance(pickup, dropoff) === 0) {
			dropoff = randomCell(state.grid, demand);
		}
		const rider: Rider = {
			state: "waiting",
			id: `r-${spawned}` as RiderId,
			tripId: `t-${spawned}` as TripId,
			requestedAt: input.tick,
			patience: patience.int(120, 300),
		};
		riders.push(rider);
		outputs.push({
			type: "request_trip",
			tick: input.tick,
			tripId: rider.tripId,
			riderId: rider.id,
			pickup,
			dropoff,
		});
	}
	return { state: { ...state, spawned, riders }, outputs };
}

// Knuth's method: fine for the small per-tick means used here.
function poisson(mean: number, random: Random): number {
	const limit = Math.exp(-mean);
	let count = 0;
	let product = random.float();
	while (product > limit) {
		count++;
		product *= random.float();
	}
	return count;
}
