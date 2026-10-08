import { describe, expect, test } from "bun:test";
import { DriverIndex } from "../shared/fleet.ts";
import { Cell } from "../shared/grid.ts";
import {
	DriverId,
	driversWentOnline,
	Tick,
	TripId,
} from "../shared/messages.ts";
import { Region } from "../shared/regions.ts";
import { Fare, Surge, Zone } from "../shared/surge.ts";
import { panelRows } from "./panel.ts";
import {
	activeTripColor,
	driverColors,
	heatmapColors,
	surgeColor,
	waitingRiderColor,
} from "./render.ts";
import { applyEvent, emptyView, type View } from "./view.ts";

function labelsAndValues(rows: ReturnType<typeof panelRows>): string[][] {
	return rows.map((row) => [row.label, row.value]);
}

describe("panelRows", () => {
	test("shows zero counters and no tick or mean before any event", () => {
		expect(labelsAndValues(panelRows(emptyView()))).toEqual([
			["Tick", "-"],
			["Drawn", "dots"],
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
		const fare = Fare.parse(258);
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
				[
					TripId.parse("t-1"),
					{ pickup, dropoff, requestedAt: Tick.parse(40), fare },
				],
			]),
			activeTrips: new Map([
				[
					TripId.parse("t-2"),
					{ driverId: DriverId.parse("d-1"), pickup, dropoff, fare },
				],
				[
					TripId.parse("t-3"),
					{ driverId: DriverId.parse("d-2"), pickup, dropoff, fare },
				],
			]),
			tripsCompleted: 7,
			tripsCancelled: 6,
			meanTicksToPickup: 12.345,
			pickups: 3,
		};
		expect(labelsAndValues(panelRows(view))).toEqual([
			["Tick", "42"],
			["Drawn", "dots"],
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
			["Drawn", null],
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

	describe("above 10,000 drivers", () => {
		const view = emptyView();
		applyEvent(
			view,
			driversWentOnline(Tick.parse(1), Region.parse(0), 10_001, [
				{ driverIndex: DriverIndex.parse(0), cell: Cell.parse({ x: 0, y: 0 }) },
			]),
		);

		test("says the heatmap is drawn", () => {
			const drawn = panelRows(view).find((row) => row.label === "Drawn");
			expect(drawn?.value).toBe("heatmap, 5 × 5-cell tiles");
		});

		// Tiles colored idle to busy; no trip lines.
		test("marks drivers and waiting riders as the heatmap's tile colors", () => {
			const swatches = panelRows(view).map((row) => [row.label, row.swatch]);
			expect(swatches).toEqual([
				["Tick", null],
				["Drawn", null],
				["Idle", { shape: "tile", color: heatmapColors.idle }],
				["En route", { shape: "tile", color: heatmapColors.busy }],
				["At pickup", { shape: "tile", color: heatmapColors.busy }],
				["On trip", { shape: "tile", color: heatmapColors.busy }],
				["At dropoff", { shape: "tile", color: heatmapColors.busy }],
				[
					"Waiting riders",
					{ shape: "tile", color: heatmapColors.waitingRiders },
				],
				["Active trips", null],
				["Trips completed", null],
				["Trips cancelled", null],
				["Mean ticks to pickup", null],
			]);
		});
	});

	// ADR 0054. With surge off no zones.priced arrives: no surge rows (above).
	describe("once zones are priced", () => {
		const priced = (zone: number, surge: number) => ({
			zone: Zone.parse(zone),
			surge: Surge.parse(surge),
		});

		test("adds surging zones, max surge, riders declined, and revenue in dollars", () => {
			const view: View = {
				...emptyView(),
				zonesPriced: new Map([
					[Region.parse(0), [priced(3, 1.4), priced(5, 2)]],
					[Region.parse(1), [priced(5, 1.3)]],
				]),
				ridersDeclined: 12,
				revenue: 432_150,
			};
			expect(labelsAndValues(panelRows(view)).slice(-4)).toEqual([
				["Surging zones", "3"],
				["Max surge", "2.0×"],
				["Riders declined", "12"],
				["Revenue", "$4,321.50"],
			]);
		});

		test("shows no surge as 1.0×", () => {
			const view: View = {
				...emptyView(),
				zonesPriced: new Map([[Region.parse(0), []]]),
			};
			expect(labelsAndValues(panelRows(view)).slice(-4, -2)).toEqual([
				["Surging zones", "0"],
				["Max surge", "1.0×"],
			]);
		});

		test("marks surging zones as the canvas tints them", () => {
			const view: View = {
				...emptyView(),
				zonesPriced: new Map([[Region.parse(0), []]]),
			};
			const surging = panelRows(view).find(
				(row) => row.label === "Surging zones",
			);
			expect(surging?.swatch).toEqual({ shape: "tile", color: surgeColor });
		});
	});
});
