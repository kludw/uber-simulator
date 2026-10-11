import { DriverIndex, driverIdAt } from "../shared/fleet.ts";
import {
	type Cell,
	Coordinate,
	cellAt,
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
	DriversWentOnline,
	DriverWentOffline,
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
	ZonesPriced,
} from "../shared/messages.ts";
import { driversMoved, driversWentOnline } from "../shared/messages.ts";
import type { Random } from "../shared/random.ts";
import {
	oneRegion,
	type Region,
	type RegionLayout,
	regionOf,
} from "../shared/regions.ts";
import {
	baseSurge,
	type Surge,
	Zone,
	zoneCount,
	zoneDistance,
	zoneOf,
	zonePartBounds,
} from "../shared/surge.ts";

// region: the trip's, its pickup's region, from the offer until the trip
// is over; the driver's trip messages go there (ADR 0050).
// A busy driver's current stop is its own fields (tripId and pickup or
// dropoff); trips: the trips it holds; next: its stops after the current
// one, in order (ADR 0056). Both built once per change, never per tick.
type Driver =
	| { state: "offline"; id: DriverId; index: DriverIndex; cell: Cell }
	| {
			state: "idle";
			id: DriverId;
			index: DriverIndex;
			cell: Cell;
			wanderTarget: Cell | null;
	  }
	| {
			state: "en_route";
			id: DriverId;
			index: DriverIndex;
			cell: Cell;
			tripId: TripId;
			region: Region;
			pickup: Cell;
			dropoff: Cell;
			trips: HeldTrips;
			next: readonly Stop[];
	  }
	// Position is the pickup: no separate cell.
	| {
			state: "at_pickup";
			id: DriverId;
			index: DriverIndex;
			tripId: TripId;
			region: Region;
			pickup: Cell;
			dropoff: Cell;
			arrivedAt: Tick;
			trips: HeldTrips;
			next: readonly Stop[];
	  }
	| {
			state: "on_trip";
			id: DriverId;
			index: DriverIndex;
			cell: Cell;
			tripId: TripId;
			region: Region;
			dropoff: Cell;
			trips: HeldTrips;
			next: readonly Stop[];
	  }
	// Position is the dropoff: no separate cell.
	| {
			state: "at_dropoff";
			id: DriverId;
			index: DriverIndex;
			tripId: TripId;
			region: Region;
			dropoff: Cell;
			arrivedAt: Tick;
			trips: HeldTrips;
			next: readonly Stop[];
	  };

type HeldTrip = {
	tripId: TripId;
	pickup: Cell;
	dropoff: Cell;
	pooled: boolean;
};

// At most two trips per driver (ADR 0056).
type HeldTrips = [HeldTrip] | [HeldTrip, HeldTrip];

type Stop = { kind: "pickup" | "dropoff"; tripId: TripId; cell: Cell };

// Shared by every driver with no stop after its current one.
const noStops: readonly Stop[] = [];

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
// prices: the last zones.priced per region, by zone; zones not listed are
// 1.0. pricesChanged: a zones.priced arrived since the last tick, which
// rebuilds chaseTable (ADR 0055).
export type DriverShardState = {
	grid: Grid;
	regions: RegionLayout;
	fleetSize: number;
	drivers: Map<DriverId, Driver>;
	schedule: Schedule | null;
	picky: Picky | null;
	prices: Map<Region, Map<Zone, Surge>>;
	pricesChanged: boolean;
	chaseTable: ChaseTable;
};

// By zone: the bounds of the nearest surge area within chase reach. Zones
// with none are absent; empty without prices.
type ChaseTable = Map<Zone, { min: Cell; max: Cell }>;

// In zones (ADR 0055).
const chaseReach = 4;

export type DriverShardInput =
	| ClockTicked
	| Offer
	| TripPickedUp
	| TripCompleted
	| TripCancelled
	| TripOfferExpired
	| TripStatus
	| ZonesPriced;

export function startDriverShard(
	config: {
		grid: Grid;
		// The shard's drivers: driverCount from firstIndex on (ADR 0052).
		fleetSize: number;
		firstIndex: DriverIndex;
		driverCount: number;
		tick: Tick;
		shifts?: Shifts;
		preferences?: Preferences;
		// Missing = one region.
		regions?: RegionLayout;
	},
	random: Random,
): { state: DriverShardState; outputs: DriversWentOnline[] } {
	const shifts = config.shifts ?? { type: "always_online" };
	assertValidShifts(shifts);
	// Cells drawn first, in driver ID order, as before shifts existed: shift
	// draws come only from shift streams.
	const placed = Array.from({ length: config.driverCount }, (_, i) => {
		const index = DriverIndex.parse(config.firstIndex + i);
		const id = driverIdAt(config.fleetSize, index);
		return { id, index, cell: randomCell(config.grid, random) };
	});
	const drivers = new Map<DriverId, Driver>();
	let schedule: Schedule | null = null;
	if (shifts.type === "always_online") {
		for (const driver of placed) {
			drivers.set(driver.id, idle(driver, driver.cell));
		}
	} else {
		const periods = new Map<DriverId, Period>();
		for (const { id, index, cell } of placed) {
			const stream = random.child(shiftStream(id, 0));
			const online = stream.float() < shifts.startOnlineShare;
			const range = online ? shifts.onlineTicks : shifts.offlineTicks;
			periods.set(id, {
				n: 0,
				startedAt: config.tick,
				ticks: stream.int(range.min, range.max),
			});
			drivers.set(
				id,
				online
					? idle({ id, index }, cell)
					: { state: "offline", id, index, cell },
			);
		}
		schedule = {
			onlineTicks: shifts.onlineTicks,
			offlineTicks: shifts.offlineTicks,
			periods,
		};
	}
	const picky = startPicky(
		config.preferences,
		placed.map((driver) => driver.id),
		random,
	);
	const state: DriverShardState = {
		grid: config.grid,
		regions: config.regions ?? oneRegion,
		fleetSize: config.fleetSize,
		drivers,
		schedule,
		picky,
		prices: new Map(),
		pricesChanged: false,
		chaseTable: new Map(),
	};
	const online: ByRegion = new Map();
	for (const driver of drivers.values()) {
		if (driver.state !== "idle") continue;
		inRegion(online, regionOf(state.regions, state.grid, driver.cell)).push({
			driverIndex: driver.index,
			cell: driver.cell,
		});
	}
	return {
		state,
		outputs: inRegionChunks(online, (region, chunk) =>
			driversWentOnline(config.tick, region, config.fleetSize, chunk),
		),
	};
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

function idle(
	driver: { id: DriverId; index: DriverIndex },
	cell: Cell,
): IdleDriver {
	return {
		state: "idle",
		id: driver.id,
		index: driver.index,
		cell,
		wanderTarget: null,
	};
}

function shiftStream(driverId: DriverId, n: number): string {
	return `shift:${driverId}:${n}`;
}

type DriverShardOutput =
	| DriversWentOnline
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
		case "zones.priced":
			return onPriced(state, input);
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
	const region = regionOf(state.regions, state.grid, offer.pickup);
	// Out of region: the offering instance no longer owns the driver (it
	// crossed), so accepting would leave two instances tracking it (ADR 0050).
	if (
		offered.state !== "idle" ||
		regionOf(state.regions, state.grid, offered.cell) !== region ||
		declines(state.picky, offered, offer, random)
	) {
		return {
			state,
			outputs: [
				{
					type: "offer_declined",
					tripId: offer.tripId,
					driverId: offer.driverId,
					region,
					idleAt: offered.state === "idle" ? offered.cell : null,
				},
			],
		};
	}
	state.drivers.set(offered.id, {
		state: "en_route",
		id: offered.id,
		index: offered.index,
		cell: offered.cell,
		tripId: offer.tripId,
		region,
		pickup: offer.pickup,
		dropoff: offer.dropoff,
		trips: [
			{
				tripId: offer.tripId,
				pickup: offer.pickup,
				dropoff: offer.dropoff,
				pooled: offer.pooled === true,
			},
		],
		next: [{ kind: "dropoff", tripId: offer.tripId, cell: offer.dropoff }],
	});
	return {
		state,
		outputs: [
			{
				type: "offer_accepted",
				tripId: offer.tripId,
				driverId: offer.driverId,
				region,
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
		index: addressed.index,
		cell: addressed.pickup,
		tripId: addressed.tripId,
		region: addressed.region,
		dropoff: addressed.dropoff,
		trips: addressed.trips,
		next: noStops,
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
		index: addressed.index,
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
		index: addressed.index,
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
			return replaceDriver(state, idle(addressed, addressed.pickup));
		}
		if (status.status !== "picked_up") return ignored;
		return replaceDriver(state, {
			state: "on_trip",
			id: addressed.id,
			index: addressed.index,
			cell: addressed.pickup,
			tripId: addressed.tripId,
			region: addressed.region,
			dropoff: addressed.dropoff,
			trips: addressed.trips,
			next: noStops,
		});
	}
	if (
		addressed.state === "at_dropoff" &&
		addressed.tripId === status.tripId &&
		status.stage === "dropoff" &&
		status.status !== "picked_up"
	) {
		return replaceDriver(state, idle(addressed, addressed.dropoff));
	}
	return ignored;
}

// Prices replace the region's whole; even equal ones re-pick targets on the
// next tick (ADR 0055).
function onPriced(state: DriverShardState, priced: ZonesPriced): Decision {
	state.prices.set(
		priced.region,
		new Map(priced.zones.map(({ zone, surge }) => [zone, surge])),
	);
	state.pricesChanged = true;
	return { state, outputs: [] };
}

function onTick(
	state: DriverShardState,
	input: ClockTicked,
	random: Random,
): Decision {
	const online: ByRegion = new Map();
	const moves: ByRegion = new Map();
	const outputs: DriverShardOutput[] = [];
	const { drivers, schedule } = state;
	const repick = state.pricesChanged;
	if (repick) {
		state.chaseTable = chaseTableOf(state);
		state.pricesChanged = false;
	}
	// Chase draws come from their own stream, taken once a driver chases, so
	// the shard's stream (wander and placement draws) is not shifted by them.
	let chaseStream: Random | null = null;
	const chaseTarget = (driver: IdleDriver): Cell | null => {
		const area = state.chaseTable.get(zoneOf(state.grid, driver.cell));
		if (area === undefined) return null;
		chaseStream ??= random.child(`chase:${input.tick}`);
		return cellAt(
			Coordinate.parse(chaseStream.int(area.min.x, area.max.x)),
			Coordinate.parse(chaseStream.int(area.min.y, area.max.y)),
		);
	};
	// Only existing keys are set while iterating: order stays by ID.
	for (const driver of drivers.values()) {
		const changed =
			schedule === null
				? null
				: changeShift(driver, schedule, input.tick, random);
		if (schedule !== null && changed !== null) {
			drivers.set(driver.id, changed.driver);
			schedule.periods.set(driver.id, changed.period);
			const { cell } = changed.driver;
			const region = regionOf(state.regions, state.grid, cell);
			if (changed.driver.state === "idle") {
				inRegion(online, region).push({ driverIndex: driver.index, cell });
			} else {
				outputs.push({
					type: "driver.went_offline",
					tick: input.tick,
					driverId: driver.id,
					cell,
					region,
				});
			}
			continue;
		}
		// A move goes to the region that owned the driver before it: an idle
		// driver's previous cell's, a busy driver's trip's (ADR 0050).
		switch (driver.state) {
			case "idle": {
				const region = regionOf(state.regions, state.grid, driver.cell);
				const target = wanderTarget(driver, state, repick, chaseTarget, random);
				drivers.set(driver.id, wander(driver, target, inRegion(moves, region)));
				break;
			}
			case "en_route":
				drivers.set(
					driver.id,
					driveToPickup(
						driver,
						input.tick,
						inRegion(moves, driver.region),
						outputs,
					),
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
					region: driver.region,
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
					region: driver.region,
				});
				break;
			case "offline":
				break;
			case "on_trip":
				drivers.set(
					driver.id,
					driveToDropoff(
						driver,
						input.tick,
						inRegion(moves, driver.region),
						outputs,
					),
				);
				break;
			default: {
				const unhandled: never = driver;
				throw new Error(`unhandled driver state: ${unhandled}`);
			}
		}
	}
	// Drivers going online first, then moves, so a subscriber has a driver's
	// cell before its arrival or going offline (ADR 0045, 0049).
	return {
		state,
		outputs: [
			...inRegionChunks(online, (region, chunk) =>
				driversWentOnline(input.tick, region, state.fleetSize, chunk),
			),
			...inRegionChunks(moves, (region, chunk) =>
				driversMoved(input.tick, region, state.fleetSize, chunk),
			),
			...outputs,
		],
	};
}

// ADR 0045: keeps a message well under NATS's default 1 MB max_payload.
const maxDriversPerMessage = 5000;

// A tick's drivers going online or moves, by the region they are sent to.
type ByRegion = Map<Region, DriverMove[]>;

function inRegion(byRegion: ByRegion, region: Region): DriverMove[] {
	const entries = byRegion.get(region);
	if (entries !== undefined) return entries;
	const created: DriverMove[] = [];
	byRegion.set(region, created);
	return created;
}

// Regions in index order, entry order kept within each (ADR 0050). None when
// there are no entries.
function inRegionChunks<Batch>(
	byRegion: ByRegion,
	batch: (region: Region, chunk: DriverMove[]) => Batch,
): Batch[] {
	return [...byRegion]
		.toSorted(([a], [b]) => a - b)
		.flatMap(([region, entries]) =>
			inChunks(entries, (chunk) => batch(region, chunk)),
		);
}

// None when there are no entries.
function inChunks<Entry, Batch>(
	entries: Entry[],
	batch: (chunk: Entry[]) => Batch,
): Batch[] {
	const chunks: Batch[] = [];
	for (let start = 0; start < entries.length; start += maxDriversPerMessage) {
		chunks.push(batch(entries.slice(start, start + maxDriversPerMessage)));
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
): { driver: IdleDriver | OfflineDriver; period: Period } | null {
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
	return {
		driver: goingOnline
			? idle(driver, driver.cell)
			: {
					state: "offline",
					id: driver.id,
					index: driver.index,
					cell: driver.cell,
				},
		period: next,
	};
}

type IdleDriver = Extract<Driver, { state: "idle" }>;
type OfflineDriver = Extract<Driver, { state: "offline" }>;
type EnRouteDriver = Extract<Driver, { state: "en_route" }>;
type OnTripDriver = Extract<Driver, { state: "on_trip" }>;

// A driver picking a target chases if it can; on the tick after new prices
// (repick) so does one heading outside any surge area, else it keeps its
// target (ADR 0055).
function wanderTarget(
	driver: IdleDriver,
	state: DriverShardState,
	repick: boolean,
	chaseTarget: (driver: IdleDriver) => Cell | null,
	random: Random,
): Cell {
	const current = driver.wanderTarget;
	if (current === null) {
		return chaseTarget(driver) ?? randomCell(state.grid, random);
	}
	if (!repick || surgeAt(state, current) > baseSurge) return current;
	return chaseTarget(driver) ?? current;
}

function surgeAt(state: DriverShardState, cell: Cell): Surge {
	const region = regionOf(state.regions, state.grid, cell);
	return state.prices.get(region)?.get(zoneOf(state.grid, cell)) ?? baseSurge;
}

// Nearest surge area by zone distance within chase reach, ties to the
// higher surge, then the lower region, then the lower zone.
function chaseTableOf(state: DriverShardState): ChaseTable {
	const areas = [...state.prices]
		.toSorted(([a], [b]) => a - b)
		.flatMap(([region, zones]) =>
			[...zones]
				.toSorted(([a], [b]) => a - b)
				.flatMap(([zone, surge]) => {
					const bounds = zonePartBounds(
						state.regions,
						state.grid,
						region,
						zone,
					);
					return bounds === null ? [] : [{ zone, surge, bounds }];
				}),
		);
	const table: ChaseTable = new Map();
	if (areas.length === 0) return table;
	for (let n = 0; n < zoneCount(state.grid); n++) {
		const own = Zone.parse(n);
		let nearest: (typeof areas)[number] | null = null;
		let nearestAway = 0;
		for (const area of areas) {
			const away = zoneDistance(state.grid, own, area.zone);
			if (away > chaseReach) continue;
			if (
				nearest !== null &&
				(away > nearestAway ||
					(away === nearestAway && area.surge <= nearest.surge))
			) {
				continue;
			}
			nearest = area;
			nearestAway = away;
		}
		if (nearest !== null) table.set(own, nearest.bounds);
	}
	return table;
}

function wander(
	driver: IdleDriver,
	wanderTarget: Cell,
	moves: DriverMove[],
): IdleDriver {
	if (distance(driver.cell, wanderTarget) === 0) {
		return { ...driver, wanderTarget: null };
	}
	const cell = stepToward(driver.cell, wanderTarget);
	moves.push({ driverIndex: driver.index, cell });
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
		moves.push({ driverIndex: driver.index, cell });
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
		region: driver.region,
	});
	return {
		state: "at_pickup",
		id: driver.id,
		index: driver.index,
		tripId: driver.tripId,
		region: driver.region,
		pickup: driver.pickup,
		dropoff: driver.dropoff,
		arrivedAt: tick,
		trips: driver.trips,
		next: driver.next,
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
		moves.push({ driverIndex: driver.index, cell });
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
		region: driver.region,
	});
	return {
		state: "at_dropoff",
		id: driver.id,
		index: driver.index,
		tripId: driver.tripId,
		region: driver.region,
		dropoff: driver.dropoff,
		arrivedAt: tick,
		trips: driver.trips,
		next: driver.next,
	};
}
