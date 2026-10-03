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
	DriverWentOffline,
	DriverWentOnline,
	InputRejected,
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
	| { state: "offline"; id: DriverId; cell: Cell }
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

// Missing = always_online. In shift mode drivers alternate online and offline
// periods with lengths uniform in the ranges (ADR 0032).
export type Shifts =
	| { type: "always_online" }
	| {
			type: "shifts";
			onlineTicks: TickRange;
			offlineTicks: TickRange;
			startOnlineShare: number;
	  };

type TickRange = { min: number; max: number };

// n-th period of a driver's schedule, drawn from stream `shift:<driverId>:<n>`.
// Online or offline follows the driver: offline only while state is offline.
type Period = { n: number; startedAt: Tick; ticks: number };

type Schedule = {
	onlineTicks: TickRange;
	offlineTicks: TickRange;
	periods: ReadonlyMap<DriverId, Period>;
};

// Drivers kept sorted by ID: outputs and random draws follow that order.
// schedule: null when always online.
export type DriverShardState = {
	grid: Grid;
	drivers: Driver[];
	schedule: Schedule | null;
};

export type DriverShardInput =
	| ClockTicked
	| Offer
	| TripPickedUp
	| TripCompleted
	| TripCancelled
	| TripOfferExpired;

export function startDriverShard(
	config: { grid: Grid; driverIds: DriverId[]; tick: Tick; shifts?: Shifts },
	random: Random,
): { state: DriverShardState; outputs: DriverWentOnline[] } {
	const shifts = config.shifts ?? { type: "always_online" };
	assertValidShifts(shifts);
	// Cells drawn first, in driver ID order, as before shifts existed: shift
	// draws come only from shift streams.
	const placed = config.driverIds.toSorted().map((id) => ({
		id,
		cell: randomCell(config.grid, random),
	}));
	let drivers: Driver[];
	let schedule: Schedule | null = null;
	if (shifts.type === "always_online") {
		drivers = placed.map(({ id, cell }) => idle(id, cell));
	} else {
		const periods = new Map<DriverId, Period>();
		drivers = placed.map(({ id, cell }): Driver => {
			const stream = random.child(shiftStream(id, 0));
			const online = stream.float() < shifts.startOnlineShare;
			const range = online ? shifts.onlineTicks : shifts.offlineTicks;
			periods.set(id, {
				n: 0,
				startedAt: config.tick,
				ticks: stream.int(range.min, range.max),
			});
			return online ? idle(id, cell) : { state: "offline", id, cell };
		});
		schedule = {
			onlineTicks: shifts.onlineTicks,
			offlineTicks: shifts.offlineTicks,
			periods,
		};
	}
	const outputs: DriverWentOnline[] = drivers
		.filter((driver) => driver.state === "idle")
		.map((driver) => ({
			type: "driver.went_online",
			tick: config.tick,
			driverId: driver.id,
			cell: driver.cell,
		}));
	return { state: { grid: config.grid, drivers, schedule }, outputs };
}

// Config is parsed at the edge (CLI, env), so an invalid one here is a bug.
// Negated comparisons also reject NaN.
function assertValidShifts(shifts: Shifts): void {
	if (shifts.type === "always_online") return;
	for (const { min, max } of [shifts.onlineTicks, shifts.offlineTicks]) {
		if (!Number.isInteger(min) || !Number.isInteger(max) || !(min >= 1)) {
			throw new Error(`shift period [${min}, ${max}] not integers >= 1`);
		}
		if (min > max) throw new Error(`shift period min ${min} above max ${max}`);
	}
	const share = shifts.startOnlineShare;
	if (!(share >= 0 && share <= 1)) {
		throw new Error(`start online share ${share} outside [0, 1]`);
	}
}

function idle(id: DriverId, cell: Cell): IdleDriver {
	return { state: "idle", id, cell, wanderTarget: null };
}

function shiftStream(driverId: DriverId, n: number): string {
	return `shift:${driverId}:${n}`;
}

type DriverShardOutput =
	| DriverWentOnline
	| DriverWentOffline
	| DriverMoved
	| DriverArrivedAtPickup
	| DriverArrivedAtDropoff
	| OfferAccepted
	| OfferDeclined
	| Rejected;

type Rejected = InputRejected<
	TripPickedUp | TripCompleted | TripCancelled | TripOfferExpired,
	| "driver_not_at_pickup"
	| "driver_not_at_dropoff"
	| "driver_on_another_trip"
	| "trip_already_picked_up"
>;

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
	const addressed = state.drivers.find(
		(driver) => driver.id === pickedUp.driverId,
	);
	if (addressed === undefined) return { state, outputs: [] };
	if (addressed.state !== "at_pickup") {
		return reject(state, pickedUp, "driver_not_at_pickup");
	}
	if (addressed.tripId !== pickedUp.tripId) {
		return reject(state, pickedUp, "driver_on_another_trip");
	}
	return replaceDriver(state, {
		state: "on_trip",
		id: addressed.id,
		cell: addressed.pickup,
		tripId: addressed.tripId,
		dropoff: addressed.dropoff,
	});
}

function onCompleted(
	state: DriverShardState,
	completed: TripCompleted,
): Decision {
	const addressed = state.drivers.find(
		(driver) => driver.id === completed.driverId,
	);
	if (addressed === undefined) return { state, outputs: [] };
	if (addressed.state !== "at_dropoff") {
		return reject(state, completed, "driver_not_at_dropoff");
	}
	if (addressed.tripId !== completed.tripId) {
		return reject(state, completed, "driver_on_another_trip");
	}
	return replaceDriver(state, {
		state: "idle",
		id: addressed.id,
		cell: addressed.dropoff,
		wanderTarget: null,
	});
}

function reject(
	state: DriverShardState,
	input: Rejected["input"],
	reason: Rejected["reason"],
): Decision {
	return {
		state,
		outputs: [{ type: "input_rejected", reason, input }],
	};
}

function replaceDriver(state: DriverShardState, replacement: Driver): Decision {
	const drivers = state.drivers.map((driver) =>
		driver.id === replacement.id ? replacement : driver,
	);
	return { state: { ...state, drivers }, outputs: [] };
}

function onTripEnded(
	state: DriverShardState,
	ended: TripCancelled | TripOfferExpired,
): Decision {
	const addressed = state.drivers.find(
		(driver) => driver.id === ended.driverId,
	);
	// Not this driver's current trip: the driver isn't involved.
	if (
		addressed === undefined ||
		addressed.state === "idle" ||
		addressed.state === "offline"
	) {
		return { state, outputs: [] };
	}
	if (addressed.tripId !== ended.tripId) return { state, outputs: [] };
	// Dispatch rejects cancel after pickup and expiry only precedes a match.
	if (addressed.state === "on_trip" || addressed.state === "at_dropoff") {
		return reject(state, ended, "trip_already_picked_up");
	}
	const cell =
		addressed.state === "at_pickup" ? addressed.pickup : addressed.cell;
	return replaceDriver(state, {
		state: "idle",
		id: addressed.id,
		cell,
		wanderTarget: null,
	});
}

function onTick(
	state: DriverShardState,
	input: ClockTicked,
	random: Random,
): Decision {
	const outputs: DriverShardOutput[] = [];
	const drivers: Driver[] = [];
	const periods = new Map(state.schedule?.periods);
	for (const driver of state.drivers) {
		const changed =
			state.schedule === null
				? null
				: changeShift(driver, state.schedule, input.tick, random);
		if (changed !== null) {
			drivers.push(changed.driver);
			periods.set(driver.id, changed.period);
			outputs.push(changed.output);
			continue;
		}
		switch (driver.state) {
			case "idle":
				drivers.push(wander(driver, state.grid, input.tick, random, outputs));
				break;
			case "en_route":
				drivers.push(driveToPickup(driver, input.tick, outputs));
				break;
			case "offline":
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
	const schedule =
		state.schedule === null ? null : { ...state.schedule, periods };
	return { state: { ...state, drivers, schedule }, outputs };
}

// Ends the driver's current period if it is over; the next one starts this
// tick. A driver on a trip finishes it first: its online period runs over
// until it is idle (ADR 0032). null: no change.
function changeShift(
	driver: Driver,
	schedule: Schedule,
	tick: Tick,
	random: Random,
): {
	driver: Driver;
	period: Period;
	output: DriverWentOnline | DriverWentOffline;
} | null {
	const period = schedule.periods.get(driver.id);
	if (period === undefined) {
		throw new Error(`driver ${driver.id} without a shift period`);
	}
	if (tick - period.startedAt < period.ticks) return null;
	if (driver.state !== "offline" && driver.state !== "idle") return null;
	const n = period.n + 1;
	const goingOnline = driver.state === "offline";
	const { min, max } = goingOnline
		? schedule.onlineTicks
		: schedule.offlineTicks;
	const next = {
		n,
		startedAt: tick,
		ticks: random.child(shiftStream(driver.id, n)).int(min, max),
	};
	const event = { tick, driverId: driver.id, cell: driver.cell };
	if (goingOnline) {
		return {
			driver: idle(driver.id, driver.cell),
			period: next,
			output: { type: "driver.went_online", ...event },
		};
	}
	return {
		driver: { state: "offline", id: driver.id, cell: driver.cell },
		period: next,
		output: { type: "driver.went_offline", ...event },
	};
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
