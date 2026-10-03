import { activeTripColor, driverColors, waitingRiderColor } from "./render.ts";
import type { View } from "./view.ts";

// How the canvas draws what a row counts, so the panel doubles as its legend.
export type Swatch = { shape: "dot" | "square" | "line"; color: string };

export type PanelRow = { label: string; value: string; swatch: Swatch | null };

const noValue = "-";

export function panelRows(view: View): PanelRow[] {
	const drivers = view.driversPerState;
	const dot = (color: string): Swatch => ({ shape: "dot", color });
	return [
		{
			label: "Tick",
			value: view.tick === null ? noValue : String(view.tick),
			swatch: null,
		},
		{
			label: "Idle",
			value: String(drivers.idle),
			swatch: dot(driverColors.idle),
		},
		{
			label: "En route",
			value: String(drivers.en_route),
			swatch: dot(driverColors.en_route),
		},
		{
			label: "At pickup",
			value: String(drivers.at_pickup),
			swatch: dot(driverColors.at_pickup),
		},
		{
			label: "On trip",
			value: String(drivers.on_trip),
			swatch: dot(driverColors.on_trip),
		},
		{
			label: "At dropoff",
			value: String(drivers.at_dropoff),
			swatch: dot(driverColors.at_dropoff),
		},
		{
			label: "Waiting riders",
			value: String(view.waitingRiders.size),
			swatch: { shape: "square", color: waitingRiderColor },
		},
		{
			label: "Active trips",
			value: String(view.activeTrips.size),
			swatch: { shape: "line", color: activeTripColor },
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
