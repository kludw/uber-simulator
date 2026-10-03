// Browser entry (index.html): NATS over websocket -> view -> canvas + side
// panel (ADR 0020). Watch-only: subscribes, never publishes.
import { type Msg, wsconnect } from "@nats-io/nats-core";
import * as z from "zod";
import { specGrid } from "../shared/grid.ts";
import { isSimEvent, parseMessage, type SimEvent } from "../shared/messages.ts";
import { type PanelRow, panelRows } from "./panel.ts";
import { startRenderer } from "./render.ts";
import { applyEvent, emptyView } from "./view.ts";

const PageConfig = z.object({ natsWsUrl: z.url() });

type ConnectionStatus = "connecting" | "live" | "disconnected";

function element<T extends HTMLElement>(id: string, type: { new (): T }): T {
	const found = document.getElementById(id);
	if (!(found instanceof type)) throw new Error(`#${id} missing from page`);
	return found;
}

const statusElement = element("status", HTMLElement);
const panelElement = element("panel", HTMLTableElement);
const renderer = startRenderer(element("city", HTMLCanvasElement), specGrid);

function showStatus(status: ConnectionStatus): void {
	statusElement.dataset.status = status;
	statusElement.textContent = status;
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
	const config = PageConfig.parse(await (await fetch("/config.json")).json());
	// Keeps retrying, before the first connection too, so the page recovers
	// from NATS starting late or restarting.
	const connection = await wsconnect({
		servers: config.natsWsUrl,
		waitOnFirstConnect: true,
		maxReconnectAttempts: -1,
	});
	const subscription = connection.subscribe("sim.events.>");
	showStatus("live");
	(async () => {
		for await (const status of connection.status()) {
			if (status.type === "disconnect" || status.type === "close") {
				showStatus("disconnected");
			} else if (status.type === "reconnect") {
				showStatus("live");
			}
		}
	})();

	let view = emptyView();
	let panelPending = false;
	for await (const received of subscription) {
		const event = decode(received);
		if (event === null) continue;
		view = applyEvent(view, event);
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
