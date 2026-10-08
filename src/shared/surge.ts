// SPIKE (#295): surge pricing knobs from env, not for merge.
import { type Cell, distance, type Grid } from "./grid.ts";

const env = process.env;
export const surge = {
	on: env.SPIKE_SURGE === "on",
	zoneCells: Number(env.SPIKE_ZONE ?? 50),
	everyTicks: Number(env.SPIKE_EVERY ?? 30),
	cap: Number(env.SPIKE_CAP ?? 3),
	// Rider's max surge uniform in [1, maxWilling].
	maxWilling: Number(env.SPIKE_WMAX ?? 3),
	// "ratio": waiting / max(idle, 1); "excess": 1 + 0.25 * (waiting - idle) / max(idle,1)
	formula: env.SPIKE_FORMULA ?? "ratio",
};

export function zoneOf(grid: Grid, cell: Cell): number {
	const columns = Math.ceil(grid.width / surge.zoneCells);
	return (
		Math.floor(cell.y / surge.zoneCells) * columns +
		Math.floor(cell.x / surge.zoneCells)
	);
}

export function surgeOf(waiting: number, idle: number): number {
	const ratio = waiting / Math.max(idle, 1);
	const raw = surge.formula === "ratio" ? ratio : 1 + 0.5 * (ratio - 1);
	return Math.min(surge.cap, Math.max(1, Math.round(raw * 10) / 10));
}

export function fareOf(pickup: Cell, dropoff: Cell, multiplier: number) {
	return Math.round((250 + 2 * distance(pickup, dropoff)) * multiplier);
}
