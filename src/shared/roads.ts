// SPIKE (#335): a road network laid on the grid. Rivers are full-length rows
// or columns of blocked cells; bridges are the only cells of a river a driver
// may enter, each crossed straight from one landing (the cell before it) to
// the other. Rivers cut the grid into districts, open rectangles, so within a
// district road distance is Manhattan distance, and between districts it is
// the least, over exit landings, of Manhattan to the exit, 2 cells across its
// bridge, then landing-to-landing shortest paths (precomputed, Floyd-Warshall
// over the landings) and Manhattan from the entry landing. Exact, and never
// less than Manhattan distance, so ring searches stay exact.
import type { Grid } from "./grid.ts";
import { createRandom } from "./random.ts";

export type RoadNetwork = {
	name: string;
	width: number;
	// District column of each x (-1: a vertical river), district row of each y.
	columnOf: Int32Array;
	rowOf: Int32Array;
	districtColumns: number;
	districts: number;
	riverRows: number[];
	riverColumns: number[];
	// Bridge index of each cell (-1: none), row-major.
	bridgeOf: Int32Array;
	bridgeX: Int32Array;
	bridgeY: Int32Array;
	// Landings: 2 per bridge, landing 2b and 2b+1 are bridge b's ends.
	landingX: Int32Array;
	landingY: Int32Array;
	landingDistrict: Int32Array;
	landingsOf: Int32Array[];
	landings: number;
	// Landing-to-landing road distance, landings x landings.
	between: Int32Array;
	// Upper bound on any road distance.
	maxDistance: number;
	// One-entry cache of exit costs toward a fixed cell (distanceFrom).
	cacheX: number;
	cacheY: number;
	exitCost: Int32Array;
	// SPIKE: exit costs per fixed cell (a batch's pickups), owned by this
	// network so two networks never share rows; dropped past 4,096.
	exitCosts: Map<number, Int32Array>;
	// SPIKE: waypoints by driver index (production: the driver shard's state).
	viaTarget: Int32Array;
	viaExit: Int32Array;
	viaFrom: Int32Array;
};

type Preset = {
	horizontal: number[];
	vertical: number[];
	bridgesPerEdge: number;
};

function presetOf(name: string, grid: Grid): Preset {
	const random = createRandom(335).child(`roads:${name}`);
	const bridges = Number(process.env.SPIKE_BRIDGES ?? "0");
	const jitter = (at: number) => at + random.int(-20, 20);
	switch (name) {
		case "river":
			return {
				horizontal: [jitter(Math.floor(grid.height / 2))],
				vertical: [],
				bridgesPerEdge: bridges || 4,
			};
		case "canals":
			return {
				horizontal: [1, 2, 3].map((i) =>
					jitter(Math.floor((i * grid.height) / 4)),
				),
				vertical: [1, 2, 3].map((i) =>
					jitter(Math.floor((i * grid.width) / 4)),
				),
				bridgesPerEdge: bridges || 2,
			};
		default:
			throw new Error(`unknown road network ${name}`);
	}
}

export function roadNetworkNamed(name: string, grid: Grid): RoadNetwork {
	const preset = presetOf(name, grid);
	const random = createRandom(335).child(`bridges:${name}`);
	const { width, height } = grid;
	const bands = (size: number, rivers: number[]) => {
		const of = new Int32Array(size);
		let band = 0;
		for (let i = 0; i < size; i++) {
			if (rivers.includes(i)) {
				of[i] = -1;
				band++;
			} else {
				of[i] = band;
			}
		}
		return { of, count: band + 1 };
	};
	const columns = bands(width, preset.vertical);
	const rows = bands(height, preset.horizontal);
	const districtColumns = columns.count;
	const bridgeOf = new Int32Array(width * height).fill(-1);
	const bx: number[] = [];
	const by: number[] = [];
	// Open stretches [from, to] between rivers along one axis.
	const stretches = (size: number, rivers: number[]) => {
		const out: [number, number][] = [];
		let from = 0;
		for (const r of [...rivers].sort((a, b) => a - b)) {
			out.push([from, r - 1]);
			from = r + 1;
		}
		out.push([from, size - 1]);
		return out;
	};
	const place = (
		river: number,
		along: [number, number][],
		horizontal: boolean,
	) => {
		for (const [from, to] of along) {
			const length = to - from + 1;
			const k = preset.bridgesPerEdge;
			for (let i = 0; i < k; i++) {
				// Spread: one bridge per k-th of the stretch, a cell clear of its ends.
				const lo = from + Math.floor((i * length) / k) + 1;
				const hi = from + Math.floor(((i + 1) * length) / k) - 2;
				const at = random.int(lo, Math.max(lo, hi));
				const x = horizontal ? at : river;
				const y = horizontal ? river : at;
				bridgeOf[y * width + x] = bx.length;
				bx.push(x);
				by.push(y);
			}
		}
	};
	for (const r of preset.horizontal)
		place(r, stretches(width, preset.vertical), true);
	for (const c of preset.vertical)
		place(c, stretches(height, preset.horizontal), false);
	const landings = bx.length * 2;
	const landingX = new Int32Array(landings);
	const landingY = new Int32Array(landings);
	const landingDistrict = new Int32Array(landings);
	const districts = districtColumns * rows.count;
	const lists: number[][] = Array.from({ length: districts }, () => []);
	for (let b = 0; b < bx.length; b++) {
		const x = bx[b] as number;
		const y = by[b] as number;
		const horizontal = rows.of[y] === -1;
		const ends = horizontal
			? [
					[x, y - 1],
					[x, y + 1],
				]
			: [
					[x - 1, y],
					[x + 1, y],
				];
		for (let e = 0; e < 2; e++) {
			const [lx, ly] = ends[e] as [number, number];
			const l = 2 * b + e;
			landingX[l] = lx;
			landingY[l] = ly;
			const d =
				(rows.of[ly] as number) * districtColumns + (columns.of[lx] as number);
			if ((rows.of[ly] as number) < 0 || (columns.of[lx] as number) < 0) {
				throw new Error(`landing (${lx}, ${ly}) on a river`);
			}
			landingDistrict[l] = d;
			lists[d]?.push(l);
		}
	}
	// Floyd-Warshall over landings: same-district pairs Manhattan, a bridge 2.
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
			const pk = between[p * landings + k] as number;
			for (let q = 0; q < landings; q++) {
				const via = pk + (between[k * landings + q] as number);
				if (via < (between[p * landings + q] as number))
					between[p * landings + q] = via;
			}
		}
	}
	let longest = 0;
	for (const d of between) longest = Math.max(longest, d);
	return {
		name,
		width,
		columnOf: columns.of,
		rowOf: rows.of,
		districtColumns,
		districts,
		riverRows: preset.horizontal,
		riverColumns: preset.vertical,
		bridgeOf,
		bridgeX: Int32Array.from(bx),
		bridgeY: Int32Array.from(by),
		landingX,
		landingY,
		landingDistrict,
		landingsOf: lists.map((l) => Int32Array.from(l)),
		landings,
		between,
		maxDistance: 2 * (width + height - 2) + longest + 2,
		cacheX: -1,
		cacheY: -1,
		exitCost: new Int32Array(landings),
		exitCosts: new Map(),
		viaTarget: new Int32Array(0),
		viaExit: new Int32Array(0),
		viaFrom: new Int32Array(0),
	};
}

// -1: not a district cell (river or bridge).
function districtOf(net: RoadNetwork, x: number, y: number): number {
	const column = net.columnOf[x] as number;
	const row = net.rowOf[y] as number;
	if (column < 0 || row < 0) return -1;
	return row * net.districtColumns + column;
}

// A cell riders and drivers can stand on (bridges are only crossed).
export function isRoad(net: RoadNetwork, x: number, y: number): boolean {
	return districtOf(net, x, y) >= 0;
}

export function canDrive(net: RoadNetwork, x: number, y: number): boolean {
	return isRoad(net, x, y) || (net.bridgeOf[y * net.width + x] as number) >= 0;
}

// Road distance from landing l to district cell (tx, ty) in district dt.
function fromLanding(
	net: RoadNetwork,
	l: number,
	tx: number,
	ty: number,
	dt: number,
): number {
	const lx = net.landingX[l] as number;
	const ly = net.landingY[l] as number;
	if (net.landingDistrict[l] === dt)
		return Math.abs(lx - tx) + Math.abs(ly - ty);
	let best = Number.POSITIVE_INFINITY;
	const row = l * net.landings;
	const listq = net.landingsOf[dt] as Int32Array;
	for (let iq = 0; iq < listq.length; iq++) {
		const q = listq[iq] as number;
		const c =
			(net.between[row + q] as number) +
			Math.abs((net.landingX[q] as number) - tx) +
			Math.abs((net.landingY[q] as number) - ty);
		if (c < best) best = c;
	}
	return best;
}

// Leaving through exit landing p: across its bridge to its partner p ^ 1.
function exitCostOf(
	net: RoadNetwork,
	p: number,
	tx: number,
	ty: number,
	dt: number,
) {
	return 2 + fromLanding(net, p ^ 1, tx, ty, dt);
}

export function roadDistance(
	net: RoadNetwork,
	ax: number,
	ay: number,
	tx: number,
	ty: number,
): number {
	if (ax === tx && ay === ty) return 0;
	const bridgeA = net.bridgeOf[ay * net.width + ax] as number;
	if (bridgeA >= 0) return 1 + viaLandings(net, bridgeA, tx, ty);
	const bridgeT = net.bridgeOf[ty * net.width + tx] as number;
	if (bridgeT >= 0) return 1 + viaLandings(net, bridgeT, ax, ay);
	const da = districtOf(net, ax, ay);
	const dt = districtOf(net, tx, ty);
	if (da < 0 || dt < 0)
		throw new Error(`off road: (${ax}, ${ay}) or (${tx}, ${ty})`);
	if (da === dt) return Math.abs(ax - tx) + Math.abs(ay - ty);
	let best = Number.POSITIVE_INFINITY;
	const listp = net.landingsOf[da] as Int32Array;
	for (let ip = 0; ip < listp.length; ip++) {
		const p = listp[ip] as number;
		const c =
			Math.abs((net.landingX[p] as number) - ax) +
			Math.abs((net.landingY[p] as number) - ay) +
			exitCostOf(net, p, tx, ty, dt);
		if (c < best) best = c;
	}
	return best;
}

function viaLandings(net: RoadNetwork, bridge: number, tx: number, ty: number) {
	return Math.min(
		roadDistance(
			net,
			net.landingX[2 * bridge] as number,
			net.landingY[2 * bridge] as number,
			tx,
			ty,
		),
		roadDistance(
			net,
			net.landingX[2 * bridge + 1] as number,
			net.landingY[2 * bridge + 1] as number,
			tx,
			ty,
		),
	);
}

// roadDistance with a fixed (fx, fy) asked against many cells in a row (a
// pickup against candidate drivers): exit costs toward it computed once.
export function roadDistanceFrom(
	net: RoadNetwork,
	fx: number,
	fy: number,
	x: number,
	y: number,
): number {
	spikeCounts.calls++;
	const df = districtOf(net, fx, fy);
	const d = districtOf(net, x, y);
	if (df < 0 || d < 0) return roadDistance(net, fx, fy, x, y);
	if (df === d) return Math.abs(fx - x) + Math.abs(fy - y);
	spikeCounts.cross++;
	fillExitCosts(net, fx, fy, df);
	let best = Number.POSITIVE_INFINITY;
	const listp = net.landingsOf[d] as Int32Array;
	for (let ip = 0; ip < listp.length; ip++) {
		const p = listp[ip] as number;
		const c =
			Math.abs((net.landingX[p] as number) - x) +
			Math.abs((net.landingY[p] as number) - y) +
			(net.exitCost[p] as number);
		if (c < best) best = c;
	}
	return best;
}

// The next cell on a shortest road path toward a district cell, as
// y * width + x (no allocation): within a district today's step rule; else
// toward the best exit landing (ties to the lowest), onto its bridge when
// there, across a bridge to the nearer end.
export function roadStep(
	net: RoadNetwork,
	ax: number,
	ay: number,
	tx: number,
	ty: number,
	driverIndex = -1,
): number {
	const w = net.width;
	// Districts first: their lookups are two small arrays; bridges are rare.
	const da = districtOf(net, ax, ay);
	const dt = districtOf(net, tx, ty);
	if (da >= 0 && da === dt) return gridStep(w, ax, ay, tx, ty);
	const bridge = net.bridgeOf[ay * w + ax] as number;
	if (bridge >= 0) {
		const l0 = 2 * bridge;
		const d0 = roadDistance(
			net,
			net.landingX[l0] as number,
			net.landingY[l0] as number,
			tx,
			ty,
		);
		const d1 = roadDistance(
			net,
			net.landingX[l0 + 1] as number,
			net.landingY[l0 + 1] as number,
			tx,
			ty,
		);
		const l = d1 < d0 ? l0 + 1 : l0;
		return (net.landingY[l] as number) * w + (net.landingX[l] as number);
	}
	if (da < 0 || dt < 0)
		throw new Error(`off road step (${ax}, ${ay}) -> (${tx}, ${ty})`);
	// SPIKE: a driver keeps its exit (waypoint) while its target is the same
	// and it stands where its last step put it; still on a shortest path (each
	// step lowers the cost via it by 1).
	const key = ty * w + tx;
	let exit = -1;
	if (
		driverIndex >= 0 &&
		driverIndex < net.viaTarget.length &&
		net.viaTarget[driverIndex] === key &&
		net.viaFrom[driverIndex] === ay * w + ax
	) {
		const kept = net.viaExit[driverIndex] as number;
		if (kept >= 0 && net.landingDistrict[kept] === da) exit = kept;
	}
	if (exit < 0) {
		let best = Number.POSITIVE_INFINITY;
		const listp = net.landingsOf[da] as Int32Array;
		for (let ip = 0; ip < listp.length; ip++) {
			const p = listp[ip] as number;
			const c =
				Math.abs((net.landingX[p] as number) - ax) +
				Math.abs((net.landingY[p] as number) - ay) +
				exitCostOf(net, p, tx, ty, dt);
			if (c < best) {
				best = c;
				exit = p;
			}
		}
		if (driverIndex >= 0) {
			if (driverIndex >= net.viaTarget.length) growVia(net, driverIndex + 1);
			net.viaTarget[driverIndex] = key;
			net.viaExit[driverIndex] = exit;
		}
	}
	const ex = net.landingX[exit] as number;
	const ey = net.landingY[exit] as number;
	const next =
		ex === ax && ey === ay
			? (net.bridgeY[exit >> 1] as number) * w +
				(net.bridgeX[exit >> 1] as number)
			: gridStep(w, ax, ay, ex, ey);
	if (driverIndex >= 0) net.viaFrom[driverIndex] = next;
	return next;
}

// Today's rule (larger remaining axis first, ties to x), as y * width + x.
function gridStep(
	w: number,
	x: number,
	y: number,
	tx: number,
	ty: number,
): number {
	const dx = tx - x;
	const dy = ty - y;
	if (Math.abs(dy) > Math.abs(dx)) return (y + Math.sign(dy)) * w + x;
	return y * w + x + Math.sign(dx);
}

function growVia(net: RoadNetwork, size: number): void {
	const next = Math.max(size, 2 * net.viaTarget.length);
	const target = new Int32Array(next).fill(-1);
	const exit = new Int32Array(next).fill(-1);
	const from = new Int32Array(next).fill(-1);
	target.set(net.viaTarget);
	exit.set(net.viaExit);
	from.set(net.viaFrom);
	net.viaTarget = target;
	net.viaExit = exit;
	net.viaFrom = from;
}

// Spike knob: SPIKE_ROADS=river|canals (off when unset), built on the spec grid.
export const spikeRoads: RoadNetwork | null =
	process.env.SPIKE_ROADS && process.env.SPIKE_ROADS !== "off"
		? roadNetworkNamed(process.env.SPIKE_ROADS, { width: 500, height: 500 })
		: null;

export const spikeCounts = {
	calls: 0,
	cross: 0,
	recompute: 0,
	searches: 0,
	idle: 0,
	maxCalls: 0,
	wide: 0,
	wideDistance: 0,
};

// SPIKE: exit costs per fixed cell, kept for up to 4,096 cells (a batch's
// pickups), then dropped; the last one also in net.exitCost.
function fillExitCosts(net: RoadNetwork, fx: number, fy: number, df: number) {
	if (net.cacheX === fx && net.cacheY === fy) return;
	const key = fy * net.width + fx;
	let costs = net.exitCosts.get(key);
	if (costs === undefined) {
		spikeCounts.recompute++;
		if (net.exitCosts.size >= 4096) net.exitCosts.clear();
		costs = new Int32Array(net.landings);
		for (let p = 0; p < net.landings; p++) {
			costs[p] = exitCostOf(net, p, fx, fy, df);
		}
		net.exitCosts.set(key, costs);
	}
	net.exitCost = costs;
	net.cacheX = fx;
	net.cacheY = fy;
}

function boxGap(
	x: number,
	y: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
) {
	const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
	const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
	return dx + dy;
}

// SPIKE: a lower bound on the road distance from (fx, fy) to any drivable
// cell of the box [x0, x1] x [y0, y1] (a search bucket): per district the
// box touches, Manhattan if it is the fixed cell's own, else the least box
// gap to a landing plus that landing's exit cost; bridges in the box exactly.
export function roadBoundToBox(
	net: RoadNetwork,
	fx: number,
	fy: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): number {
	const df = districtOf(net, fx, fy);
	const manhattanGap = boxGap(fx, fy, x0, y0, x1, y1);
	if (df < 0) return manhattanGap;
	// Most boxes lie in one district (no river inside: band indexes at both
	// ends equal).
	const cs = net.columnOf[x0] as number;
	const rs = net.rowOf[y0] as number;
	if (cs >= 0 && rs >= 0 && cs === net.columnOf[x1] && rs === net.rowOf[y1]) {
		const d = rs * net.districtColumns + cs;
		if (d === df) return manhattanGap;
		fillExitCosts(net, fx, fy, df);
		let least = Number.POSITIVE_INFINITY;
		const list = net.landingsOf[d] as Int32Array;
		for (let i = 0; i < list.length; i++) {
			const p = list[i] as number;
			const bound =
				boxGap(
					net.landingX[p] as number,
					net.landingY[p] as number,
					x0,
					y0,
					x1,
					y1,
				) + (net.exitCost[p] as number);
			if (bound < least) least = bound;
		}
		return Math.max(least, manhattanGap);
	}
	fillExitCosts(net, fx, fy, df);
	let best = Number.POSITIVE_INFINITY;
	let c0 = -1;
	let c1 = -1;
	let crossesRiver = false;
	for (let x = x0; x <= x1; x++) {
		const c = net.columnOf[x] as number;
		if (c < 0) crossesRiver = true;
		else {
			if (c0 < 0) c0 = c;
			c1 = c;
		}
	}
	let r0 = -1;
	let r1 = -1;
	for (let y = y0; y <= y1; y++) {
		const r = net.rowOf[y] as number;
		if (r < 0) crossesRiver = true;
		else {
			if (r0 < 0) r0 = r;
			r1 = r;
		}
	}
	for (let r = r0; r >= 0 && r <= r1; r++) {
		for (let c = c0; c >= 0 && c <= c1; c++) {
			const d = r * net.districtColumns + c;
			if (d === df) {
				if (manhattanGap < best) best = manhattanGap;
				continue;
			}
			const list = net.landingsOf[d] as Int32Array;
			for (let i = 0; i < list.length; i++) {
				const p = list[i] as number;
				const bound =
					boxGap(
						net.landingX[p] as number,
						net.landingY[p] as number,
						x0,
						y0,
						x1,
						y1,
					) + (net.exitCost[p] as number);
				if (bound < best) best = bound;
			}
		}
	}
	if (crossesRiver) {
		for (let b = 0; b < net.bridgeX.length; b++) {
			const bx = net.bridgeX[b] as number;
			const by = net.bridgeY[b] as number;
			if (bx < x0 || bx > x1 || by < y0 || by > y1) continue;
			const d = roadDistance(net, fx, fy, bx, by);
			if (d < best) best = d;
		}
	}
	return Math.max(best, manhattanGap);
}
