// SPIKE (#335): each preset's rivers, bridges, districts and how much longer
// road distance is than Manhattan over random road-cell pairs.
import { createRandom } from "../shared/random.ts";
import { isRoad, roadDistance, roadNetworkNamed } from "../shared/roads.ts";

for (const name of ["river", "canals"]) {
	const net = roadNetworkNamed(name, { width: 500, height: 500 });
	const random = createRandom(1);
	const cell = (): [number, number] => {
		for (;;) {
			const x = random.int(0, 499);
			const y = random.int(0, 499);
			if (isRoad(net, x, y)) return [x, y];
		}
	};
	let road = 0;
	let manhattan = 0;
	let worst = 0;
	let detoured = 0;
	const pairs = 200_000;
	for (let i = 0; i < pairs; i++) {
		const [ax, ay] = cell();
		const [bx, by] = cell();
		const r = roadDistance(net, ax, ay, bx, by);
		const m = Math.abs(ax - bx) + Math.abs(ay - by);
		road += r;
		manhattan += m;
		if (r > m) detoured++;
		worst = Math.max(worst, r - m);
	}
	let roadCells = 0;
	for (let y = 0; y < 500; y++)
		for (let x = 0; x < 500; x++) if (isRoad(net, x, y)) roadCells++;
	console.log(
		JSON.stringify({
			name,
			riverRows: net.riverRows,
			riverColumns: net.riverColumns,
			bridges: net.bridgeX.length,
			districts: net.districts,
			roadCellsPct: Number(((100 * roadCells) / 250000).toFixed(1)),
			meanRoad: Number((road / pairs).toFixed(1)),
			meanManhattan: Number((manhattan / pairs).toFixed(1)),
			detouredPct: Number(((100 * detoured) / pairs).toFixed(1)),
			worstExtra: worst,
			maxDistanceBound: net.maxDistance,
		}),
	);
}
