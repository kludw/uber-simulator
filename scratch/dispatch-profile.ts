// #232 experiment, not merged: dispatch's CPU profile samples by part (one
// sample = one count; idle gaps between samples are not counted), plus the
// top leaf frames and hot lines of each part.
// Usage: bun dispatch-profile.ts <file.cpuprofile> [--leaves]
type Node = {
	id: number;
	callFrame: { functionName: string; url: string; lineNumber: number };
	children?: number[];
	positionTicks?: { line: number; ticks: number }[];
};
type Frame = Node["callFrame"];

const [file, ...flags] = Bun.argv.slice(2);
if (file === undefined) throw new Error("usage: <file.cpuprofile>");
const showLeaves = flags.includes("--leaves");
const profile = (await Bun.file(file).json()) as {
	nodes: Node[];
	samples: number[];
};
const byId = new Map<number, Node>();
const parent = new Map<number, number>();
for (const n of profile.nodes) byId.set(n.id, n);
for (const n of profile.nodes) {
	for (const c of n.children ?? []) parent.set(c, n.id);
}

const file_ = (f: Frame) => f.url.split("/").slice(-2).join("/");
const is = (f: Frame, fn: string, at: string) =>
	f.functionName === fn && f.url.includes(at);
const where = (f: Frame) =>
	`${f.functionName || "(anon)"} ${file_(f) || "(native)"}:${f.lineNumber + 1}`;

function classify(stack: Frame[]): string {
	const has = (fn: string, at: string) => stack.some((f) => is(f, fn, at));
	const leaf = stack[stack.length - 1];
	if (!has("receive", "src/bus/nats.ts")) return "outside receive";
	if (has("decode", "src/bus/nats.ts")) {
		if (has("parseMessage", "shared/messages.ts")) {
			const ours = stack.find(
				(f) =>
					f.url.includes("shared/messages.ts") &&
					f.functionName !== "parseMessage",
			);
			if (ours) return `decode: Zod, refine/transform at messages.ts:${ours.lineNumber + 1}`;
			return "decode: Zod, internals";
		}
		if (stack.some((f) => f.functionName === "parse" && f.url === "")) {
			return "decode: JSON.parse";
		}
		return "decode: payload to string, other";
	}
	if (has("onTick", "src/dispatch/brain.ts")) {
		if (
			has("nearestIdle", "idle-drivers.ts") ||
			has("searchRings", "idle-drivers.ts")
		) {
			return "tick: nearest search";
		}
		if (has("markBusy", "idle-drivers.ts")) return "tick: markBusy";
		if (has("queuedTrips", "src/dispatch/brain.ts")) return "tick: queued trips scan";
		if (has("storeTrip", "src/dispatch/brain.ts")) return "tick: storeTrip";
		if (has("withdrawOffer", "src/dispatch/trip.ts")) return "tick: withdrawOffer";
		return "tick: other (onTick self, expiry scan)";
	}
	if (has("forEachDriverCell", "shared/messages.ts")) {
		if (has("removeFromBucket", "idle-drivers.ts")) return "moves: removeFromBucket";
		if (has("addToBucket", "idle-drivers.ts")) return "moves: addToBucket";
		if (has("bucketOf", "idle-drivers.ts")) return "moves: bucketOf";
		if (has("placeDriver", "idle-drivers.ts")) {
			if (leaf && leaf.url === "" ) return `moves: placeDriver -> native ${leaf.functionName}`;
			return "moves: placeDriver self";
		}
		if (has("cellAt", "shared/grid.ts")) return "moves: cellAt";
		if (leaf && leaf.url === "") return `moves: loop -> native ${leaf.functionName}`;
		return "moves: forEachDriverCell self (loop, visit closure)";
	}
	if (has("publish", "src/bus/nats.ts")) return "publish";
	if (stack.some((f) => f.url.includes("src/dispatch/"))) return "other handlers";
	return "bus other";
}

const stackOf = new Map<number, Frame[]>();
function stack(id: number): Frame[] {
	let s = stackOf.get(id);
	if (s) return s;
	s = [];
	for (let c: number | undefined = id; c !== undefined; c = parent.get(c)) {
		const n = byId.get(c);
		if (n) s.push(n.callFrame);
	}
	s.reverse();
	stackOf.set(id, s);
	return s;
}

const parts = new Map<string, number>();
const leaves = new Map<string, Map<string, number>>();
const partOf = new Map<number, string>();
for (const id of profile.samples) {
	let part = partOf.get(id);
	if (part === undefined) {
		part = classify(stack(id));
		partOf.set(id, part);
	}
	parts.set(part, (parts.get(part) ?? 0) + 1);
	const leaf = stack(id).at(-1);
	if (leaf) {
		const byLeaf = leaves.get(part) ?? new Map<string, number>();
		byLeaf.set(where(leaf), (byLeaf.get(where(leaf)) ?? 0) + 1);
		leaves.set(part, byLeaf);
	}
}
const all = profile.samples.length;
const inReceive = all - (parts.get("outside receive") ?? 0);
console.log(
	`${file}: samples ${all}, under receive ${inReceive} (${((100 * inReceive) / all).toFixed(1)}%), ${(inReceive / 600).toFixed(1)} per tick over 600 ticks`,
);
for (const [part, count] of [...parts].sort((a, b) => a[0].localeCompare(b[0]))) {
	const share = part === "outside receive" ? count / all : count / inReceive;
	console.log(
		`  ${part.padEnd(60)} ${String(count).padStart(8)} ${(100 * share).toFixed(1).padStart(5)}%`,
	);
	if (!showLeaves) continue;
	for (const [leaf, n] of [...(leaves.get(part) ?? [])]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 6)) {
		console.log(`      ${String(n).padStart(8)} ${leaf}`);
	}
}

// Grouped as in docs/performance.md, ms per tick = share x the run's timed
// decode + handle ms per tick (--ms <n>, from scratch/dispatch-timing.ts).
const msFlag = flags.indexOf("--ms");
if (msFlag !== -1) {
	const timedMs = Number(flags[msFlag + 1]);
	const groupOf = (part: string) => {
		if (part.includes("JSON.parse")) return "decode: JSON.parse";
		if (part.includes("Zod, internals")) return "decode: Zod per element";
		if (part.includes("refine")) return "decode: ID regex refine";
		if (part.includes("payload")) return "decode: payload to string";
		if (part.includes("placeDriver")) return "apply: placeDriver self";
		if (part.startsWith("moves:") && part.includes("Bucket")) return "apply: bucket swaps";
		if (part.startsWith("moves:")) return "apply: loop + cellAt";
		if (part.includes("nearest")) return "step: nearest search";
		if (part.startsWith("tick:")) return "step: rest";
		if (part === "publish") return "publish";
		if (part === "outside receive") return undefined;
		return "other handlers, bus";
	};
	const groups = new Map<string, number>();
	for (const [part, count] of parts) {
		const group = groupOf(part);
		if (group !== undefined) groups.set(group, (groups.get(group) ?? 0) + count);
	}
	console.log(`  groups (ms per sample ${(timedMs / (inReceive / 600)).toFixed(3)}):`);
	for (const [group, count] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
		console.log(
			`    ${group.padEnd(28)} ${((100 * count) / inReceive).toFixed(1).padStart(5)}% ${((timedMs * count) / inReceive).toFixed(1).padStart(7)} ms`,
		);
	}
}

// Hot lines (positionTicks are self ticks per source line) in dispatch's own
// files and the decode path.
const lines = new Map<string, number>();
for (const n of profile.nodes) {
	const f = n.callFrame;
	if (!/src\/(dispatch|shared|bus)\//.test(f.url)) continue;
	for (const t of n.positionTicks ?? []) {
		const k = `${file_(f)}:${t.line} (${f.functionName || "anon"})`;
		lines.set(k, (lines.get(k) ?? 0) + t.ticks);
	}
}
console.log("  hot lines (self ticks):");
for (const [k, v] of [...lines].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
	console.log(`    ${String(v).padStart(8)} ${k}`);
}
