// Road networks (ADR 0059): rivers are whole rows or columns of cells no one
// enters except at their bridges, each crossed straight across from one
// landing (the road cell before it) to the other. Rivers cut the grid into
// districts, open rectangles, so within a district road distance is Manhattan
// distance, and between districts it goes through landings, whose pairwise
// road distances are precomputed once per network. Never less than Manhattan
// distance, so searches bounded by Manhattan distance stay exact.
import {
	type Cell,
	type Coordinate,
	cellAt,
	type Grid,
	stepToward,
} from "./grid.ts";
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
			return {
				riverRows: quarters(grid.height),
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

// -1 off the grid or on a river (its bridges included).
function districtOf(network: RoadNetwork, x: number, y: number): number {
	const column = network.columnOf[x] ?? -1;
	const row = network.rowOf[y] ?? -1;
	if (column < 0 || row < 0) return -1;
	return row * network.districtColumns + column;
}

// A cell of a district: where pickups, dropoffs and drivers' targets may be.
export function isRoadCell(
	network: RoadNetwork,
	x: number,
	y: number,
): boolean {
	return districtOf(network, x, y) >= 0;
}

// A road cell or a bridge: where a driver may stand (on a bridge only
// mid-crossing).
export function isDrivable(
	network: RoadNetwork,
	x: number,
	y: number,
): boolean {
	return isRoadCell(network, x, y) || bridgeAt(network, x, y) >= 0;
}

// -1 when (x, y) is not a bridge.
function bridgeAt(network: RoadNetwork, x: number, y: number): number {
	if (x < 0 || x >= network.width) return -1;
	return network.bridgeOf[y * network.width + x] ?? -1;
}

// Shortest path length over drivable cells. Both cells must be drivable
// (callers check cells from other services at their edge); anything else is
// a caller's bug and throws.
export function roadDistance(network: RoadNetwork, a: Cell, b: Cell): number {
	return distanceBetween(network, a.x, a.y, b.x, b.y);
}

// One drivable cell's exit costs: for every landing, the road distance from
// it to the cell leaving through its bridge. Made once for a cell asked
// against many (a pickup against candidate drivers) and owned by the caller,
// never kept by this module, so two networks or two searches never share
// them.
export type ExitCosts = {
	readonly x: number;
	readonly y: number;
	// -1 when the cell is a bridge.
	readonly district: number;
	readonly costs: Int32Array;
};

export function exitCostsToward(network: RoadNetwork, cell: Cell): ExitCosts {
	const district = districtOf(network, cell.x, cell.y);
	if (district < 0 && bridgeAt(network, cell.x, cell.y) < 0) {
		throw new Error(`exit costs toward off-road (${cell.x}, ${cell.y})`);
	}
	const costs = new Int32Array(network.landings);
	for (let p = 0; p < network.landings; p++) {
		costs[p] = exitCost(network, p, cell.x, cell.y, district);
	}
	return { x: cell.x, y: cell.y, district, costs };
}

// roadDistance from drivable (x, y) to the cell of `toward`, in a few array
// reads.
export function roadDistanceTo(
	network: RoadNetwork,
	toward: ExitCosts,
	x: number,
	y: number,
): number {
	const district = districtOf(network, x, y);
	if (district < 0) return distanceBetween(network, x, y, toward.x, toward.y);
	if (district === toward.district) {
		return Math.abs(x - toward.x) + Math.abs(y - toward.y);
	}
	return leastViaExits(network, toward, district, x, y, x, y);
}

// A lower bound on the road distance from any drivable cell of the box
// [x0, x1] x [y0, y1] (a search bucket, clipped to the grid) to the cell of
// `toward`: per district the box touches, Manhattan when it is the cell's
// own, else the least gap from the box to one of its landings plus that
// landing's exit cost; bridges inside the box exactly. Never less than the
// Manhattan gap.
export function roadBoundToBox(
	network: RoadNetwork,
	toward: ExitCosts,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): number {
	const left = Math.max(0, x0);
	const top = Math.max(0, y0);
	const right = Math.min(network.columnOf.length - 1, x1);
	const bottom = Math.min(network.rowOf.length - 1, y1);
	const { x, y } = toward;
	const manhattanGap =
		(x < left ? left - x : x > right ? x - right : 0) +
		(y < top ? top - y : y > bottom ? y - bottom : 0);
	const columns = bandRange(network.columnOf, left, right);
	const rows = bandRange(network.rowOf, top, bottom);
	let least = Number.POSITIVE_INFINITY;
	for (let row = rows.first; row >= 0 && row <= rows.last; row++) {
		for (
			let column = columns.first;
			column >= 0 && column <= columns.last;
			column++
		) {
			const district = row * network.districtColumns + column;
			const bound =
				district === toward.district
					? manhattanGap
					: leastViaExits(network, toward, district, left, top, right, bottom);
			if (bound < least) least = bound;
		}
	}
	if (columns.river || rows.river) {
		for (const bridge of network.bridges) {
			if (bridge.x < left || bridge.x > right) continue;
			if (bridge.y < top || bridge.y > bottom) continue;
			const distance = distanceBetween(
				network,
				bridge.x,
				bridge.y,
				toward.x,
				toward.y,
			);
			if (distance < least) least = distance;
		}
	}
	return Math.max(least, manhattanGap);
}

// The district bands [first, last] a span [from, to] of one axis touches
// (-1 when only a river), and whether it touches a river. Rivers are single
// cells, never adjacent, and bands increase along the axis.
function bandRange(bands: Int32Array, from: number, to: number) {
	const atFrom = bands[from] as number;
	const atTo = bands[to] as number;
	const first =
		atFrom >= 0 || from === to ? atFrom : (bands[from + 1] as number);
	const last = atTo >= 0 || from === to ? atTo : (bands[to - 1] as number);
	return { first, last, river: atFrom < 0 || atTo < 0 || first !== last };
}

// Least, over district d's landings p, of the gap from the box
// [x0, x1] x [y0, y1] to p + p's exit cost. A one-cell box gives that cell's
// road distance.
function leastViaExits(
	network: RoadNetwork,
	toward: ExitCosts,
	d: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): number {
	let least = Number.POSITIVE_INFINITY;
	const exits = network.landingsOf[d] as Int32Array;
	for (let i = 0; i < exits.length; i++) {
		const p = exits[i] as number;
		const x = network.landingX[p] as number;
		const y = network.landingY[p] as number;
		const cost =
			(x < x0 ? x0 - x : x > x1 ? x - x1 : 0) +
			(y < y0 ? y0 - y : y > y1 ? y - y1 : 0) +
			(toward.costs[p] as number);
		if (cost < least) least = cost;
	}
	return least;
}

function distanceBetween(
	network: RoadNetwork,
	ax: number,
	ay: number,
	bx: number,
	by: number,
): number {
	if (ax === bx && ay === by) return 0;
	const bridgeA = bridgeAt(network, ax, ay);
	if (bridgeA >= 0) return 1 + viaBridgeEnds(network, bridgeA, bx, by);
	const bridgeB = bridgeAt(network, bx, by);
	if (bridgeB >= 0) return 1 + viaBridgeEnds(network, bridgeB, ax, ay);
	const da = districtOf(network, ax, ay);
	const db = districtOf(network, bx, by);
	if (da < 0 || db < 0) {
		throw new Error(`road distance off road: (${ax}, ${ay}) to (${bx}, ${by})`);
	}
	if (da === db) return Math.abs(ax - bx) + Math.abs(ay - by);
	let least = Number.POSITIVE_INFINITY;
	const exits = network.landingsOf[da] as Int32Array;
	for (let i = 0; i < exits.length; i++) {
		const p = exits[i] as number;
		const cost =
			Math.abs((network.landingX[p] as number) - ax) +
			Math.abs((network.landingY[p] as number) - ay) +
			exitCost(network, p, bx, by, db);
		if (cost < least) least = cost;
	}
	return least;
}

// From a bridge cell: one move to either landing, then on.
function viaBridgeEnds(
	network: RoadNetwork,
	bridge: number,
	x: number,
	y: number,
): number {
	return Math.min(
		distanceBetween(
			network,
			network.landingX[2 * bridge] as number,
			network.landingY[2 * bridge] as number,
			x,
			y,
		),
		distanceBetween(
			network,
			network.landingX[2 * bridge + 1] as number,
			network.landingY[2 * bridge + 1] as number,
			x,
			y,
		),
	);
}

// Road distance from landing p to (x, y), leaving through p's bridge. (x, y)
// is a road cell of district d, or a bridge when d is -1.
function exitCost(
	network: RoadNetwork,
	p: number,
	x: number,
	y: number,
	d: number,
): number {
	const entry = p ^ 1;
	if (d < 0) {
		const bridge = bridgeAt(network, x, y);
		if (p >> 1 === bridge) return 1;
		const row = entry * network.landings;
		const toEnd = Math.min(
			network.between[row + 2 * bridge] as number,
			network.between[row + 2 * bridge + 1] as number,
		);
		return 2 + toEnd + 1;
	}
	const ex = network.landingX[entry] as number;
	const ey = network.landingY[entry] as number;
	if (network.landingDistrict[entry] === d) {
		return 2 + Math.abs(ex - x) + Math.abs(ey - y);
	}
	let least = Number.POSITIVE_INFINITY;
	const row = entry * network.landings;
	const entries = network.landingsOf[d] as Int32Array;
	for (let i = 0; i < entries.length; i++) {
		const q = entries[i] as number;
		const cost =
			(network.between[row + q] as number) +
			Math.abs((network.landingX[q] as number) - x) +
			Math.abs((network.landingY[q] as number) - y);
		if (cost < least) least = cost;
	}
	return 2 + least;
}

// Each driver's waypoint by driver index: the exit landing it heads for
// while its target is in another district. Owned by the driver shard's
// state; this module only reads and writes it in roadStep.
export type Waypoints = Int32Array;

const noWaypoint = -1;

export function waypointsFor(drivers: number): Waypoints {
	return new Int32Array(drivers).fill(noWaypoint);
}

// The waypoint was chosen for the driver's old target: call when its target
// changes.
export function clearWaypoint(waypoints: Waypoints, index: number): void {
	waypoints[index] = noWaypoint;
}

// The next cell on a shortest road path from drivable `from` to road cell
// `target`, one move. Within a district today's rule (stepToward); toward
// another district via the driver's waypoint, chosen when it has none or it
// lies in another district than the driver's (it just crossed): the exit of
// least Manhattan distance to it + exit cost, ties to the lowest landing.
// Each step lowers the road distance through a kept waypoint by exactly 1,
// so a driver keeping it arrives in exactly the road distance.
export function roadStep(
	network: RoadNetwork,
	waypoints: Waypoints,
	index: number,
	from: Cell,
	target: Cell,
): Cell {
	const targetDistrict = districtOf(network, target.x, target.y);
	if (targetDistrict < 0) {
		throw new Error(`road step toward off-road (${target.x}, ${target.y})`);
	}
	const district = districtOf(network, from.x, from.y);
	if (district === targetDistrict) return stepToward(from, target);
	if (district < 0) return offBridge(network, from, target);
	let exit = waypoints[index] ?? noWaypoint;
	if (exit === noWaypoint || network.landingDistrict[exit] !== district) {
		exit = exitToward(network, from, target, targetDistrict);
		waypoints[index] = exit;
	}
	const landing = landingCell(network, exit);
	if (landing.x === from.x && landing.y === from.y) {
		return network.bridges[exit >> 1] as Cell;
	}
	return stepToward(from, landing);
}

function exitToward(
	network: RoadNetwork,
	from: Cell,
	target: Cell,
	targetDistrict: number,
): number {
	let exit = noWaypoint;
	let least = Number.POSITIVE_INFINITY;
	const exits = network.landingsOf[
		districtOf(network, from.x, from.y)
	] as Int32Array;
	for (let i = 0; i < exits.length; i++) {
		const p = exits[i] as number;
		const cost =
			Math.abs((network.landingX[p] as number) - from.x) +
			Math.abs((network.landingY[p] as number) - from.y) +
			exitCost(network, p, target.x, target.y, targetDistrict);
		if (cost < least) {
			least = cost;
			exit = p;
		}
	}
	return exit;
}

// From a bridge to whichever end is nearer the target (ties to the first).
function offBridge(network: RoadNetwork, from: Cell, target: Cell): Cell {
	const bridge = bridgeAt(network, from.x, from.y);
	if (bridge < 0)
		throw new Error(`road step from off-road (${from.x}, ${from.y})`);
	const first = landingCell(network, 2 * bridge);
	const second = landingCell(network, 2 * bridge + 1);
	return roadDistance(network, second, target) <
		roadDistance(network, first, target)
		? second
		: first;
}

function landingCell(network: RoadNetwork, landing: number): Cell {
	return cellAt(
		network.landingX[landing] as Coordinate,
		network.landingY[landing] as Coordinate,
	);
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
