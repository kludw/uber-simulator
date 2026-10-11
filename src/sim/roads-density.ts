// SPIKE (#335): where drivers are at the end of a bench-sized run, by district
// and by distance from a river; idle (wander) vs busy is not known here.
import { parseBenchArgs } from "../bench/args.ts";
import { forEachDriverAt, type Message } from "../shared/messages.ts";
import { spikeRoads } from "../shared/roads.ts";
import { runInProcess } from "./run.ts";

const args = parseBenchArgs(Bun.argv.slice(2));
if (!args.ok || spikeRoads === null) throw new Error("args or SPIKE_ROADS");
const net = spikeRoads;
const xs = new Int32Array(1_000_000).fill(-1);
const ys = new Int32Array(1_000_000).fill(-1);
runInProcess(args.value.config, {
	onMessage: (message: Message) => {
		if (
			message.type !== "drivers.moved" &&
			message.type !== "drivers.went_online"
		)
			return;
		forEachDriverAt(message, (index, x, y) => {
			xs[index] = x;
			ys[index] = y;
		});
	},
});
const perDistrict = new Int32Array(net.districts);
const byGap = new Int32Array(12);
const cellsByGap = new Int32Array(12);
const rivers = [
	...net.riverRows.map((r) => ({ r, h: true })),
	...net.riverColumns.map((r) => ({ r, h: false })),
];
const gapOf = (x: number, y: number) => {
	let gap = 1e9;
	for (const { r, h } of rivers) gap = Math.min(gap, Math.abs((h ? y : x) - r));
	return Math.min(11, Math.floor(gap / 5));
};
for (let i = 0; i < xs.length; i++) {
	const x = xs[i] as number;
	const y = ys[i] as number;
	if (x < 0) continue;
	const c = net.columnOf[x] as number;
	const r = net.rowOf[y] as number;
	if (c >= 0 && r >= 0)
		Atomics.add(perDistrict, r * net.districtColumns + c, 1);
	Atomics.add(byGap, gapOf(x, y), 1);
}
for (let y = 0; y < 500; y++)
	for (let x = 0; x < 500; x++) Atomics.add(cellsByGap, gapOf(x, y), 1);
console.log("per district", perDistrict.join(" "));
console.log(
	"drivers per cell by distance to river (5-cell bands):",
	Array.from(byGap, (n, i) => (n / (cellsByGap[i] || 1)).toFixed(2)).join(" "),
);
