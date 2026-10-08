import {
	activeTripColor,
	drawModeOf,
	driverColors,
	heatmapColors,
	waitingRiderColor,
} from "./render.ts";
import type { View } from "./view.ts";

// How the canvas draws what a row counts, so the panel doubles as its legend.
export type Swatch = {
	shape: "dot" | "square" | "line" | "tile";
	color: string;
};

export type PanelRow = { label: string; value: string; swatch: Swatch | null };

const noValue = "-";

type Legend = Record<
	keyof View["driversPerState"] | "waitingRiders" | "activeTrips",
	Swatch | null
>;

const dot = (color: string): Swatch => ({ shape: "dot", color });
const tile = (color: string): Swatch => ({ shape: "tile", color });

const legends = {
	dots: {
		idle: dot(driverColors.idle),
		en_route: dot(driverColors.en_route),
		at_pickup: dot(driverColors.at_pickup),
		on_trip: dot(driverColors.on_trip),
		at_dropoff: dot(driverColors.at_dropoff),
		waitingRiders: { shape: "square", color: waitingRiderColor },
		activeTrips: { shape: "line", color: activeTripColor },
	},
	// Tiles colored idle to busy by their busy share; no trip lines.
	heatmap: {
		idle: tile(heatmapColors.idle),
		en_route: tile(heatmapColors.busy),
		at_pickup: tile(heatmapColors.busy),
		on_trip: tile(heatmapColors.busy),
		at_dropoff: tile(heatmapColors.busy),
		waitingRiders: tile(heatmapColors.waitingRiders),
		activeTrips: null,
	},
} satisfies Record<string, Legend>;

const drawnLabels = { dots: "dots", heatmap: "heatmap, 5 × 5-cell tiles" };

export function panelRows(view: View): PanelRow[] {
	const drivers = view.driversPerState;
	const mode = drawModeOf(view);
	const legend: Legend = legends[mode];
	return [
		{
			label: "Tick",
			value: view.tick === null ? noValue : String(view.tick),
			swatch: null,
		},
		{ label: "Drawn", value: drawnLabels[mode], swatch: null },
		{
			label: "Idle",
			value: String(drivers.idle),
			swatch: legend.idle,
		},
		{
			label: "En route",
			value: String(drivers.en_route),
			swatch: legend.en_route,
		},
		{
			label: "At pickup",
			value: String(drivers.at_pickup),
			swatch: legend.at_pickup,
		},
		{
			label: "On trip",
			value: String(drivers.on_trip),
			swatch: legend.on_trip,
		},
		{
			label: "At dropoff",
			value: String(drivers.at_dropoff),
			swatch: legend.at_dropoff,
		},
		{
			label: "Waiting riders",
			value: String(view.waitingRiders.size),
			swatch: legend.waitingRiders,
		},
		{
			label: "Active trips",
			value: String(view.activeTrips.size),
			swatch: legend.activeTrips,
		},
		{
			label: "Trips completed",
			value: String(view.tripsCompleted),
			swatch: null,
		},
		{
			label: "Trips cancelled",
			value: String(view.tripsCancelled),
			swatch: null,
		},
		{
			label: "Mean ticks to pickup",
			value:
				view.meanTicksToPickup === null
					? noValue
					: view.meanTicksToPickup.toFixed(1),
			swatch: null,
		},
	];
}
