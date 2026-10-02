import { describe, expect, test } from "bun:test";
import { type Cell, cellIn, type Grid } from "../shared/grid.ts";
import {
	DriverId,
	type RequestTrip,
	RiderId,
	Tick,
	TripId,
} from "../shared/messages.ts";
import { createRandom } from "../shared/random.ts";
import { decideDispatch, knownDriverCell, startDispatch } from "./brain.ts";

const grid: Grid = { width: 10, height: 10 };
const d1 = DriverId.parse("d-1");
const t1 = TripId.parse("t-1");
const r1 = RiderId.parse("r-1");
const random = createRandom(1);

function cell(x: number, y: number): Cell {
	const result = cellIn(grid, x, y);
	if (!result.ok) throw new Error(`test cell (${x}, ${y}) outside grid`);
	return result.value;
}

function tick(n: number): Tick {
	return Tick.parse(n);
}

function requestTrip(tripId: TripId, at: number): RequestTrip {
	return {
		type: "request_trip",
		tick: tick(at),
		tripId,
		riderId: r1,
		pickup: cell(1, 2),
		dropoff: cell(7, 8),
	};
}

describe("decideDispatch request_trip", () => {
	test("accepts a new trip request and announces it requested", () => {
		const { outputs } = decideDispatch(
			startDispatch({ grid }),
			requestTrip(t1, 4),
			random,
		);

		expect(outputs).toEqual([
			{ type: "request_trip_accepted", tripId: t1 },
			{
				type: "trip.requested",
				tick: tick(4),
				tripId: t1,
				riderId: r1,
				pickup: cell(1, 2),
				dropoff: cell(7, 8),
			},
		]);
	});

	test("rejects a request reusing a known trip ID without announcing it", () => {
		const first = decideDispatch(
			startDispatch({ grid }),
			requestTrip(t1, 4),
			random,
		);

		const { outputs } = decideDispatch(first.state, requestTrip(t1, 6), random);

		expect(outputs).toEqual([
			{
				type: "request_trip_rejected",
				tripId: t1,
				error: { type: "duplicate_trip_id" },
			},
		]);
	});
});

describe("dispatch driver view", () => {
	test("knows where a driver went online", () => {
		const { state } = decideDispatch(
			startDispatch({ grid }),
			{
				type: "driver.went_online",
				tick: tick(0),
				driverId: d1,
				cell: cell(3, 3),
			},
			random,
		);

		expect(knownDriverCell(state, d1)).toEqual(cell(3, 3));
	});

	test("follows a driver to the cell it last moved to", () => {
		const online = decideDispatch(
			startDispatch({ grid }),
			{
				type: "driver.went_online",
				tick: tick(0),
				driverId: d1,
				cell: cell(3, 3),
			},
			random,
		);

		const { state } = decideDispatch(
			online.state,
			{ type: "driver.moved", tick: tick(1), driverId: d1, cell: cell(3, 4) },
			random,
		);

		expect(knownDriverCell(state, d1)).toEqual(cell(3, 4));
	});
});
