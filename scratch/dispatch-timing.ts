// #232 experiment, not merged: dispatch's messages_timed summed over a run,
// ms per tick over 600 ticks, by message type.
// Usage: bun scratch/dispatch-timing.ts <services.log>
const [file] = Bun.argv.slice(2);
if (file === undefined) throw new Error("usage: <services.log>");
const sums = new Map<string, { received: number; decodeMs: number; handleMs: number }>();
let decodeMs = 0;
let handleMs = 0;
for (const line of (await Bun.file(file).text()).split("\n")) {
	if (!line.startsWith("[dispatch] ") || !line.includes('"messages_timed"')) continue;
	const entry = JSON.parse(line.slice("[dispatch] ".length));
	decodeMs += entry.decodeMs;
	handleMs += entry.handleMs;
	for (const [type, t] of Object.entries(entry.byType) as [string, { received: number; decodeMs: number; handleMs: number }][]) {
		const sum = sums.get(type) ?? { received: 0, decodeMs: 0, handleMs: 0 };
		sum.received += t.received;
		sum.decodeMs += t.decodeMs;
		sum.handleMs += t.handleMs;
		sums.set(type, sum);
	}
}
const perTick = (ms: number) => (ms / 600).toFixed(1);
console.log(`${file}: decode + handle ${perTick(decodeMs + handleMs)} ms per tick (decode ${perTick(decodeMs)}, handle ${perTick(handleMs)})`);
for (const [type, s] of [...sums].sort((a, b) => b[1].decodeMs + b[1].handleMs - a[1].decodeMs - a[1].handleMs)) {
	console.log(`  ${type.padEnd(26)} received ${String(s.received).padStart(8)}  decode ${perTick(s.decodeMs).padStart(6)}  handle ${perTick(s.handleMs).padStart(6)}`);
}
