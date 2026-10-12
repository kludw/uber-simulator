// Road networks (ADR 0059): rivers are whole rows or columns of cells no one
// enters except at their bridges, each crossed straight across from one
// landing (the road cell before it) to the other. Rivers cut the grid into
// districts, open rectangles, so within a district road distance is Manhattan
// distance, and between districts it goes through landings, whose pairwise
// road distances are precomputed once per network. Never less than Manhattan
// distance, so searches bounded by Manhattan distance stay exact.
import { type Cell, type Coordinate, cellAt, type Grid } from "./grid.ts";
import { createRandom } from "./random.ts";

export type RoadNetworkName = "river" | "canals";

// Callers ask this module's functions; only the geometry (rivers, bridges) is
// for reading directly (the UI draws it).
export type RoadNetwork = {
	readonly name: RoadNetworkName;
	readonly riverRows: readonly number[];
	readonly riverColumns: readonly number[];
	readonly bridges: readonly Cell[];
	readonly width: number;
	// District column of each x and district row of each y, -1 on a river.
	readonly columnOf: Int32Array;
	readonly rowOf: Int32Array;
	readonly districtColumns: number;
	// Bridge index of each cell, row-major, -1 when not a bridge.
	readonly bridgeOf: Int32Array;
	// Landings 2b and 2b + 1 are bridge b's ends.
	readonly landingX: Int32Array;
	readonly landingY: Int32Array;
	readonly landingDistrict: Int32Array;
	// Each district's landings, ascending.
	readonly landingsOf: readonly Int32Array[];
	readonly landings: number;
	// Road distance from landing p to landing q at p * landings + q.
	readonly between: Int32Array;
};

type Preset = {
	riverRows: number[];
	riverColumns: number[];
	bridgesPerStretch: number;
};

// From a fixed seed per preset, never a run's: every process and every run
// seed gets the same city. The seed and draw order reproduce the spike's
// networks (ADR 0059's numbers).
function presetOf(name: RoadNetworkName, grid: Grid): Preset {
	const random = createRandom(335).child(`roads:${name}`);
	const jitter = (at: number) => at + random.int(-20, 20);
	switch (name) {
		case "river":
			return {
				riverRows: [jitter(Math.floor(grid.height / 2))],
				riverColumns: [],
				bridgesPerStretch: 4,
			};
		case "canals": {
			const quarters = (size: number) =>
				[1, 2, 3].map((i) => jitter(Math.floor((i * size) / 4)));
			const riverRows = quarters(grid.height);
			return {
				riverRows,
				riverColumns: quarters(grid.width),
				bridgesPerStretch: 2,
			};
		}
		default: {
			const unknown: never = name;
			throw new Error(`unknown road network ${unknown}`);
		}
	}
}

// Band of each coordinate along one axis: rivers are -1, the open stretches
// between them numbered from 0.
function bandsOf(size: number, rivers: readonly number[]): Int32Array {
	const bands = new Int32Array(size);
	let band = 0;
	for (let i = 0; i < size; i++) {
		if (rivers.includes(i)) {
			bands[i] = -1;
			band++;
		} else {
			bands[i] = band;
		}
	}
	return bands;
}

// Open stretches [from, to] between rivers along one axis.
function stretchesOf(size: number, rivers: readonly number[]) {
	const stretches: [number, number][] = [];
	let from = 0;
	for (const river of rivers.toSorted((a, b) => a - b)) {
		stretches.push([from, river - 1]);
		from = river + 1;
	}
	stretches.push([from, size - 1]);
	return stretches;
}

export function roadNetworkNamed(
	name: RoadNetworkName,
	grid: Grid,
): RoadNetwork {
	const preset = presetOf(name, grid);
	const random = createRandom(335).child(`bridges:${name}`);
	const { width, height } = grid;
	const columnOf = bandsOf(width, preset.riverColumns);
	const rowOf = bandsOf(height, preset.riverRows);
	const districtColumns = preset.riverColumns.length + 1;
	const districts = districtColumns * (preset.riverRows.length + 1);
	const bridges: Cell[] = [];
	// Each stretch of a river between two crossing rivers gets its bridges,
	// one drawn within each equal share of the stretch, a cell clear of the
	// share's ends: bridges at least 2 apart and clear of other rivers.
	const placeBridges = (
		river: number,
		stretches: [number, number][],
		alongX: boolean,
	) => {
		const k = preset.bridgesPerStretch;
		for (const [from, to] of stretches) {
			const length = to - from + 1;
			for (let i = 0; i < k; i++) {
				const lo = from + Math.floor((i * length) / k) + 1;
				const hi = from + Math.floor(((i + 1) * length) / k) - 2;
				const at = random.int(lo, Math.max(lo, hi));
				bridges.push(
					alongX
						? cellAt(at as Coordinate, river as Coordinate)
						: cellAt(river as Coordinate, at as Coordinate),
				);
			}
		}
	};
	for (const row of preset.riverRows) {
		placeBridges(row, stretchesOf(width, preset.riverColumns), true);
	}
	for (const column of preset.riverColumns) {
		placeBridges(column, stretchesOf(height, preset.riverRows), false);
	}
	const bridgeOf = new Int32Array(width * height).fill(-1);
	const landings = bridges.length * 2;
	const landingX = new Int32Array(landings);
	const landingY = new Int32Array(landings);
	const landingDistrict = new Int32Array(landings);
	const lists: number[][] = Array.from({ length: districts }, () => []);
	bridges.forEach((bridge, b) => {
		bridgeOf[bridge.y * width + bridge.x] = b;
		const acrossRow = rowOf[bridge.y] === -1;
		for (const side of [0, 1]) {
			const sign = side === 0 ? -1 : 1;
			const x = acrossRow ? bridge.x : bridge.x + sign;
			const y = acrossRow ? bridge.y + sign : bridge.y;
			const column = columnOf[x] as number;
			const row = rowOf[y] as number;
			if (column < 0 || row < 0) {
				throw new Error(`landing (${x}, ${y}) of ${name} on a river`);
			}
			const landing = 2 * b + side;
			const district = row * districtColumns + column;
			landingX[landing] = x;
			landingY[landing] = y;
			landingDistrict[landing] = district;
			lists[district]?.push(landing);
		}
	});
	return {
		name,
		riverRows: preset.riverRows,
		riverColumns: preset.riverColumns,
		bridges,
		width,
		columnOf,
		rowOf,
		districtColumns,
		bridgeOf,
		landingX,
		landingY,
		landingDistrict,
		landingsOf: lists.map((list) => Int32Array.from(list)),
		landings,
		between: landingTable(landingX, landingY, landingDistrict),
	};
}

// Floyd-Warshall over landings: two landings of one district are Manhattan
// apart, a bridge's two ends 2.
function landingTable(
	landingX: Int32Array,
	landingY: Int32Array,
	landingDistrict: Int32Array,
): Int32Array {
	const landings = landingX.length;
	const between = new Int32Array(landings * landings).fill(1 << 29);
	for (let p = 0; p < landings; p++) {
		for (let q = 0; q < landings; q++) {
			if (p === q) between[p * landings + q] = 0;
			else if (landingDistrict[p] === landingDistrict[q]) {
				between[p * landings + q] =
					Math.abs((landingX[p] as number) - (landingX[q] as number)) +
					Math.abs((landingY[p] as number) - (landingY[q] as number));
			} else if (p >> 1 === q >> 1) between[p * landings + q] = 2;
		}
	}
	for (let k = 0; k < landings; k++) {
		for (let p = 0; p < landings; p++) {
			const viaK = between[p * landings + k] as number;
			for (let q = 0; q < landings; q++) {
				const via = viaK + (between[k * landings + q] as number);
				if (via < (between[p * landings + q] as number)) {
					between[p * landings + q] = via;
				}
			}
		}
	}
	return between;
}
