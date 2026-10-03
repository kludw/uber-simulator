import { describe, expect, test } from "bun:test";
import { Cell } from "../shared/grid.ts";
import { DriverId, Tick, TripId } from "../shared/messages.ts";
import { panelRows } from "./panel.ts";
import {
	activeTripColor,
	driverColors,
	waitingRiderColor,
} from "./render.ts";
import { emptyView, type View } from "./view.ts";

function labelsAndValues(rows: ReturnType<typeof panelRows>): string[][] {
	return rows.map((row) => [row.label, row.value]);
}

describe("panelRows", () => {
	test("shows zero counters and no tick or mean before any event", () => {
		expect(labelsAndValues(panelRows(emptyView()))).toEqual([
			["Tick", "-"],
			["Idle", "0"],
			["En route", "0"],
			["At pickup", "0"],
			["On trip", "0"],
			["At dropoff", "0"],
			["Waiting riders", "0"],
			["Active trips", "0"],
			["Trips completed", "0"],
			["Trips cancelled", "0"],
			["Mean ticks to pickup", "-"],
		]);
	});

	test("shows the view's tick, counters, and mean ticks to pickup to one decimal", () => {
		const pickup = Cell.parse({ x: 1, y: 2 });
		const dropoff = Cell.parse({ x: 3, y: 4 });
		const view: View = {
			...emptyView(),
			tick: Tick.parse(42),
			driversPerState: {
				idle: 5,
				en_route: 4,
				at_pickup: 3,
				on_trip: 2,
				at_dropoff: 1,
			},
			waitingRiders: new Map([
				[TripId.parse("t-1"), { pickup, dropoff, requestedAt: Tick.parse(40) }],
			]),
			activeTrips: new Map([
				[
					TripId.parse("t-2"),
					{ driverId: DriverId.parse("d-1"), pickup, dropoff },
				],
				[
					TripId.parse("t-3"),
					{ driverId: DriverId.parse("d-2"), pickup, dropoff },
				],
			]),
			tripsCompleted: 7,
			tripsCancelled: 6,
			meanTicksToPickup: 12.345,
			pickups: 3,
		};
		expect(labelsAndValues(panelRows(view))).toEqual([
			["Tick", "42"],
			["Idle", "5"],
			["En route", "4"],
			["At pickup", "3"],
			["On trip", "2"],
			["At dropoff", "1"],
			["Waiting riders", "1"],
			["Active trips", "2"],
			["Trips completed", "7"],
			["Trips cancelled", "6"],
			["Mean ticks to pickup", "12.3"],
		]);
	});

	// The panel is the canvas's legend: same colors, same shapes.
	test("marks driver states, waiting riders, and active trips as the canvas draws them", () => {
		const swatches = panelRows(emptyView()).map((row) => [
			row.label,
			row.swatch,
		]);
		expect(swatches).toEqual([
			["Tick", null],
			["Idle", { shape: "dot", color: driverColors.idle }],
			["En route", { shape: "dot", color: driverColors.en_route }],
			["At pickup", { shape: "dot", color: driverColors.at_pickup }],
			["On trip", { shape: "dot", color: driverColors.on_trip }],
			["At dropoff", { shape: "dot", color: driverColors.at_dropoff }],
			["Waiting riders", { shape: "square", color: waitingRiderColor }],
			["Active trips", { shape: "line", color: activeTripColor }],
			["Trips completed", null],
			["Trips cancelled", null],
			["Mean ticks to pickup", null],
		]);
	});
});
