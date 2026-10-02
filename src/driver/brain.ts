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
	Offer,
	OfferAccepted,
	OfferDeclined,
	Tick,
	TripId,
} from "../shared/messages.ts";
import type { Random } from "../shared/random.ts";

type Driver =
	| { state: "idle"; id: DriverId; cell: Cell; wanderTarget: Cell | null }
	| {
			state: "en_route";
			id: DriverId;
			cell: Cell;
			tripId: TripId;
			pickup: Cell;
			dropoff: Cell;
	  };

// Drivers kept sorted by ID: outputs and random draws follow that order.
export type DriverShardState = { grid: Grid; drivers: Driver[] };

export type DriverShardInput = ClockTicked | Offer;

export function startDriverShard(
	config: { grid: Grid; driverIds: DriverId[]; tick: Tick },
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
		tick: config.tick,
		driverId: driver.id,
		cell: driver.cell,
	}));
	return { state: { grid: config.grid, drivers }, outputs };
}

type DriverShardOutput = DriverMoved | OfferAccepted | OfferDeclined;

type Decision = { state: DriverShardState; outputs: DriverShardOutput[] };

export function decideDriverShard(
	state: DriverShardState,
	input: DriverShardInput,
	random: Random,
): Decision {
	switch (input.type) {
		case "clock.ticked":
			return onTick(state, input, random);
		case "offer":
			return onOffer(state, input);
		default: {
			const unhandled: never = input;
			throw new Error(`unhandled driver shard input: ${unhandled}`);
		}
	}
}

function onOffer(state: DriverShardState, offer: Offer): Decision {
	const offered = state.drivers.find((driver) => driver.id === offer.driverId);
	if (offered === undefined) {
		throw new Error(`offer for driver ${offer.driverId} outside this shard`);
	}
	if (offered.state !== "idle") {
		return {
			state,
			outputs: [
				{
					type: "offer_declined",
					tripId: offer.tripId,
					driverId: offer.driverId,
				},
			],
		};
	}
	const drivers = state.drivers.map(
		(driver): Driver =>
			driver.id === offer.driverId
				? {
						state: "en_route",
						id: driver.id,
						cell: driver.cell,
						tripId: offer.tripId,
						pickup: offer.pickup,
						dropoff: offer.dropoff,
					}
				: driver,
	);
	return {
		state: { ...state, drivers },
		outputs: [
			{
				type: "offer_accepted",
				tripId: offer.tripId,
				driverId: offer.driverId,
			},
		],
	};
}

function onTick(
	state: DriverShardState,
	input: ClockTicked,
	random: Random,
): Decision {
	const outputs: DriverShardOutput[] = [];
	const drivers: Driver[] = [];
	for (const driver of state.drivers) {
		if (driver.state !== "idle") {
			drivers.push(driver);
			continue;
		}
		const wanderTarget = driver.wanderTarget ?? randomCell(state.grid, random);
		if (distance(driver.cell, wanderTarget) === 0) {
			drivers.push({ ...driver, wanderTarget: null });
			continue;
		}
		const cell = stepToward(driver.cell, wanderTarget);
		outputs.push({
			type: "driver.moved",
			tick: input.tick,
			driverId: driver.id,
			cell,
		});
		const arrived = distance(cell, wanderTarget) === 0;
		drivers.push({
			...driver,
			cell,
			wanderTarget: arrived ? null : wanderTarget,
		});
	}
	return { state: { ...state, drivers }, outputs };
}
