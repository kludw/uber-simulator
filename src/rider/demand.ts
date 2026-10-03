// Where riders' pickups come from (ADR 0031).
import {
	type Cell,
	cellIn,
	distance,
	type Grid,
	randomCell,
	specGrid,
} from "../shared/grid.ts";
import type { Tick } from "../shared/messages.ts";
import type { Random } from "../shared/random.ts";

type Hotspot = { center: Cell; radius: number; weight: number };

export type Demand =
	| { type: "uniform" }
	| {
			type: "hotspots";
			// Chance a pickup comes from a hotspot rather than the whole grid.
			hotspotShare: number;
			hotspots: readonly Hotspot[];
	  };

// Preset for the spec grid (500 x 500, 1 cell = 10 m). Downtown: 500 m radius
// at the center, 3x the airport's weight. Airport: 250 m radius, 500 m in from
// the bottom-right corner. Share 0.6: clearly clustered, while the uniform 40%
// still spreads riders over the whole city.
export const cityDemand: Demand = {
	type: "hotspots",
	hotspotShare: 0.6,
	hotspots: [
		{ center: specCell(250, 250), radius: 50, weight: 3 },
		{ center: specCell(450, 450), radius: 25, weight: 1 },
	],
};

function specCell(x: number, y: number): Cell {
	const cell = cellIn(specGrid, x, y);
	if (!cell.ok) throw new Error(`preset cell (${x}, ${y}) outside spec grid`);
	return cell.value;
}

// Config is parsed at the edge (CLI, env), so an invalid one here is a bug.
// Negated comparisons also reject NaN.
export function assertValidDemand(demand: Demand, grid: Grid): void {
	if (demand.type === "uniform") return;
	const { hotspotShare, hotspots } = demand;
	if (!(hotspotShare >= 0 && hotspotShare <= 1)) {
		throw new Error(`hotspot share ${hotspotShare} outside [0, 1]`);
	}
	if (hotspots.length === 0) throw new Error("hotspot demand without hotspots");
	for (const { center, radius, weight } of hotspots) {
		if (!(weight > 0)) throw new Error(`hotspot weight ${weight} not > 0`);
		if (!Number.isInteger(radius) || radius < 0) {
			throw new Error(`hotspot radius ${radius} not an integer >= 0`);
		}
		// Sampling relies on it: the clipped hotspot then holds at least the center.
		if (center.x >= grid.width || center.y >= grid.height) {
			throw new Error(`hotspot center (${center.x}, ${center.y}) outside grid`);
		}
	}
}

// Draws one tick's pickups. Uniform cells come from the tick's demand stream
// (shared with dropoffs); every hotspot decision from `hotspot:<tick>`, taken
// only in hotspot mode, so uniform runs draw exactly what they did before
// hotspots existed.
export function pickupsForTick(
	demand: Demand,
	grid: Grid,
	tick: Tick,
	streams: { root: Random; demand: Random },
): () => Cell {
	if (demand.type === "uniform") return () => randomCell(grid, streams.demand);
	const hotspotStream = streams.root.child(`hotspot:${tick}`);
	return () => {
		if (hotspotStream.float() >= demand.hotspotShare) {
			return randomCell(grid, streams.demand);
		}
		const hotspot = chooseHotspot(demand.hotspots, hotspotStream);
		return cellInHotspot(hotspot, grid, hotspotStream);
	};
}

function chooseHotspot(hotspots: readonly Hotspot[], random: Random): Hotspot {
	const totalWeight = hotspots.reduce((sum, h) => sum + h.weight, 0);
	let remaining = random.float() * totalWeight;
	for (const hotspot of hotspots) {
		remaining -= hotspot.weight;
		if (remaining < 0) return hotspot;
	}
	// Float rounding can leave a sliver past the last weight.
	return hotspots[hotspots.length - 1] as Hotspot;
}

// Uniform over the hotspot's cells clipped to the grid: rejection sampling
// from its bounding box, also clipped. Terminates: the center is a candidate.
function cellInHotspot(hotspot: Hotspot, grid: Grid, random: Random): Cell {
	const { center, radius } = hotspot;
	const minX = Math.max(0, center.x - radius);
	const maxX = Math.min(grid.width - 1, center.x + radius);
	const minY = Math.max(0, center.y - radius);
	const maxY = Math.min(grid.height - 1, center.y + radius);
	for (;;) {
		const candidate = {
			x: random.int(minX, maxX),
			y: random.int(minY, maxY),
		} as Cell;
		if (distance(candidate, center) <= radius) return candidate;
	}
}
