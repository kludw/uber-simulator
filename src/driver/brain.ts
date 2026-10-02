import {
	type Cell,
	distance,
	type Grid,
	randomCell,
	stepToward,
} from "../shared/grid.ts";
import type {
	ClockTicked,
	DriverId,
	DriverMoved,
	DriverWentOnline,
} from "../shared/messages.ts";
import type { Random } from "../shared/random.ts";

type Driver = {
	state: "idle";
	id: DriverId;
	cell: Cell;
	wanderTarget: Cell | null;
};

// Drivers kept sorted by ID: outputs and random draws follow that order.
export type DriverShardState = { grid: Grid; drivers: Driver[] };

export type DriverShardInput = ClockTicked;

export function startDriverShard(
	config: { grid: Grid; driverIds: DriverId[] },
	random: Random,
): { state: DriverShardState; outputs: DriverWentOnline[] } {
	const drivers: Driver[] = config.driverIds.toSorted().map((id) => ({
		state: "idle",
		id,
		cell: randomCell(config.grid, random),
		wanderTarget: null,
	}));
	const outputs: DriverWentOnline[] = drivers.map((driver) => ({
		type: "driver.went_online",
		driverId: driver.id,
		cell: driver.cell,
	}));
	return { state: { grid: config.grid, drivers }, outputs };
}

export function decideDriverShard(
	state: DriverShardState,
	input: DriverShardInput,
	random: Random,
): { state: DriverShardState; outputs: DriverMoved[] } {
	const outputs: DriverMoved[] = [];
	const drivers = state.drivers.map((driver) => {
		const wanderTarget = driver.wanderTarget ?? randomCell(state.grid, random);
		if (distance(driver.cell, wanderTarget) === 0) {
			return { ...driver, wanderTarget: null };
		}
		const cell = stepToward(driver.cell, wanderTarget);
		outputs.push({
			type: "driver.moved",
			tick: input.tick,
			driverId: driver.id,
			cell,
		});
		const arrived = distance(cell, wanderTarget) === 0;
		return { ...driver, cell, wanderTarget: arrived ? null : wanderTarget };
	});
	return { state: { ...state, drivers }, outputs };
}
