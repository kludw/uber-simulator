# 0037. End-to-end load test: the distributed stack at real time

- Status: Accepted (persister trend criterion superseded by 0038)
- Date: 2026-10-04

## Context

`bun run bench` (ADR 0033, 0036) measures the brains and the in-memory bus in one process: 50k drivers fit the 1 s tick budget there. The distributed stack (ADR 0017, 0028: every service its own process over NATS, the clock pacing ticks at 1 s / `SPEED`, the persister writing to ClickHouse via JetStream, ADR 0029; the UI over WebSocket, ADR 0020) has only been exercised with small fleets. At N drivers the services publish about N `driver.moved` per second; one rough local measurement put the persister at ~13k events/s (`docs/performance.md`). Nothing tells us today at what fleet size the live stack falls behind real time.

## Decision

We will add a load-test command, `bun run loadtest -- --drivers N --ticks T [--matching ...] [--shards K]`, and a manual CI workflow running it, that:

- starts the real stack the way `bun run dev` does (persister first, then dispatch, riders, K driver shards, clock at `SPEED=1`) against NATS and ClickHouse, with demand at the spec ratio, after purging the `SIM_EVENTS` stream so the persister starts from an empty backlog; it stops the clock after tick T (the clock has no tick limit of its own);
- runs an observer on its own NATS connection subscribed to `sim.events.>`, decoding only subject and `tick`. Every event carries its tick, so settle latency of tick t = latest receipt time of any event with `tick = t` minus receipt time of `clock.ticked` t, finalized at the end of the run. It covers every service that publishes events (drivers, dispatch, riders), and an event of tick t arriving after `clock.ticked` t+1 makes that tick an overrun (settle >= 1,000 ms);
- checks the observer's own validity: `clock.ticked` inter-arrival must stay near 1,000 ms (the clock uses an absolute schedule), reporting max deviation and the observer's pending bytes from NATS `/connz`;
- samples the persister's JetStream consumer (`num_pending`, `num_ack_pending`) every few seconds, and after tick T waits for the persister to drain, up to a bound, reporting drain time or "did not drain";
- reports: settle latency mean / p95 / max and overrun count, message rate, persister pending over time with the first-half vs second-half trend, drain time, NATS `/varz` `slow_consumers` (clients the server disconnected) and `/connz` pending bytes, host CPU count and load, and peak RSS per service.

A fleet size counts as supported live when, at `SPEED=1` with T >= 600, the slower of two runs has settle p95 <= 610 ms (ADR 0036's band) and no more than 1% overruns, the persister's pending count in the second half of the run is not higher on average than in the first half and it drains within the bound, and no slow consumers are reported. The UI is measured separately (browser rendering is out of this command's scope).

## Rationale

- Settle latency over every event of a tick is the direct measure of "keeps real time" for all publishing services, observable without knowing how many events a tick produces.
- Persister pending, judged by its trend and drain time from an empty start, is the direct measure of "storage keeps up"; a single sample would mostly show batch oscillation.
- Slow-consumer counts and pending bytes catch subscribers that can't keep up; core NATS is at-most-once (ADR 0028), so a disconnected slow consumer loses messages.
- The same two-run, 610 ms band as ADR 0036 keeps live and in-process verdicts comparable.
- Reusing `bun run dev`'s start order and real processes measures what users actually run.

## Alternatives considered

- Extend `bun run bench` with the NATS bus in one process: misses process boundaries and the persister.
- Measure only throughput (messages/s): doesn't say whether ticks keep their 1 s budget.
- Include the browser in the CI load test: headless rendering cost differs from a real browser; measured separately if needed.

## Consequences

- CI gains a heavier manual workflow (NATS, ClickHouse, and K+4 service processes plus the observer on a 4-CPU runner). Every service Zod-parses all `sim.>` traffic (ADR 0028), so decoding likely saturates the host before the brains do: CI results are a lower bound on a contended host, and the report includes CPU count and load.
- If the live limit lands well below the in-process ceiling, the next step is ADR 0028's per-service subject subscriptions.
- Results become the README's answer to "how many drivers does the live system support".
