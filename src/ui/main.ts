// Browser entry (index.html): NATS over websocket -> view -> canvas + side
// panel (ADR 0020). Watch-only: subscribes, never publishes. Live, or a
// replay with ?replay=<runId> (ADR 0034).
import { type Msg, wsconnect } from "@nats-io/nats-core";
import * as z from "zod";
import { specGrid } from "../shared/grid.ts";
import { isSimEvent, parseMessage, type SimEvent } from "../shared/messages.ts";
import { type PanelRow, panelRows } from "./panel.ts";
import { startRenderer } from "./render.ts";
import { subscriptionFor } from "./subscription.ts";
import { applyEvent, emptyView } from "./view.ts";

const PageConfig = z.object({ natsWsUrl: z.url() });

type ConnectionStatus = "connecting" | "connected" | "disconnected";

function element<T extends HTMLElement>(id: string, type: { new (): T }): T {
	const found = document.getElementById(id);
	if (!(found instanceof type)) throw new Error(`#${id} missing from page`);
	return found;
}

// Experiment #272: feed and view-update cost.
const uiStats = { drawMs: [] as number[], applyMs: 0, messages: 0, bytes: 0 };
(globalThis as unknown as { uiStats: typeof uiStats }).uiStats = uiStats;

const statusElement = element("status", HTMLElement);
const panelElement = element("panel", HTMLTableElement);
const renderer = startRenderer(element("city", HTMLCanvasElement), specGrid);

// Connected shows what is watched ("live" or "replay <runId>").
function showStatus(status: ConnectionStatus, text: string = status): void {
	statusElement.dataset.status = status;
	statusElement.textContent = text;
}

function showPanel(rows: PanelRow[]): void {
	panelElement.replaceChildren(
		...rows.map((row) => {
			const tr = document.createElement("tr");
			const label = tr.insertCell();
			if (row.swatch !== null) {
				const swatch = document.createElement("span");
				swatch.className = `swatch ${row.swatch.shape}`;
				swatch.style.color = row.swatch.color;
				label.append(swatch);
			}
			label.append(row.label);
			tr.insertCell().textContent = row.value;
			return tr;
		}),
	);
}

function decode(received: Msg): SimEvent | null {
	let payload: unknown;
	try {
		payload = received.json();
	} catch (cause) {
		// Msg.json() is JSON.parse: SyntaxError means a malformed payload.
		if (!(cause instanceof SyntaxError)) throw cause;
		console.warn({ subject: received.subject, error: "invalid_json", cause });
		return null;
	}
	const parsed = parseMessage(payload);
	if (!parsed.ok) {
		console.warn({ subject: received.subject, error: parsed.error });
		return null;
	}
	if (!isSimEvent(parsed.value)) {
		console.warn({ subject: received.subject, error: "not_an_event" });
		return null;
	}
	return parsed.value;
}

async function watch(): Promise<void> {
	showStatus("connecting");
	showPanel(panelRows(emptyView()));
	const watched = subscriptionFor(location.search);
	if (!watched.ok) {
		console.warn({ search: location.search, error: watched.error });
		showStatus("disconnected", "invalid replay run id");
		return;
	}
	const { subject, label } = watched.value;
	const config = PageConfig.parse(await (await fetch("/config.json")).json());
	// Keeps retrying, before the first connection too, so the page recovers
	// from NATS starting late or restarting.
	const connection = await wsconnect({
		servers: config.natsWsUrl,
		waitOnFirstConnect: true,
		maxReconnectAttempts: -1,
	});
	const subscription = connection.subscribe(subject);
	showStatus("connected", label);
	(async () => {
		for await (const status of connection.status()) {
			if (status.type === "disconnect" || status.type === "close") {
				showStatus("disconnected");
			} else if (status.type === "reconnect") {
				showStatus("connected", label);
			}
		}
	})();

	let view = emptyView();
	let panelPending = false;
	for await (const received of subscription) {
		const started = performance.now();
		const event = decode(received);
		if (event === null) continue;
		view = applyEvent(view, event);
		uiStats.applyMs += performance.now() - started;
		uiStats.messages++;
		uiStats.bytes += received.data.length;
		renderer.show(view);
		// Many events per tick; the panel only needs the latest view per frame.
		if (panelPending) continue;
		panelPending = true;
		requestAnimationFrame(() => {
			panelPending = false;
			showPanel(panelRows(view));
		});
	}
}

watch().catch((error: unknown) => {
	console.error(error);
	showStatus("disconnected");
});
