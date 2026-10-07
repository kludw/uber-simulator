import { distance, distanceToCoordinates, type Grid } from "../shared/grid.ts";
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
} from "../shared/messages.ts";
import { forEachDriverAt } from "../shared/messages.ts";
import type { Random } from "../shared/random.ts";
import {
	oneRegion,
	Region,
	type RegionLayout,
	regionBounds,
} from "../shared/regions.ts";
import {
	type IdleDriver,
	type IdleDrivers,
	idleCell,
	idleCount,
	idleDriversById,
	markBusy,
	markFree,
	nearestIdle,
	placeDriver,
	removeDriver,
	startIdleDrivers,
} from "./idle-drivers.ts";
import { lazyMinCostMatching } from "./lazy-matching.ts";
import { minCostMatching } from "./matching.ts";
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
// trips, endedTrips, and drivers are owned and updated in place (ADR 0033).
export type DispatchState = {
	grid: Grid;
	tick: Tick;
	matching: Matching;
	trips: Map<TripId, Trip>;
	endedTrips: Map<TripId, EndedTrip>;
	drivers: IdleDrivers;
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
	| InputRejected<OfferAccepted | OfferDeclined, NoPendingOffer["type"]>
	| InputRejected<
			DriverArrivedAtPickup | DriverArrivedAtDropoff | ConfirmTrip,
			ArrivalRejected["type"]
	  >;

type Decision = { state: DispatchState; outputs: DispatchOutput[] };

// ADR 0018.
const offerTimeoutTicks = 3;

// regions, region: the layout and the region this instance owns (ADR 0050);
// missing = one region.
export function startDispatch(config: {
	grid: Grid;
	tick: Tick;
	matching?: Matching | undefined;
	regions?: RegionLayout;
	region?: Region;
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
	return {
		grid: config.grid,
		tick: config.tick,
		matching,
		trips: new Map(),
		endedTrips: new Map(),
		drivers: startIdleDrivers(
			config.grid,
			regionBounds(
				config.regions ?? oneRegion,
				config.grid,
				config.region ?? Region.parse(0),
			),
		),
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
			forEachDriverAt(input, (driverId, x, y) => {
				placeDriver(state.drivers, driverId, x, y);
			});
			return { state, outputs: [] };
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
			},
			{ type: "trip.offered", tick: ticked.tick, tripId: trip.id, driverId },
		);
	};
	const queued = queuedTrips(state);
	switch (state.matching.type) {
		case "greedy":
			// Each trip in turn takes the nearest idle driver, ties to the lowest
			// ID; the offer makes that driver busy for the next trip.
			for (const trip of queued) {
				const driverId = nearestIdle(
					state.drivers,
					trip.pickup,
					trip.excludedDrivers,
				);
				if (driverId !== undefined) offer(trip, driverId);
			}
			break;
		case "batched":
			if (queued.length === 0) break;
			if (ticked.tick % state.matching.windowTicks !== 0) break;
			{
				// #240 experiment, not merged: solver choice and per-batch stats.
				const started = performance.now();
				const idleTotal = idleCount(state.drivers);
				const lazy =
					process.env.BATCH_SOLVER === "lazy" && queued.length <= idleTotal;
				const pairs = lazy
					? lazyMinCostMatching(
							queued,
							state.drivers,
							state.grid.width + state.grid.height - 2,
						).map(({ row, driverId }) => ({
							trip: queued[row] as QueuedTrip,
							driverId,
						}))
					: batchedPairs(queued, idleDriversById(state.drivers));
				if (
					process.env.BATCH_CHECK !== undefined &&
					queued.length <= idleTotal
				) {
					// Both solvers on the same input: same pair count and distance.
					const sum = (list: { trip: QueuedTrip; driverId: DriverId }[]) =>
						list.reduce((total, { trip, driverId }) => {
							const cell = idleCell(state.drivers, driverId);
							return total + distanceToCoordinates(trip.pickup, cell.x, cell.y);
						}, 0);
					const dense = batchedPairs(queued, idleDriversById(state.drivers));
					const other = lazyMinCostMatching(
						queued,
						state.drivers,
						state.grid.width + state.grid.height - 2,
					).map(({ row, driverId }) => ({
						trip: queued[row] as QueuedTrip,
						driverId,
					}));
					if (dense.length !== other.length || sum(dense) !== sum(other)) {
						throw new Error(
							`mismatch tick ${ticked.tick}: dense ${dense.length}/${sum(dense)} lazy ${other.length}/${sum(other)}`,
						);
					}
					console.error(
						`check tick=${ticked.tick} ok ${dense.length}/${sum(dense)}`,
					);
				}
				if (process.env.BATCH_STATS !== undefined) {
					const total = pairs.reduce(
						(sum, { trip, driverId }) =>
							sum +
							distanceToCoordinates(
								trip.pickup,
								idleCell(state.drivers, driverId).x,
								idleCell(state.drivers, driverId).y,
							),
						0,
					);
					console.error(
						`batch tick=${ticked.tick} queued=${queued.length} idle=${idleTotal} pairs=${pairs.length} distance=${total} ms=${(performance.now() - started).toFixed(2)} solver=${lazy ? "lazy" : "dense"}`,
					);
				}
				for (const { trip, driverId } of pairs) offer(trip, driverId);
			}
			break;
		default: {
			const unhandled: never = state.matching;
			throw new Error(`unhandled matching: ${unhandled}`);
		}
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

type OfferPair = { trip: QueuedTrip; driverId: DriverId };

// Requested trips without an offer, in FIFO order.
function queuedTrips(state: DispatchState): QueuedTrip[] {
	const queued: QueuedTrip[] = [];
	for (const trip of state.trips.values()) {
		if (trip.state === "requested" && trip.offer === null) queued.push(trip);
	}
	return queued;
}

// ADR 0030: as many pairs as possible, least total pickup distance among those.
function batchedPairs(
	queued: readonly QueuedTrip[],
	idle: readonly IdleDriver[],
): OfferPair[] {
	// A trip's row is asked for more than once per batch (#213): drivers' cells
	// as flat coordinates, read in order.
	const driverXs = Int32Array.from(idle, ({ cell }) => cell.x);
	const driverYs = Int32Array.from(idle, ({ cell }) => cell.y);
	let columnOf: Map<DriverId, number> | undefined;
	const ofRow = (row: number, out: number[]) => {
		const trip = queued[row];
		if (trip === undefined) throw new Error(`row ${row} out of range`);
		for (let column = 0; column < idle.length; column++) {
			const x = driverXs[column];
			const y = driverYs[column];
			if (x === undefined || y === undefined) {
				throw new Error(`column ${column} out of range`);
			}
			out[column] = distanceToCoordinates(trip.pickup, x, y);
		}
		if (trip.excludedDrivers.size === 0) return;
		columnOf ??= new Map(
			idle.map(({ driverId }, column) => [driverId, column]),
		);
		for (const driverId of trip.excludedDrivers) {
			const column = columnOf.get(driverId);
			if (column !== undefined) out[column] = Number.POSITIVE_INFINITY;
		}
	};
	// Only when more trips are queued than drivers are idle.
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
			},
		],
	};
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
// follow their trips: busy from the offer until the offer or trip is over.
function storeTrip(state: DispatchState, trip: Trip): void {
	const wasBusy = busyDriver(state.trips.get(trip.id));
	const nowBusy = busyDriver(trip);
	if (wasBusy !== nowBusy) {
		if (wasBusy !== undefined) markFree(state.drivers, wasBusy);
		if (nowBusy !== undefined) markBusy(state.drivers, nowBusy);
	}
	if (trip.state !== "completed" && trip.state !== "cancelled") {
		state.trips.set(trip.id, trip);
		return;
	}
	state.trips.delete(trip.id);
	state.endedTrips.set(trip.id, trip);
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
