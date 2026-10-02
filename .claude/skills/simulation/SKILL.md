---
name: simulation
description: Project rules for the simulation - independent services with pure seeded brains, the clock service and ticks, seeded randomness, deterministic IDs, bus port, brain tests and system invariant tests. Use whenever writing or changing simulation logic, anything touching time/clocks/timers, randomness, IDs, ticks, services, or simulation tests.
---

# Simulation

Architecture (0017): clock, driver (sharded), rider, dispatch run as independent services, each owning its state, talking over a bus. Behavior: `docs/spec.md`.

Goal: each service's decision logic ("brain") is exact and replayable from a seed. The system as a whole is not: message ordering between services is nondeterministic, and that's accepted.

## Brains (pure, deterministic)

1. Shape (ADR 0022): a start function `start<Service>(config, random?) -> state` (or `{ state, outputs }` when starting emits events), and `decide<Service>(state, input, random) -> { state, outputs }`. Input = discriminated union of received messages (tick, events, commands, offers). Outputs = messages to publish, in emission order. No I/O, no async.
2. Brains never call `Date.now()`, `new Date()`, `performance.now()`, `setTimeout`/`setInterval`, `Math.random()`, `crypto.randomUUID()`.
3. Seeded PRNG behind a small `Random` interface, injected. Seed per service in config, logged at service start. Independent concerns (e.g. demand vs patience) get child PRNGs derived from the seed.
4. IDs from a deterministic generator (counter or seeded), not UUIDs. IDs must be unique across services: prefix with service/shard (e.g. driver IDs fixed by shard config).
5. Deterministic iteration inside a brain: stable order (sorted by ID). Ties broken by ID.
6. Invalid transition = domain error (see `errors` skill), never silently ignored.
7. Inputs about entities this service doesn't own (e.g. drivers in another shard) = broadcast traffic, ignore silently. Inputs addressed to an owned entity but invalid for its state = output `{ type: "input_rejected", reason, input }` (`InputRejected` in `src/shared/messages.ts`); shells log it, never publish it (ADR 0026).

## Time

1. Sim time = tick number from the clock service (`clock.ticked`). 1 tick = 1 s sim time.
2. Only the clock service paces by wall time: publishes a tick every 1 s wall / speed multiplier. Pause/speed = clock concern. Other shells use wall time only for transport timeouts (point 3).
3. Other services act on received ticks, never on their own timers. Timeouts expressed in ticks inside brains. Exception: transport-level request timeouts in the shell (e.g. offer request/reply), derived from tick duration.
4. Events carry tick, never wall time. Wall time only added by adapters if needed (e.g. ingestion timestamp).
5. Events produced by non-tick inputs carry the last `clock.ticked` tick the brain saw; start functions take the start tick.

## Shell (imperative, per service)

1. Shell = bus subscriptions, feeding inputs to the brain one at a time, publishing its outputs. Never decides anything.
2. Bus is a port with two adapters: in-memory (single process, tests, milestone 2) and NATS. Brains never import either.
3. One input processed at a time per service: no concurrent mutation of service state.

## Tests

1. Brain unit tests: hand-built state + fixed seed, call `decide` directly, assert exact literal outputs (not recomputed, see `tdd` anti-patterns).
2. Brain determinism: same seed + same inputs twice -> equal outputs.
3. System tests (in-memory bus or NATS): run N ticks, assert invariants from `docs/spec.md` over the event log, never exact event sequences.
