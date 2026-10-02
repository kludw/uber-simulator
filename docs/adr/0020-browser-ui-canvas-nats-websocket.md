# 0020. Watch-only browser UI: vanilla TypeScript, canvas, NATS over WebSocket

- Status: Accepted
- Date: 2026-10-02

## Context

v1 UI is watch-only and live-only: show 100 drivers, waiting riders, and active trips on a 500 × 500 grid, plus a few counters. NATS supports WebSocket clients (`wsconnect()`), so a browser can subscribe directly.

## Decision

We will build the UI in vanilla TypeScript with a 2D canvas, bundled and served by Bun. The browser subscribes directly to NATS events over WebSocket and builds its view from them, interpolating driver movement between ticks.

## Rationale

- 100 dots on a canvas needs no framework; less code and dependencies.
- Direct NATS subscription removes a gateway service; the UI is just another event consumer.
- Interpolation makes 1 s ticks look smooth without shortening the tick.

## Alternatives considered

- React / Svelte: useful once the UI has real interactive state; not needed for watch-only.
- Bun gateway bridging NATS to WebSocket: allows aggregation and throttling; revisit when event volume (e.g. 10k drivers) overwhelms the browser.
- DOM / SVG elements per driver: fine at 100, does not scale.

## Consequences

- NATS server needs the websocket listener enabled (compose change).
- A UI opened mid-run sees drivers only after their next event; acceptable for v1 (every driver moves each tick).
- Interactive features later likely need a framework and a new ADR.
