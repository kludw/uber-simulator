---
name: simulation
description: Project rules for the simulation engine - deterministic time, seeded randomness, tick loop, pure core vs I/O adapters, reproducible tests. Use whenever writing or changing simulation logic, anything touching time/clocks/timers, randomness, IDs, the tick loop, or simulation tests.
---

# Simulation

Goal: same seed + same config + same inputs = identical event log, every run. That makes bugs replayable and tests exact.

## Time

1. Simulated time is separate from wall time. Core never calls `Date.now()`, `new Date()`, `performance.now()`, `setTimeout`/`setInterval`.
2. Time advances in discrete ticks. One tick = fixed simulated duration (configurable). Core only knows tick number / sim time.
3. Runners decide wall-clock pacing, core doesn't:
   - Headless runner: ticks as fast as possible (tests, batch runs, analytics).
   - Live runner: paces ticks to wall time × speed multiplier (UI watching). Pause/resume/speed = runner concern.
4. Same core logic under both runners. No `if (live)` in core.

## Randomness

1. Core never calls `Math.random()` or `crypto.randomUUID()`.
2. One seeded PRNG behind a small `Random` interface, injected. Seed in run config, logged at start of every run.
3. IDs from a deterministic generator (counter or seeded), not UUIDs, inside the sim.
4. Need independent random streams (e.g. demand vs driver behavior)? Derive child PRNGs from the run seed, don't share one stream across unrelated concerns.

## Structure

1. Pure core: `step(state, tick, random) -> { state, events }`. No I/O, no async.
2. I/O lives in adapters outside core: NATS publish, ClickHouse writes, UI. Adapters consume events; they never mutate sim state.
3. Inputs from outside (e.g. UI-injected ride request) enter as queued commands, applied at the start of the next tick. Never mid-tick.
4. Deterministic iteration: process entities in stable order (sorted by ID). No `Promise.all` races or async ordering inside core.

## Events

1. Every state change emits a domain event (names in `domain` skill). Event log = source of truth for replay, NATS, ClickHouse, UI.
2. Events carry sim tick/time, never wall time. Wall time only added by adapters if needed (e.g. ingestion timestamp).

## Tests

1. Unit tests drive `step` directly with a fixed seed and hand-built state.
2. Scenario tests: small seeded scenario, assert on known literal events/outcomes (not recomputed, see `tdd` anti-patterns).
3. Determinism test: run same seed twice, event logs equal.
