// #240 experiment, not merged: batched dispatch's CPU profile samples by
// part (one sample = one count). Works on a live dispatch profile (loadtest,
// DISPATCH_PROFILE) and on an in-process bench profile (every service in one
// process: parts outside dispatch are "other services").
// Usage: bun scratch/batched-profile.ts <file.cpuprofile> [--leaves]
type Node = {
	id: number;
	callFrame: { functionName: string; url: string; lineNumber: number };
	children?: number[];
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

const where = (f: Frame) =>
	`${f.functionName || "(anon)"} ${f.url.split("/").slice(-2).join("/") || "(native)"}:${f.lineNumber + 1}`;

function classify(stack: Frame[]): string {
	const has = (fn: string, at: string) =>
		stack.some((f) => f.functionName === fn && f.url.includes(at));
	const live = has("receive", "src/bus/nats.ts");
	if (live && has("decode", "src/bus/nats.ts")) return "decode";
	if (has("onTick", "src/dispatch/brain.ts")) {
		if (has("lazyMinCostMatching", "lazy-matching.ts")) {
			if (has("nearestIdle", "idle-drivers.ts")) return "tick: lazy nearest queries";
			return "tick: lazy solver";
		}
		if (has("batchedPairs", "src/dispatch/brain.ts")) {
			if (has("ofRow", "src/dispatch/brain.ts") || has("ofColumn", "src/dispatch/brain.ts"))
				return "tick: row filling (ofRow)";
			if (has("solve", "src/dispatch/matching.ts")) return "tick: Hungarian loop (solve)";
			return "tick: batchedPairs setup";
		}
		if (has("idleDriversById", "idle-drivers.ts")) return "tick: idle list (idleDriversById)";
		if (has("idleCell", "idle-drivers.ts")) return "tick: experiment stats";
		return "tick: other";
	}
	if (has("forEachDriverAt", "shared/messages.ts")) return "moves";
	if (live && has("publish", "src/bus/nats.ts")) return "publish";
	if (has("decideDispatch", "src/dispatch/brain.ts")) return "other dispatch handlers";
	if (live) return "outside dispatch handlers (bus, idle)";
	return "other services";
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
for (const id of profile.samples) {
	const part = classify(stack(id));
	parts.set(part, (parts.get(part) ?? 0) + 1);
	const leaf = stack(id).at(-1);
	if (!leaf) continue;
	const byLeaf = leaves.get(part) ?? new Map<string, number>();
	byLeaf.set(where(leaf), (byLeaf.get(where(leaf)) ?? 0) + 1);
	leaves.set(part, byLeaf);
}
const all = profile.samples.length;
const outside = ["outside dispatch handlers (bus, idle)", "other services"];
const dispatchSamples =
	all - outside.reduce((sum, part) => sum + (parts.get(part) ?? 0), 0);
console.log(
	`${file}: samples ${all}, dispatch ${dispatchSamples} (${((100 * dispatchSamples) / all).toFixed(1)}%)`,
);
for (const [part, count] of [...parts].sort((a, b) => b[1] - a[1])) {
	const ofDispatch = outside.includes(part)
		? ""
		: `${((100 * count) / dispatchSamples).toFixed(1).padStart(5)}% of dispatch`;
	console.log(
		`  ${part.padEnd(40)} ${String(count).padStart(8)} ${((100 * count) / all).toFixed(1).padStart(5)}% of all  ${ofDispatch}`,
	);
	if (!showLeaves) continue;
	for (const [leaf, n] of [...(leaves.get(part) ?? [])]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)) {
		console.log(`      ${String(n).padStart(8)} ${leaf}`);
	}
}
