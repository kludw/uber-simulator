// Dispatch's samples by part, one sample = one count (idle gaps excluded).
// Usage: bun summary.ts <file.cpuprofile>...
type Node = {
	id: number;
	callFrame: { functionName: string; url: string; lineNumber: number };
	children?: number[];
};
const parts = [
	"decode: JSON.parse",
	"decode: Zod (parseMessage)",
	"decode: payload to string",
	"decode: other",
	"tick: busy set (offerPairs)",
	"tick: idle list (idleDrivers loop)",
	"tick: idle sort",
	"tick: index build (indexIdleDrivers)",
	"tick: nearest search (takeNearest)",
	"tick: storeTrip",
	"tick: other",
	"moves: position updates (decideDispatch)",
	"publish",
	"other handlers",
	"bus other",
] as const;
for (const file of Bun.argv.slice(2)) {
	const p = (await Bun.file(file).json()) as { nodes: Node[]; samples: number[] };
	const byId = new Map<number, Node>();
	const parent = new Map<number, number>();
	for (const n of p.nodes) byId.set(n.id, n);
	for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
	const memo = new Map<number, string | null>();
	const is = (n: Node, fn: string, at: string) =>
		n.callFrame.functionName === fn && n.callFrame.url.includes(at);
	const classify = (leaf: number): string | null => {
		const s: Node[] = [];
		for (let c: number | undefined = leaf; c !== undefined; c = parent.get(c)) {
			const n = byId.get(c);
			if (n) s.push(n);
		}
		s.reverse();
		const has = (fn: string, at: string) => s.some((n) => is(n, fn, at));
		const live = has("receive", "src/bus/nats.ts");
		const dispatchHandler = s.findIndex(
			(n) => n.callFrame.url.includes("src/dispatch/") || n.callFrame.url.includes("src/bus/nats.ts") && n.callFrame.functionName === "publish",
		);
		if (has("decode", "src/bus/nats.ts")) {
			if (has("parseMessage", "messages.ts")) return "decode: Zod (parseMessage)";
			if (has("json", "msg.js")) return "decode: payload to string";
			if (s.some((n) => n.callFrame.functionName === "parse" && n.callFrame.url === "")) return "decode: JSON.parse";
			return "decode: other";
		}
		if (has("onTick", "src/dispatch/brain.ts")) {
			if (has("takeNearest", "idle-drivers.ts")) return "tick: nearest search (takeNearest)";
			if (has("indexIdleDrivers", "idle-drivers.ts")) return "tick: index build (indexIdleDrivers)";
			if (has("idleDrivers", "src/dispatch/brain.ts")) {
				return s.some((n) => n.callFrame.functionName === "sort") ? "tick: idle sort" : "tick: idle list (idleDrivers loop)";
			}
			if (has("offerPairs", "src/dispatch/brain.ts")) return "tick: busy set (offerPairs)";
			if (has("storeTrip", "src/dispatch/brain.ts")) return "tick: storeTrip";
			return "tick: other";
		}
		if (has("publish", "src/bus/nats.ts")) return "publish";
		if (dispatchHandler !== -1) {
			const top = s[dispatchHandler];
			const leafNode = s[s.length - 1];
			if (top && is(top, "decideDispatch", "src/dispatch/brain.ts") && leafNode && is(leafNode, "decideDispatch", "src/dispatch/brain.ts")) {
				return "moves: position updates (decideDispatch)";
			}
			return "other handlers";
		}
		if (live && has("receive", "src/bus/nats.ts")) return "bus other";
		return null; // not dispatch (in process: other services, runner)
	};
	const counts = new Map<string, number>();
	let all = 0;
	for (const id of p.samples) {
		all++;
		let k = memo.get(id);
		if (k === undefined) {
			k = classify(id);
			memo.set(id, k);
		}
		if (k === null) continue;
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	const total = [...counts.values()].reduce((a, b) => a + b, 0);
	console.log(`${file.split("/")[0]}: samples ${all}, dispatch ${total} (${(total / 600).toFixed(1)} per tick)`);
	for (const k of parts) {
		const v = counts.get(k) ?? 0;
		console.log(`  ${k.padEnd(42)} ${String(v).padStart(7)} ${((100 * v) / total).toFixed(1).padStart(5)}%`);
	}
}
