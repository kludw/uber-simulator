import {
	type Cell,
	distance,
	type Grid,
	randomCell,
	stepToward,
} from "../shared/grid.ts";
import type {
	ClockTicked,
	DriverArrivedAtDropoff,
	DriverArrivedAtPickup,
	DriverId,
	DriverMoved,
	DriverWentOnline,
	Offer,
	OfferAccepted,
	OfferDeclined,
	Tick,
	TripCancelled,
	TripCompleted,
	TripId,
	TripOfferExpired,
	TripPickedUp,
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
	  }
	// Position is the pickup: no separate cell.
	| {
			state: "at_pickup";
			id: DriverId;
			tripId: TripId;
			pickup: Cell;
			dropoff: Cell;
	  }
	| {
			state: "on_trip";
			id: DriverId;
			cell: Cell;
			tripId: TripId;
			dropoff: Cell;
	  }
	// Position is the dropoff: no separate cell.
	| { state: "at_dropoff"; id: DriverId; tripId: TripId; dropoff: Cell };

// Drivers kept sorted by ID: outputs and random draws follow that order.
export type DriverShardState = { grid: Grid; drivers: Driver[] };

export type DriverShardInput =
	| ClockTicked
	| Offer
	| TripPickedUp
	| TripCompleted
	| TripCancelled
	| TripOfferExpired;

export function startDriverShard(
	config: { grid: Grid; driverIds: DriverId[]; tick: Tick },
	random: Random,
): { state: DriverShardState; outputs: DriverWentOnline[] } {
	const drivers: IdleDriver[] = config.driverIds.toSorted().map((id) => ({
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

type DriverShardOutput =
	| DriverMoved
	| DriverArrivedAtPickup
	| DriverArrivedAtDropoff
	| OfferAccepted
	| OfferDeclined;

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
		case "trip.picked_up":
			return onPickedUp(state, input);
		case "trip.completed":
			return onCompleted(state, input);
		case "trip.cancelled":
		case "trip.offer_expired":
			return onTripEnded(state, input);
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
						cell: offered.cell,
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

function onPickedUp(state: DriverShardState, pickedUp: TripPickedUp): Decision {
	const drivers = state.drivers.map((driver): Driver => {
		if (driver.id !== pickedUp.driverId || driver.state !== "at_pickup") {
			return driver;
		}
		if (driver.tripId !== pickedUp.tripId) return driver;
		return {
			state: "on_trip",
			id: driver.id,
			cell: driver.pickup,
			tripId: driver.tripId,
			dropoff: driver.dropoff,
		};
	});
	return { state: { ...state, drivers }, outputs: [] };
}

function onCompleted(
	state: DriverShardState,
	completed: TripCompleted,
): Decision {
	const drivers = state.drivers.map((driver): Driver => {
		if (driver.id !== completed.driverId || driver.state !== "at_dropoff") {
			return driver;
		}
		if (driver.tripId !== completed.tripId) return driver;
		return {
			state: "idle",
			id: driver.id,
			cell: driver.dropoff,
			wanderTarget: null,
		};
	});
	return { state: { ...state, drivers }, outputs: [] };
}

function onTripEnded(
	state: DriverShardState,
	ended: TripCancelled | TripOfferExpired,
): Decision {
	const drivers = state.drivers.map((driver): Driver => {
		if (driver.id !== ended.driverId) return driver;
		if (driver.state !== "en_route" && driver.state !== "at_pickup") {
			return driver;
		}
		if (driver.tripId !== ended.tripId) return driver;
		const cell = driver.state === "at_pickup" ? driver.pickup : driver.cell;
		return { state: "idle", id: driver.id, cell, wanderTarget: null };
	});
	return { state: { ...state, drivers }, outputs: [] };
}

function onTick(
	state: DriverShardState,
	input: ClockTicked,
	random: Random,
): Decision {
	const outputs: DriverShardOutput[] = [];
	const drivers: Driver[] = [];
	for (const driver of state.drivers) {
		switch (driver.state) {
			case "idle":
				drivers.push(wander(driver, state.grid, input.tick, random, outputs));
				break;
			case "en_route":
				drivers.push(driveToPickup(driver, input.tick, outputs));
				break;
			case "at_pickup":
			case "at_dropoff":
				drivers.push(driver);
				break;
			case "on_trip":
				drivers.push(driveToDropoff(driver, input.tick, outputs));
				break;
			default: {
				const unhandled: never = driver;
				throw new Error(`unhandled driver state: ${unhandled}`);
			}
		}
	}
	return { state: { ...state, drivers }, outputs };
}

type IdleDriver = Extract<Driver, { state: "idle" }>;
type EnRouteDriver = Extract<Driver, { state: "en_route" }>;
type OnTripDriver = Extract<Driver, { state: "on_trip" }>;

function wander(
	driver: IdleDriver,
	grid: Grid,
	tick: Tick,
	random: Random,
	outputs: DriverShardOutput[],
): IdleDriver {
	const wanderTarget = driver.wanderTarget ?? randomCell(grid, random);
	if (distance(driver.cell, wanderTarget) === 0) {
		return { ...driver, wanderTarget: null };
	}
	const cell = stepToward(driver.cell, wanderTarget);
	outputs.push({ type: "driver.moved", tick, driverId: driver.id, cell });
	const arrived = distance(cell, wanderTarget) === 0;
	return { ...driver, cell, wanderTarget: arrived ? null : wanderTarget };
}

function driveToPickup(
	driver: EnRouteDriver,
	tick: Tick,
	outputs: DriverShardOutput[],
): Driver {
	let cell = driver.cell;
	if (distance(cell, driver.pickup) > 0) {
		cell = stepToward(cell, driver.pickup);
		outputs.push({ type: "driver.moved", tick, driverId: driver.id, cell });
	}
	if (distance(cell, driver.pickup) > 0) {
		return { ...driver, cell };
	}
	outputs.push({
		type: "driver.arrived_at_pickup",
		tick,
		driverId: driver.id,
		tripId: driver.tripId,
		cell,
	});
	return {
		state: "at_pickup",
		id: driver.id,
		tripId: driver.tripId,
		pickup: driver.pickup,
		dropoff: driver.dropoff,
	};
}

function driveToDropoff(
	driver: OnTripDriver,
	tick: Tick,
	outputs: DriverShardOutput[],
): Driver {
	let cell = driver.cell;
	if (distance(cell, driver.dropoff) > 0) {
		cell = stepToward(cell, driver.dropoff);
		outputs.push({ type: "driver.moved", tick, driverId: driver.id, cell });
	}
	if (distance(cell, driver.dropoff) > 0) {
		return { ...driver, cell };
	}
	outputs.push({
		type: "driver.arrived_at_dropoff",
		tick,
		driverId: driver.id,
		tripId: driver.tripId,
		cell,
	});
	return {
		state: "at_dropoff",
		id: driver.id,
		tripId: driver.tripId,
		dropoff: driver.dropoff,
	};
}
