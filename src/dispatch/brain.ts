import { type Cell, distance, type Grid } from "../shared/grid.ts";
import type {
	CancelTrip,
	CancelTripAccepted,
	CancelTripRejected,
	ClockTicked,
	ConfirmTrip,
	DriverArrivedAtDropoff,
	DriverArrivedAtPickup,
	DriverId,
	DriversMoved,
	DriversWentOnline,
	DriverWentOffline,
	InputRejected,
	Offer,
	OfferAccepted,
	OfferDeclined,
	RequestTrip,
	RequestTripAccepted,
	RequestTripRejected,
	Tick,
	TripCancelled,
	TripCompleted,
	TripId,
	TripMatched,
	TripOfferDeclined,
	TripOfferExpired,
	TripOffered,
	TripPickedUp,
	TripRequested,
	TripStatus,
	ZonesPriced,
} from "../shared/messages.ts";
import { forEachDriverAt } from "../shared/messages.ts";
import { joinEtaOf, type Partner } from "../shared/pool.ts";
import type { Random } from "../shared/random.ts";
import {
	oneRegion,
	Region,
	type RegionLayout,
	regionBounds,
} from "../shared/regions.ts";
import {
	baseSurge,
	type Fare,
	fareOf,
	type Surge,
	surgeOf,
	type Zone,
	zoneOf,
} from "../shared/surge.ts";
import {
	busyDriverCell,
	type IdleDriver,
	type IdleDrivers,
	idleCount,
	idleCountsByZone,
	idleDriversById,
	isBusy,
	markBusy,
	markFree,
	nearestIdle,
	nearestIdleSkipping,
	placeDriver,
	placeDriverAt,
	removeDriver,
	startIdleDrivers,
} from "./idle-drivers.ts";
import { minCostMatching, minCostMatchingByNearest } from "./matching.ts";
import {
	type ArrivalRejected,
	acceptOffer,
	cancel,
	complete,
	type EndedTrip,
	type NoPendingOffer,
	offerTo,
	pickUp,
	type QueuedTrip,
	requestedTrip,
	type Trip,
	withdrawOffer,
} from "./trip.ts";

// trips: trips not yet ended by ID, in request order: the queue is the
// requested trips without an offer, in that order (FIFO).
// endedTrips: completed and cancelled trips, out of the per-tick scan but kept
// to answer late and duplicate inputs for them.
// drivers: online drivers' cells in its region as last reported in events (busy
// ones anywhere), and which are busy (a pending offer or an active trip), kept
// across ticks (ADR 0048, 0050).
// Cells may be stale (ADR 0018): a driver offered a trip on the tick it went
// offline declines (ADR 0032).
// tick: last clock tick, stamped on events caused by non-tick inputs.
// fleetSize: the run's fleet, from dispatch's own config (ADR 0052).
// region: the region this instance owns, named in zones.priced.
// surge: whether it prices zones and trips (ADR 0054).
// Pooling (ADR 0056): pooledOpen counts the pooled trips in trips (none:
// matching skips joins); holdingTwo, the busy drivers holding two trips (a
// partner and its join); pickedUpAt, each picked-up pooled trip's pickup tick.
// All stay empty with pooling off.
// trips, endedTrips, drivers, holdingTwo and pickedUpAt are owned and updated
// in place (ADR 0033).
export type DispatchState = {
	grid: Grid;
	fleetSize: number;
	tick: Tick;
	matching: Matching;
	region: Region;
	surge: boolean;
	trips: Map<TripId, Trip>;
	endedTrips: Map<TripId, EndedTrip>;
	drivers: IdleDrivers;
	pooledOpen: number;
	holdingTwo: Set<DriverId>;
	pickedUpAt: Map<TripId, Tick>;
};

// ADR 0030: batched matches only on ticks that are multiples of windowTicks.
export type Matching =
	| { type: "greedy" }
	| { type: "batched"; windowTicks: number };

export type DispatchInput =
	| ClockTicked
	| RequestTrip
	| CancelTrip
	| DriversWentOnline
	| DriverWentOffline
	| DriversMoved
	| OfferAccepted
	| OfferDeclined
	| DriverArrivedAtPickup
	| DriverArrivedAtDropoff
	| ConfirmTrip;

type DispatchOutput =
	| RequestTripAccepted
	| RequestTripRejected
	| CancelTripAccepted
	| CancelTripRejected
	| TripRequested
	| Offer
	| TripOffered
	| TripMatched
	| TripOfferDeclined
	| TripOfferExpired
	| TripPickedUp
	| TripCompleted
	| TripCancelled
	| TripStatus
	| ZonesPriced
	| (InputRejected<DriversWentOnline | DriversMoved, "fleet_size_mismatch"> & {
			expectedFleetSize: number;
	  })
	| InputRejected<OfferAccepted | OfferDeclined, NoPendingOffer["type"]>
	| InputRejected<
			DriverArrivedAtPickup | DriverArrivedAtDropoff | ConfirmTrip,
			ArrivalRejected["type"]
	  >;

type Decision = { state: DispatchState; outputs: DispatchOutput[] };

// ADR 0018.
const offerTimeoutTicks = 3;

// ADR 0054.
const pricingIntervalTicks = 30;
// fleetSize: driver shards' count × driversPerShard (ADR 0052).
// regions, region: the layout and the region this instance owns (ADR 0050);
// missing = one region.
// surge: price zones and trips (ADR 0054); missing = off.
export function startDispatch(config: {
	grid: Grid;
	fleetSize: number;
	tick: Tick;
	matching?: Matching | undefined;
	regions?: RegionLayout;
	region?: Region;
	surge?: boolean;
}): DispatchState {
	const matching = config.matching ?? { type: "greedy" };
	// Parsed at the edge; a bad window here is a caller bug.
	if (
		matching.type === "batched" &&
		!(Number.isInteger(matching.windowTicks) && matching.windowTicks > 0)
	) {
		throw new Error(
			`windowTicks ${matching.windowTicks} is not a positive integer`,
		);
	}
	const region = config.region ?? Region.parse(0);
	return {
		grid: config.grid,
		fleetSize: config.fleetSize,
		tick: config.tick,
		matching,
		region,
		surge: config.surge ?? false,
		trips: new Map(),
		endedTrips: new Map(),
		drivers: startIdleDrivers(
			config.grid,
			config.fleetSize,
			regionBounds(config.regions ?? oneRegion, config.grid, region),
		),
		pooledOpen: 0,
		holdingTwo: new Set(),
		pickedUpAt: new Map(),
	};
}

export function decideDispatch(
	state: DispatchState,
	input: DispatchInput,
	_random: Random,
): Decision {
	switch (input.type) {
		case "clock.ticked":
			return onTick(state, input);
		case "request_trip":
			return onRequestTrip(state, input);
		case "cancel_trip":
			return onCancelTrip(state, input);
		case "drivers.went_online":
		case "drivers.moved":
			return onDriversAt(state, input);
		case "driver.went_offline":
			return onDriverWentOffline(state, input);
		case "offer_accepted":
		case "offer_declined":
			return onOfferReply(state, input);
		case "driver.arrived_at_pickup":
		case "driver.arrived_at_dropoff":
			return onArrival(state, input);
		case "confirm_trip":
			return onConfirmTrip(state, input);
		default: {
			const unhandled: never = input;
			throw new Error(`unhandled dispatch input: ${unhandled}`);
		}
	}
}

function onTick(state: DispatchState, ticked: ClockTicked): Decision {
	const outputs: DispatchOutput[] = [];
	const offer = (trip: QueuedTrip, driverId: DriverId) => {
		storeTrip(state, offerTo(trip, driverId, ticked.tick));
		outputs.push(
			{
				type: "offer",
				tripId: trip.id,
				driverId,
				pickup: trip.pickup,
				dropoff: trip.dropoff,
				...(trip.pooled ? { pooled: true as const } : {}),
			},
			{ type: "trip.offered", tick: ticked.tick, tripId: trip.id, driverId },
		);
	};
	const queued = queuedTrips(state);
	// Joins only while a pooled trip is open, on a tick that matches.
	const pool =
		state.pooledOpen > 0 &&
		queued.length > 0 &&
		(state.matching.type === "greedy" ||
			ticked.tick % state.matching.windowTicks === 0)
			? openPool(state)
			: undefined;
	// A pooled trip offered to its best partner's driver; false if none fits.
	const join = (trip: QueuedTrip): boolean => {
		if (pool === undefined || !trip.pooled) return false;
		const partner = takeBestPartner(pool, trip);
		if (partner === undefined) return false;
		offer(trip, partner.driverId);
		return true;
	};
	// A pooled trip offered to an idle driver is a partner from here on.
	const offerIdle = (trip: QueuedTrip, driverId: DriverId) => {
		offer(trip, driverId);
		if (pool !== undefined && trip.pooled) {
			addPartner(state, pool, trip, driverId);
		}
	};
	switch (state.matching.type) {
		case "greedy":
			// Each trip in turn joins a partner (pooled) or takes the nearest idle
			// driver, ties to the lowest ID; the offer makes that driver busy for
			// the next trip.
			for (const trip of queued) {
				if (join(trip)) continue;
				const driverId = nearestIdle(
					state.drivers,
					trip.pickup,
					trip.excludedDrivers,
				);
				if (driverId !== undefined) offerIdle(trip, driverId);
			}
			break;
		case "batched": {
			if (queued.length === 0) break;
			if (ticked.tick % state.matching.windowTicks !== 0) break;
			// Joins first, then batched matching of the rest, then joins for
			// the pooled trips it left without a driver (ADR 0056).
			const rest =
				pool === undefined ? queued : queued.filter((trip) => !join(trip));
			for (const { trip, driverId } of batchedPairs(state, rest)) {
				offerIdle(trip, driverId);
			}
			if (pool === undefined) break;
			for (const trip of rest) {
				// An offer stores a new trip: still this one means unoffered.
				if (state.trips.get(trip.id) === trip) join(trip);
			}
			break;
		}
		default: {
			const unhandled: never = state.matching;
			throw new Error(`unhandled matching: ${unhandled}`);
		}
	}
	// After offering, so the counts are what matching left (ADR 0054).
	if (state.surge && ticked.tick % pricingIntervalTicks === 0) {
		outputs.push(zonesPriced(state, ticked.tick));
	}
	// After offering, so an expired trip and its driver wait for the next tick
	// (ADR 0018); offers made this tick are never due.
	for (const trip of state.trips.values()) {
		if (trip.state !== "requested" || trip.offer === null) continue;
		if (ticked.tick < trip.offer.offeredAt + offerTimeoutTicks) continue;
		const queued = withdrawOffer(trip, trip.offer.driverId);
		if (!queued.ok) throw new Error(`pending offer for ${trip.id} not found`);
		storeTrip(state, queued.value);
		outputs.push({
			type: "trip.offer_expired",
			tick: ticked.tick,
			tripId: trip.id,
			driverId: trip.offer.driverId,
		});
	}
	state.tick = ticked.tick;
	return { state, outputs };
}

// Each zone (its part in this region) with unmatched trips, by pickup,
// against its idle drivers; only zones above 1.0, in zone order.
function zonesPriced(state: DispatchState, tick: Tick): ZonesPriced {
	const unmatched = new Map<Zone, number>();
	for (const trip of state.trips.values()) {
		if (trip.state !== "requested") continue;
		const zone = zoneOf(state.grid, trip.pickup);
		unmatched.set(zone, (unmatched.get(zone) ?? 0) + 1);
	}
	const idle = idleCountsByZone(state.drivers);
	const zones: { zone: Zone; surge: Surge }[] = [];
	for (const zone of [...unmatched.keys()].sort((a, b) => a - b)) {
		const surge = surgeOf(unmatched.get(zone) ?? 0, idle.get(zone) ?? 0);
		if (surge > 1) zones.push({ zone, surge });
	}
	return { type: "zones.priced", tick, region: state.region, zones };
}

type OfferPair = { trip: QueuedTrip; driverId: DriverId };

// A pooled trip holding its driver alone, that driver online (ADR 0056), at
// its cell in dispatch's view; order: the trip's place in request order.
type OpenPartner = Partner & { driverId: DriverId; cell: Cell; order: number };

// One tick's joins: the open partners, and each queued pooled trip's place in
// request order, for the partners it becomes once offered an idle driver.
type Pool = { partners: OpenPartner[]; queuedOrder: Map<TripId, number> };

function openPool(state: DispatchState): Pool {
	const pool: Pool = { partners: [], queuedOrder: new Map() };
	let order = 0;
	for (const trip of state.trips.values()) {
		order++;
		if (!trip.pooled) continue;
		if (trip.state === "requested" && trip.offer === null) {
			pool.queuedOrder.set(trip.id, order);
			continue;
		}
		const driverId = busyDriver(trip);
		if (driverId === undefined || state.holdingTwo.has(driverId)) continue;
		const cell = busyDriverCell(state.drivers, driverId);
		if (cell === undefined) continue;
		pool.partners.push({
			pickup: trip.pickup,
			dropoff: trip.dropoff,
			rideSoFar: rideSoFar(state, trip),
			driverId,
			cell,
			order,
		});
	}
	return pool;
}

// Ticks since a picked-up trip's trip.picked_up, as of dispatch's last tick
// (its view of drivers is that tick's); null before pickup.
function rideSoFar(state: DispatchState, trip: Trip): number | null {
	if (trip.state !== "picked_up") return null;
	const pickedUpAt = state.pickedUpAt.get(trip.id);
	if (pickedUpAt === undefined)
		throw new Error(`${trip.id} has no pickup tick`);
	return state.tick - pickedUpAt;
}

function addPartner(
	state: DispatchState,
	pool: Pool,
	trip: QueuedTrip,
	driverId: DriverId,
): void {
	const order = pool.queuedOrder.get(trip.id);
	const cell = busyDriverCell(state.drivers, driverId);
	if (order === undefined || cell === undefined) {
		throw new Error(`${trip.id} offered to ${driverId} is no partner`);
	}
	pool.partners.push({
		pickup: trip.pickup,
		dropoff: trip.dropoff,
		rideSoFar: null,
		driverId,
		cell,
		order,
	});
}

// The partner with the least join ETA, ties to the earlier requested, never
// one whose driver is excluded for the trip; taken out of the pool (its
// driver will hold two trips).
function takeBestPartner(
	pool: Pool,
	trip: QueuedTrip,
): OpenPartner | undefined {
	let best: { index: number; eta: number; order: number } | undefined;
	for (const [index, partner] of pool.partners.entries()) {
		if (trip.excludedDrivers.has(partner.driverId)) continue;
		const eta = joinEtaOf(partner.cell, partner, trip);
		if (eta === null) continue;
		if (
			best === undefined ||
			eta < best.eta ||
			(eta === best.eta && partner.order < best.order)
		) {
			best = { index, eta, order: partner.order };
		}
	}
	if (best === undefined) return undefined;
	return pool.partners.splice(best.index, 1)[0];
}

// Requested trips without an offer, in FIFO order.
function queuedTrips(state: DispatchState): QueuedTrip[] {
	const queued: QueuedTrip[] = [];
	for (const trip of state.trips.values()) {
		if (trip.state === "requested" && trip.offer === null) queued.push(trip);
	}
	return queued;
}

// ADR 0030: as many pairs as possible, least total pickup distance among
// those. Idle drivers found by nearest queries, unless more trips are queued
// than drivers are idle: then the dense solver over the few idle drivers
// (ADR 0051).
function batchedPairs(
	state: DispatchState,
	queued: readonly QueuedTrip[],
): OfferPair[] {
	if (queued.length > idleCount(state.drivers)) {
		return densePairs(queued, idleDriversById(state.drivers));
	}
	return minCostMatchingByNearest(
		queued,
		(pickup, skip) => nearestIdleSkipping(state.drivers, pickup, skip),
		state.grid,
	).map(({ row, driverId }) => {
		const trip = queued[row];
		if (trip === undefined) throw new Error(`matching row ${row} out of range`);
		return { trip, driverId };
	});
}

function densePairs(
	queued: readonly QueuedTrip[],
	idle: readonly IdleDriver[],
): OfferPair[] {
	// More trips than idle drivers: the solver solves the transpose and asks
	// for drivers' columns only.
	const ofRow = () => {
		throw new Error("dense matching asked for a trip's row");
	};
	const ofColumn = (column: number, out: number[]) => {
		const driver = idle[column];
		if (driver === undefined) throw new Error(`column ${column} out of range`);
		for (const [row, trip] of queued.entries()) {
			out[row] = trip.excludedDrivers.has(driver.driverId)
				? Number.POSITIVE_INFINITY
				: distance(driver.cell, trip.pickup);
		}
	};
	return minCostMatching(queued.length, idle.length, { ofRow, ofColumn }).map(
		({ row, column }) => {
			const trip = queued[row];
			const driver = idle[column];
			if (trip === undefined || driver === undefined) {
				throw new Error(`matching pair (${row}, ${column}) out of range`);
			}
			return { trip, driverId: driver.driverId };
		},
	);
}

function onRequestTrip(state: DispatchState, request: RequestTrip): Decision {
	if (knownTrip(state, request.tripId) !== undefined) {
		return {
			state,
			outputs: [
				{
					type: "request_trip_rejected",
					tripId: request.tripId,
					error: { type: "duplicate_trip_id" },
				},
			],
		};
	}
	storeTrip(state, requestedTrip(request));
	return {
		state,
		outputs: [
			{ type: "request_trip_accepted", tripId: request.tripId },
			{
				type: "trip.requested",
				tick: request.tick,
				tripId: request.tripId,
				riderId: request.riderId,
				pickup: request.pickup,
				dropoff: request.dropoff,
				...(state.surge ? price(request) : {}),
				...(request.pooled ? { pooled: true as const } : {}),
			},
		],
	};
}

// The rider's quote is the trip's price, fixed from here (ADR 0054).
function price(request: RequestTrip): { surge: Surge; fare: Fare } {
	const surge = request.surge ?? baseSurge;
	return { surge, fare: fareOf(request, surge) };
}

function onCancelTrip(state: DispatchState, command: CancelTrip): Decision {
	const trip = knownTrip(state, command.tripId);
	if (trip === undefined) {
		return {
			state,
			outputs: [
				{
					type: "cancel_trip_rejected",
					tripId: command.tripId,
					error: { type: "unknown_trip" },
				},
			],
		};
	}
	const cancelled = cancel(trip);
	if (!cancelled.ok) {
		return {
			state,
			outputs: [
				{
					type: "cancel_trip_rejected",
					tripId: trip.id,
					error: { type: cancelled.error.type, from: cancelled.error.from },
				},
			],
		};
	}
	storeTrip(state, cancelled.value);
	return {
		state,
		outputs: [
			{ type: "cancel_trip_accepted", tripId: trip.id },
			{
				type: "trip.cancelled",
				tick: state.tick,
				tripId: trip.id,
				driverId: cancelled.value.driverId,
			},
		],
	};
}

// A message from a fleet of another size names other drivers by its indexes
// (ADR 0052): rejected whole, its drivers unknown until a matching message.
function onDriversAt(
	state: DispatchState,
	message: DriversWentOnline | DriversMoved,
): Decision {
	if (message.fleetSize !== state.fleetSize) {
		return {
			state,
			outputs: [
				{
					type: "input_rejected",
					reason: "fleet_size_mismatch",
					input: message,
					expectedFleetSize: state.fleetSize,
				},
			],
		};
	}
	forEachDriverAt(message, (driverIndex, x, y) => {
		placeDriverAt(state.drivers, driverIndex, x, y);
	});
	return { state, outputs: [] };
}

function onDriverWentOffline(
	state: DispatchState,
	wentOffline: DriverWentOffline,
): Decision {
	removeDriver(state.drivers, wentOffline.driverId);
	return { state, outputs: [] };
}

// Replies to offers already declined, expired, or cancelled with their trip
// are stale (ADR 0022): ignored.
function onOfferReply(
	state: DispatchState,
	reply: OfferAccepted | OfferDeclined,
): Decision {
	const trip = knownTrip(state, reply.tripId);
	if (trip === undefined) return { state, outputs: [] };
	if (trip.state === "cancelled") return { state, outputs: [] };
	if (trip.excludedDrivers.has(reply.driverId)) return { state, outputs: [] };
	const accepted = reply.type === "offer_accepted";
	const next = accepted
		? acceptOffer(trip, reply.driverId)
		: withdrawOffer(trip, reply.driverId);
	if (!next.ok) {
		return {
			state,
			outputs: [
				{ type: "input_rejected", reason: next.error.type, input: reply },
			],
		};
	}
	// A decline says where the driver is before its offer frees it: idle at a
	// cell, or not idle (offline, or on another region's trip), so a driver
	// whose move out of the region was lost is dropped (ADR 0050).
	if (reply.type === "offer_declined") {
		if (reply.idleAt === null) removeDriver(state.drivers, reply.driverId);
		else {
			placeDriver(
				state.drivers,
				reply.driverId,
				reply.idleAt.x,
				reply.idleAt.y,
			);
		}
	}
	storeTrip(state, next.value);
	return {
		state,
		outputs: [
			{
				type: accepted ? "trip.matched" : "trip.offer_declined",
				tick: state.tick,
				tripId: trip.id,
				driverId: reply.driverId,
			},
		],
	};
}

function onArrival(
	state: DispatchState,
	arrival: DriverArrivedAtPickup | DriverArrivedAtDropoff,
): Decision {
	const trip = knownTrip(state, arrival.tripId);
	if (trip === undefined) return { state, outputs: [] };
	// The rider's cancel reached dispatch first: a legitimate race, not an error.
	if (trip.state === "cancelled") return { state, outputs: [] };
	// Its offer expired before its accept arrived; trip.offer_expired frees it.
	if (trip.excludedDrivers.has(arrival.driverId)) return { state, outputs: [] };
	return arrive(
		state,
		trip,
		arrival,
		arrival.type === "driver.arrived_at_pickup",
	);
}

// The arrival transition and its checks, for driver.arrived_at_* and a
// confirm_trip standing in for one (ADR 0041).
function arrive(
	state: DispatchState,
	trip: Trip,
	input: DriverArrivedAtPickup | DriverArrivedAtDropoff | ConfirmTrip,
	atPickup: boolean,
): Decision {
	const next = atPickup
		? pickUp(trip, input.driverId, input.cell)
		: complete(trip, input.driverId, input.cell);
	if (!next.ok) {
		return {
			state,
			outputs: [{ type: "input_rejected", reason: next.error.type, input }],
		};
	}
	// The arrival's cell is the driver's latest before its trip frees it, so a
	// lost last move can't leave it idle at a stale cell (ADR 0050). Only here:
	// a rejected arrival may name an idle driver.
	placeDriver(state.drivers, input.driverId, input.cell.x, input.cell.y);
	storeTrip(state, next.value);
	if (trip.pooled) {
		if (atPickup) state.pickedUpAt.set(trip.id, state.tick);
		else state.pickedUpAt.delete(trip.id);
	}
	return {
		state,
		outputs: [
			{
				type: atPickup ? "trip.picked_up" : "trip.completed",
				tick: state.tick,
				tripId: trip.id,
				driverId: input.driverId,
			},
		],
	};
}

// ADR 0041's table: a trip that is not this driver's releases it.
function onConfirmTrip(state: DispatchState, confirm: ConfirmTrip): Decision {
	const trip = knownTrip(state, confirm.tripId);
	if (trip === undefined) return replyStatus(state, confirm, "released");
	const atPickup = confirm.stage === "pickup";
	switch (trip.state) {
		case "requested":
			if (trip.offer?.driverId !== confirm.driverId) break;
			// The offer's accept or trip.offer_expired resolves it; a dropoff
			// confirm fails the arrival checks.
			if (atPickup) return { state, outputs: [] };
			return arrive(state, trip, confirm, false);
		case "matched":
			if (trip.driverId !== confirm.driverId) break;
			return arrive(state, trip, confirm, atPickup);
		case "picked_up":
			if (trip.driverId !== confirm.driverId) break;
			if (atPickup) return replyStatus(state, confirm, "picked_up");
			return arrive(state, trip, confirm, false);
		case "completed":
			if (trip.driverId !== confirm.driverId) break;
			return replyStatus(state, confirm, "completed");
		case "cancelled":
			break;
		default: {
			const unhandled: never = trip;
			throw new Error(`unhandled trip state: ${unhandled}`);
		}
	}
	return replyStatus(state, confirm, "released");
}

function replyStatus(
	state: DispatchState,
	confirm: ConfirmTrip,
	status: TripStatus["status"],
): Decision {
	return {
		state,
		outputs: [
			{
				type: "trip_status",
				tripId: confirm.tripId,
				driverId: confirm.driverId,
				stage: confirm.stage,
				status,
			},
		],
	};
}

function knownTrip(state: DispatchState, tripId: TripId): Trip | undefined {
	return state.trips.get(tripId) ?? state.endedTrips.get(tripId);
}

// An ended trip moves to endedTrips; a trip keeps its place in request order
// until then. Every trip change goes through here, so drivers' busy marks
// follow their trips: busy from the first offer until its last offer or trip
// is over.
function storeTrip(state: DispatchState, trip: Trip): void {
	const stored = state.trips.get(trip.id);
	const wasBusy = busyDriver(stored);
	const nowBusy = busyDriver(trip);
	if (wasBusy !== nowBusy) {
		if (wasBusy !== undefined) release(state, trip, wasBusy);
		if (nowBusy !== undefined) hold(state, trip, nowBusy);
	}
	if (trip.state !== "completed" && trip.state !== "cancelled") {
		if (trip.pooled && stored === undefined) state.pooledOpen++;
		state.trips.set(trip.id, trip);
		return;
	}
	if (trip.pooled) state.pooledOpen--;
	state.trips.delete(trip.id);
	state.endedTrips.set(trip.id, trip);
}

// Only a pooled trip can be a busy driver's second (a join, ADR 0056), so
// with pooling off these only mark busy and free.
function hold(state: DispatchState, trip: Trip, driverId: DriverId): void {
	if (trip.pooled && isBusy(state.drivers, driverId)) {
		state.holdingTwo.add(driverId);
		return;
	}
	markBusy(state.drivers, driverId);
}

function release(state: DispatchState, trip: Trip, driverId: DriverId): void {
	if (trip.pooled && state.holdingTwo.delete(driverId)) return;
	markFree(state.drivers, driverId);
}

// The driver a trip keeps from other trips: its offered or matched driver.
function busyDriver(trip: Trip | undefined): DriverId | undefined {
	if (trip === undefined) return undefined;
	switch (trip.state) {
		case "requested":
			return trip.offer?.driverId;
		case "matched":
		case "picked_up":
			return trip.driverId;
		case "completed":
		case "cancelled":
			return undefined;
		default: {
			const unhandled: never = trip;
			throw new Error(`unhandled trip state: ${unhandled}`);
		}
	}
}
