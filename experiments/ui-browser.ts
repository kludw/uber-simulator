// Experiment (#272, not merged): the page's cost in headless Chromium.
// Needs the instrumented page (window.uiStats, this branch) and
// playwright-core with chromium-headless-shell installed outside the repo.
// Usage: PW=<dir with node_modules/playwright-core> bun experiments/ui-browser.ts <url> <warmupS> <sampleS>
const { chromium } = await import(`${process.env.PW}/node_modules/playwright-core/index.mjs`);

const url = process.argv[2] ?? "http://localhost:3100/";
const warmupS = Number(process.argv[3] ?? 10);
const sampleS = Number(process.argv[4] ?? 20);

const browser = await chromium.launch({
	args: ["--enable-precise-memory-info"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
const metrics = async () => {
	const { metrics } = await cdp.send("Performance.getMetrics");
	return Object.fromEntries(
		metrics.map((m: { name: string; value: number }) => [m.name, m.value]),
	);
};
page.on("pageerror", (e: Error) => console.error("pageerror", e.message));
await page.goto(url);
await page.waitForTimeout(warmupS * 1000);

const before = await metrics();
const result = await page.evaluate(async (ms: number) => {
	type Stats = { drawMs: number[]; applyMs: number; messages: number; bytes: number };
	const st = (globalThis as unknown as { uiStats: Stats }).uiStats;
	const a0 = st.applyMs;
	const m0 = st.messages;
	const b0 = st.bytes;
	st.drawMs.length = 0;
	const frames: number[] = [];
	let last = performance.now();
	const end = last + ms;
	await new Promise<void>((done) => {
		const frame = (t: number) => {
			frames.push(t - last);
			last = t;
			if (t < end) requestAnimationFrame(frame);
			else done();
		};
		requestAnimationFrame(frame);
	});
	const q = (values: number[], p: number) => {
		if (values.length === 0) return null;
		const s = values.toSorted((a, b) => a - b);
		return +(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(1);
	};
	const f = frames.slice(1);
	const memory = (performance as unknown as { memory: { usedJSHeapSize: number } }).memory;
	return {
		fps: +(f.length / (ms / 1000)).toFixed(1),
		frameP50: q(f, 0.5),
		frameP95: q(f, 0.95),
		frameMax: q(f, 1),
		drawP50: q(st.drawMs, 0.5),
		drawP95: q(st.drawMs, 0.95),
		applyMsPerS: +((st.applyMs - a0) / (ms / 1000)).toFixed(1),
		msgsPerS: +((st.messages - m0) / (ms / 1000)).toFixed(1),
		kBPerS: +((st.bytes - b0) / 1024 / (ms / 1000)).toFixed(1),
		heapMB: +(memory.usedJSHeapSize / 1048576).toFixed(1),
		panel: (document.getElementById("panel")?.textContent ?? "").slice(0, 60),
	};
}, sampleS * 1000);
const after = await metrics();
const busy = (after.TaskDuration - before.TaskDuration) / sampleS;
console.log(
	JSON.stringify({
		...result,
		mainThreadBusyShare: +busy.toFixed(2),
		scriptShare: +((after.ScriptDuration - before.ScriptDuration) / sampleS).toFixed(2),
		jsHeapUsedMB: +(after.JSHeapUsedSize / 1048576).toFixed(1),
	}),
);
await browser.close();
