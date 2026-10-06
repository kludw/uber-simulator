// Self samples by source line for functions in files matching a fragment.
// Usage: bun lines.ts <file.cpuprofile> <urlFragment>
const [file, fragment] = Bun.argv.slice(2);
const p = await Bun.file(file!).json();
const byLine = new Map<string, number>();
const hits = new Map<number, number>();
for (const id of p.samples as number[]) hits.set(id, (hits.get(id) ?? 0) + 1);
let withTicks = 0;
for (const n of p.nodes) {
	if (!n.callFrame.url.includes(fragment)) continue;
	const fn = n.callFrame.functionName || "(anon)";
	if (n.positionTicks?.length) {
		withTicks++;
		for (const t of n.positionTicks) {
			const k = `${fn}:${t.line}`;
			byLine.set(k, (byLine.get(k) ?? 0) + t.ticks);
		}
	} else {
		const k = `${fn}@node:${n.callFrame.lineNumber + 1}`;
		byLine.set(k, (byLine.get(k) ?? 0) + (hits.get(n.id) ?? 0));
	}
}
console.log("nodes with positionTicks", withTicks);
for (const [k, v] of [...byLine].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(String(v).padStart(8), k);
