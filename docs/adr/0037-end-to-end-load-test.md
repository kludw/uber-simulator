# 0037. End-to-end load test: the distributed stack at real time

- Status: Accepted
- Date: 2026-10-04

## Context

`bun run bench` (ADR 0033, 0036) measures the brains and the in-memory bus in one process: 50k drivers fit the 1 s tick budget there. The distributed stack (ADR 0017, 0028: every service its own process over NATS, the clock pacing ticks at 1 s / `SPEED`, the persister writing to ClickHouse via JetStream, ADR 0029; the UI over WebSocket, ADR 0020) has only been exercised with small fleets. At N drivers the services publish about N `driver.moved` per second; one rough local measurement put the persister at ~13k events/s (`docs/performance.md`). Nothing tells us today at what fleet size the live stack falls behind real time.

## Decision

We will add a load-test command, `bun run loadtest -- --drivers N --ticks T [--matching ...] [--shards K]`, and a manual CI workflow running it, that:

- starts the real stack the way `bun run dev` does (persister first, then dispatch, riders, K driver shards, clock at `SPEED=1`) against NATS and ClickHouse, with demand at the spec ratio;
- runs an observer on its own NATS connection subscribed to `sim.events.>` that records, per tick, the delay from the tick's `clock.ticked` to the last `driver.moved` of that tick ("settle latency"), and counts messages;
- samples the persister's JetStream consumer every few seconds (pending messages, ack floor) and reads NATS server monitoring (`/varz`, slow consumers) at the end;
- stops after T ticks, waits for the persister to drain (bounded), and prints a report: settle latency mean / p95 / max, message rate, persister pending over time and drain time, slow-consumer count, peak RSS per service.

A fleet size counts as supported live when, at `SPEED=1`, settle latency p95 is under 1,000 ms, the persister's pending count stays bounded (doesn't grow tick over tick) and NATS reports no slow consumers. The UI is measured separately (browser rendering is out of this command's scope).

## Rationale

- Settle latency is the direct measure of "keeps real time": if a tick's work isn't done before the next tick, latency grows without bound.
- Persister pending is the direct measure of "storage keeps up"; a growing backlog means stored data lags live indefinitely.
- Slow-consumer counts catch the case where NATS drops messages to a lagging subscriber (core NATS is at-most-once, ADR 0028).
- Reusing `bun run dev`'s start order and real processes measures what users actually run.

## Alternatives considered

- Extend `bun run bench` with the NATS bus in one process: misses process boundaries and the persister.
- Measure only throughput (messages/s): doesn't say whether ticks keep their 1 s budget.
- Include the browser in the CI load test: headless rendering cost differs from a real browser; measured separately if needed.

## Consequences

- CI gains a heavier manual workflow (NATS + ClickHouse + 4+ processes); the 4-CPU runner bounds what it can show.
- Results become the README's answer to "how many drivers does the live system support".
