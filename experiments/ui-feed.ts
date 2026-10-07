// Experiment (#272, not merged): what the UI's feed costs. Subscribes like
// the page (sim.events.> over the NATS websocket), counts messages and
// bytes per second by type, and times the page's per-message pipeline
// (JSON.parse, parseMessage, applyEvent) in Bun.
// Usage: bun experiments/ui-feed.ts <seconds> [ws url]
import { wsconnect } from "@nats-io/nats-core";
import { isSimEvent, parseMessage } from "../src/shared/messages.ts";
import { simEventSubjects } from "../src/shared/subjects.ts";
import { applyEvent, emptyView } from "../src/ui/view.ts";

const seconds = Number(process.argv[2] ?? 30);
const url = process.argv[3] ?? "ws://localhost:9222";
// count-only: no parse or view, the feed's rate alone (by subject).
const countOnly = process.argv[4] === "count-only";
const connection = await wsconnect({ servers: url });
const subscription = connection.subscribe(simEventSubjects);

type Count = { messages: number; bytes: number };
const perType = new Map<string, Count>();
let messages = 0;
let bytes = 0;
let pipelineMs = 0;
let parseMs = 0;
let view = emptyView();
const started = performance.now();
const endAt = started + seconds * 1000;
let firstTick: number | null = null;
let lastTick: number | null = null;

setTimeout(() => subscription.unsubscribe(), seconds * 1000);
for await (const received of subscription) {
	const now = performance.now();
	if (now > endAt) break;
	const size = received.data.length;
	if (countOnly) {
		const type = received.subject.split(".").slice(2, 4).join(".");
		const count = perType.get(type) ?? { messages: 0, bytes: 0 };
		count.messages++;
		count.bytes += size;
		perType.set(type, count);
		messages++;
		bytes += size;
		continue;
	}
	const t0 = performance.now();
	const parsed = parseMessage(received.json());
	const t1 = performance.now();
	if (!parsed.ok || !isSimEvent(parsed.value)) continue;
	view = applyEvent(view, parsed.value);
	const t2 = performance.now();
	parseMs += t1 - t0;
	pipelineMs += t2 - t0;
	messages++;
	bytes += size;
	const type = parsed.value.type;
	const count = perType.get(type) ?? { messages: 0, bytes: 0 };
	count.messages++;
	count.bytes += size;
	perType.set(type, count);
	if (type === "clock.ticked") {
		firstTick ??= view.tick;
		lastTick = view.tick;
	}
}
const elapsed = (performance.now() - started) / 1000;
const ticks = firstTick === null || lastTick === null ? 0 : lastTick - firstTick;
const rows = [...perType]
	.toSorted((a, b) => b[1].bytes - a[1].bytes)
	.map(([type, c]) => ({
		type,
		msgsPerS: +(c.messages / elapsed).toFixed(1),
		kBPerS: +(c.bytes / elapsed / 1024).toFixed(1),
	}));
console.log(
	JSON.stringify(
		{
			elapsedS: +elapsed.toFixed(1),
			ticks,
			drivers: view.drivers.size,
			msgsPerS: +(messages / elapsed).toFixed(1),
			kBPerS: +(bytes / elapsed / 1024).toFixed(1),
			pipelineMsPerS: +(pipelineMs / elapsed).toFixed(1),
			parseMsPerS: +(parseMs / elapsed).toFixed(1),
			perType: rows,
		},
		null,
		1,
	),
);
await connection.close();
process.exit(0);
