import {
	type Cell,
	distance,
	type Grid,
	randomCell,
	stepToward,
} from "../shared/grid.ts";
import type {
	ClockTicked,
	ConfirmTrip,
	DriverArrivedAtDropoff,
	DriverArrivedAtPickup,
	DriverId,
	DriverMove,
	DriversMoved,
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
	TripStatus,
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
			arrivedAt: Tick;
	  }
	| {
			state: "on_trip";
			id: DriverId;
			cell: Cell;
			tripId: TripId;
			dropoff: Cell;
	  }
	// Position is the dropoff: no separate cell.
	| {
			state: "at_dropoff";
			id: DriverId;
			tripId: TripId;
			dropoff: Cell;
			arrivedAt: Tick;
	  };

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

// Missing = accept_all. Picky drivers decline far pickups and a share of the
// rest (ADR 0035). Distances in cells.
export type Preferences =
	| { type: "accept_all" }
	| {
			type: "picky";
			maxPickupDistance: { min: number; max: number };
			declineShare: number;
	  };

// Each driver's max pickup distance, drawn once at start from stream
// `preference:<driverId>`.
type Picky = {
	maxPickupDistances: ReadonlyMap<DriverId, number>;
	declineShare: number;
};

// n-th period of a driver's schedule, drawn from stream `shift:<driverId>:<n>`.
// Online or offline follows the driver: offline only while state is offline.
type Period = { n: number; startedAt: Tick; ticks: number };

// periods: updated in place (ADR 0033).
type Schedule = {
	onlineTicks: TickRange;
	offlineTicks: TickRange;
	periods: Map<DriverId, Period>;
};

// drivers: by ID, inserted sorted by ID; outputs and random draws follow
// that order. Entries are replaced in place (ADR 0033, 0036): replacing a
// key's value keeps its position, so never delete and re-insert one.
// schedule: null when always online. picky: null when accepting all.
export type DriverShardState = {
	grid: Grid;
	drivers: Map<DriverId, Driver>;
	schedule: Schedule | null;
	picky: Picky | null;
};

export type DriverShardInput =
	| ClockTicked
	| Offer
	| TripPickedUp
	| TripCompleted
	| TripCancelled
	| TripOfferExpired
	| TripStatus;

export function startDriverShard(
	config: {
		grid: Grid;
		driverIds: DriverId[];
		tick: Tick;
		shifts?: Shifts;
		preferences?: Preferences;
	},
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
	const drivers = new Map<DriverId, Driver>();
	let schedule: Schedule | null = null;
	if (shifts.type === "always_online") {
		for (const { id, cell } of placed) drivers.set(id, idle(id, cell));
	} else {
		const periods = new Map<DriverId, Period>();
		for (const { id, cell } of placed) {
			const stream = random.child(shiftStream(id, 0));
			const online = stream.float() < shifts.startOnlineShare;
			const range = online ? shifts.onlineTicks : shifts.offlineTicks;
			periods.set(id, {
				n: 0,
				startedAt: config.tick,
				ticks: stream.int(range.min, range.max),
			});
			drivers.set(id, online ? idle(id, cell) : { state: "offline", id, cell });
		}
		schedule = {
			onlineTicks: shifts.onlineTicks,
			offlineTicks: shifts.offlineTicks,
			periods,
		};
	}
	const outputs: DriverWentOnline[] = [];
	for (const driver of drivers.values()) {
		if (driver.state !== "idle") continue;
		outputs.push({
			type: "driver.went_online",
			tick: config.tick,
			driverId: driver.id,
			cell: driver.cell,
		});
	}
	const picky = startPicky(config.preferences, config.driverIds, random);
	return { state: { grid: config.grid, drivers, schedule, picky }, outputs };
}

// accept_all takes no preference streams, so default runs stay unchanged.
function startPicky(
	preferences: Preferences | undefined,
	driverIds: DriverId[],
	random: Random,
): Picky | null {
	if (preferences === undefined || preferences.type === "accept_all") {
		return null;
	}
	assertValidPicky(preferences);
	const { min, max } = preferences.maxPickupDistance;
	const maxPickupDistances = new Map(
		driverIds.map((id) => [id, random.child(`preference:${id}`).int(min, max)]),
	);
	return { maxPickupDistances, declineShare: preferences.declineShare };
}

// Same contract as assertValidShifts: parsed at the edge, invalid here = bug.
function assertValidPicky(
	picky: Extract<Preferences, { type: "picky" }>,
): void {
	const { min, max } = picky.maxPickupDistance;
	if (!Number.isInteger(min) || !Number.isInteger(max) || !(min >= 0)) {
		throw new Error(`max pickup distance [${min}, ${max}] not integers >= 0`);
	}
	if (min > max) {
		throw new Error(`max pickup distance min ${min} above max ${max}`);
	}
	const share = picky.declineShare;
	if (!(share >= 0 && share <= 1)) {
		throw new Error(`decline share ${share} outside [0, 1]`);
	}
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
	| DriversMoved
	| DriverArrivedAtPickup
	| DriverArrivedAtDropoff
	| OfferAccepted
	| OfferDeclined
	| ConfirmTrip
	| Rejected;

type Rejected = InputRejected<
	TripPickedUp | TripCompleted | TripCancelled | TripOfferExpired,
	| "driver_not_at_pickup"
	| "driver_not_at_dropoff"
	| "driver_on_another_trip"
	| "trip_already_picked_up"
>;

type Decision = { state: DriverShardState; outputs: DriverShardOutput[] };

// ADR 0041: a driver waiting at the pickup or dropoff asks dispatch about its
// trip every this many ticks without a trip event. Any trip event for it
// moves it out of waiting, so the wait counts from arrival.
const confirmEveryTicks = 10;

function confirmDue(arrivedAt: Tick, tick: Tick): boolean {
	const waited = tick - arrivedAt;
	return waited > 0 && waited % confirmEveryTicks === 0;
}

export function decideDriverShard(
	state: DriverShardState,
	input: DriverShardInput,
	random: Random,
): Decision {
	switch (input.type) {
		case "clock.ticked":
			return onTick(state, input, random);
		case "offer":
			return onOffer(state, input, random);
		case "trip.picked_up":
			return onPickedUp(state, input);
		case "trip.completed":
			return onCompleted(state, input);
		case "trip.cancelled":
		case "trip.offer_expired":
			return onTripEnded(state, input);
		case "trip_status":
			return onTripStatus(state, input);
		default: {
			const unhandled: never = input;
			throw new Error(`unhandled driver shard input: ${unhandled}`);
		}
	}
}

function onOffer(
	state: DriverShardState,
	offer: Offer,
	random: Random,
): Decision {
	const offered = state.drivers.get(offer.driverId);
	if (offered === undefined) {
		throw new Error(`offer for driver ${offer.driverId} outside this shard`);
	}
	if (
		offered.state !== "idle" ||
		declines(state.picky, offered, offer, random)
	) {
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
	state.drivers.set(offered.id, {
		state: "en_route",
		id: offered.id,
		cell: offered.cell,
		tripId: offer.tripId,
		pickup: offer.pickup,
		dropoff: offer.dropoff,
	});
	return {
		state,
		outputs: [
			{
				type: "offer_accepted",
				tripId: offer.tripId,
				driverId: offer.driverId,
			},
		],
	};
}

function declines(
	picky: Picky | null,
	driver: IdleDriver,
	offer: Offer,
	random: Random,
): boolean {
	if (picky === null) return false;
	const max = picky.maxPickupDistances.get(driver.id);
	if (max === undefined) {
		throw new Error(`driver ${driver.id} without a max pickup distance`);
	}
	if (distance(driver.cell, offer.pickup) > max) return true;
	// One stream per offer: the outcome doesn't depend on offer arrival order.
	const stream = random.child(`offer:${offer.tripId}:${driver.id}`);
	return stream.float() < picky.declineShare;
}

function onPickedUp(state: DriverShardState, pickedUp: TripPickedUp): Decision {
	const addressed = state.drivers.get(pickedUp.driverId);
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
	const addressed = state.drivers.get(completed.driverId);
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
	state.drivers.set(replacement.id, replacement);
	return { state, outputs: [] };
}

function onTripEnded(
	state: DriverShardState,
	ended: TripCancelled | TripOfferExpired,
): Decision {
	// No driver (cancelled before any match), or not this driver's current
	// trip: the driver isn't involved.
	if (ended.driverId === null) return { state, outputs: [] };
	const addressed = state.drivers.get(ended.driverId);
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

// Dispatch's answer to confirm_trip (ADR 0041). Acted on only by a driver
// still waiting for that trip at that stage; anything else is a late or
// duplicate reply and is ignored, not rejected.
function onTripStatus(state: DriverShardState, status: TripStatus): Decision {
	const addressed = state.drivers.get(status.driverId);
	const ignored = { state, outputs: [] };
	if (addressed === undefined) return ignored;
	if (
		addressed.state === "at_pickup" &&
		addressed.tripId === status.tripId &&
		status.stage === "pickup"
	) {
		if (status.status === "released") {
			return replaceDriver(state, idle(addressed.id, addressed.pickup));
		}
		if (status.status !== "picked_up") return ignored;
		return replaceDriver(state, {
			state: "on_trip",
			id: addressed.id,
			cell: addressed.pickup,
			tripId: addressed.tripId,
			dropoff: addressed.dropoff,
		});
	}
	if (
		addressed.state === "at_dropoff" &&
		addressed.tripId === status.tripId &&
		status.stage === "dropoff" &&
		status.status !== "picked_up"
	) {
		return replaceDriver(state, idle(addressed.id, addressed.dropoff));
	}
	return ignored;
}

function onTick(
	state: DriverShardState,
	input: ClockTicked,
	random: Random,
): Decision {
	const moves: DriverMove[] = [];
	const outputs: DriverShardOutput[] = [];
	const { drivers, schedule } = state;
	// Only existing keys are set while iterating: order stays by ID.
	for (const driver of drivers.values()) {
		const changed =
			schedule === null
				? null
				: changeShift(driver, schedule, input.tick, random);
		if (schedule !== null && changed !== null) {
			drivers.set(driver.id, changed.driver);
			schedule.periods.set(driver.id, changed.period);
			outputs.push(changed.output);
			continue;
		}
		switch (driver.state) {
			case "idle":
				drivers.set(
					driver.id,
					wander(driver, state.grid, random, moves),
				);
				break;
			case "en_route":
				drivers.set(
					driver.id,
					driveToPickup(driver, input.tick, moves, outputs),
				);
				break;
			case "at_pickup":
				if (!confirmDue(driver.arrivedAt, input.tick)) break;
				outputs.push({
					type: "confirm_trip",
					tripId: driver.tripId,
					driverId: driver.id,
					stage: "pickup",
					cell: driver.pickup,
				});
				break;
			case "at_dropoff":
				if (!confirmDue(driver.arrivedAt, input.tick)) break;
				outputs.push({
					type: "confirm_trip",
					tripId: driver.tripId,
					driverId: driver.id,
					stage: "dropoff",
					cell: driver.dropoff,
				});
				break;
			case "offline":
				break;
			case "on_trip":
				drivers.set(
					driver.id,
					driveToDropoff(driver, input.tick, moves, outputs),
				);
				break;
			default: {
				const unhandled: never = driver;
				throw new Error(`unhandled driver state: ${unhandled}`);
			}
		}
	}
	return { state, outputs: [...movedChunks(input.tick, moves), ...outputs] };
}

// ADR 0045: keeps a message well under NATS's default 1 MB max_payload.
const maxMovesPerMessage = 5000;

// First in a tick's outputs, so a subscriber has a driver's cell before its
// arrival or going offline (ADR 0045). None when no driver moved.
function movedChunks(tick: Tick, moves: DriverMove[]): DriversMoved[] {
	const chunks: DriversMoved[] = [];
	for (let start = 0; start < moves.length; start += maxMovesPerMessage) {
		chunks.push({
			type: "drivers.moved",
			tick,
			moves: moves.slice(start, start + maxMovesPerMessage),
		});
	}
	return chunks;
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
	random: Random,
	moves: DriverMove[],
): IdleDriver {
	const wanderTarget = driver.wanderTarget ?? randomCell(grid, random);
	if (distance(driver.cell, wanderTarget) === 0) {
		return { ...driver, wanderTarget: null };
	}
	const cell = stepToward(driver.cell, wanderTarget);
	moves.push({ driverId: driver.id, cell });
	const arrived = distance(cell, wanderTarget) === 0;
	return { ...driver, cell, wanderTarget: arrived ? null : wanderTarget };
}

function driveToPickup(
	driver: EnRouteDriver,
	tick: Tick,
	moves: DriverMove[],
	outputs: DriverShardOutput[],
): Driver {
	let cell = driver.cell;
	if (distance(cell, driver.pickup) > 0) {
		cell = stepToward(cell, driver.pickup);
		moves.push({ driverId: driver.id, cell });
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
		arrivedAt: tick,
	};
}

function driveToDropoff(
	driver: OnTripDriver,
	tick: Tick,
	moves: DriverMove[],
	outputs: DriverShardOutput[],
): Driver {
	let cell = driver.cell;
	if (distance(cell, driver.dropoff) > 0) {
		cell = stepToward(cell, driver.dropoff);
		moves.push({ driverId: driver.id, cell });
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
		arrivedAt: tick,
	};
}
