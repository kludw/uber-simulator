import type { Tick, TripId } from "../shared/messages.ts";
import { checkInvariants, type Violation } from "./invariants.ts";
import type { runInProcess } from "./run.ts";

export type Summary = {
	seed: number;
	ticks: number;
	drivers: number;
	trips: { requested: number; completed: number; cancelled: number };
	// null when no trip was picked up.
	meanTicksToPickup: number | null;
	rejectedInputs: number;
	violations: Violation[];
};

export function summarize(
	config: Parameters<typeof runInProcess>[0],
	result: ReturnType<typeof runInProcess>,
): Summary {
	const trips = { requested: 0, completed: 0, cancelled: 0 };
	const requestedAt = new Map<TripId, Tick>();
	let pickups = 0;
	let ticksToPickup = 0;
	for (const message of result.eventLog) {
		switch (message.type) {
			case "trip.requested":
				trips.requested++;
				requestedAt.set(message.tripId, message.tick);
				break;
			case "trip.picked_up": {
				const at = requestedAt.get(message.tripId);
				if (at === undefined) break;
				pickups++;
				ticksToPickup += message.tick - at;
				break;
			}
			case "trip.completed":
				trips.completed++;
				break;
			case "trip.cancelled":
				trips.cancelled++;
				break;
		}
	}
	const { count, driversPerShard } = config.driverShards;
	return {
		seed: config.seed,
		ticks: config.ticks,
		drivers: count * driversPerShard,
		trips,
		meanTicksToPickup: pickups === 0 ? null : ticksToPickup / pickups,
		rejectedInputs: result.rejected.length,
		violations: checkInvariants(result.eventLog, config.grid),
	};
}
