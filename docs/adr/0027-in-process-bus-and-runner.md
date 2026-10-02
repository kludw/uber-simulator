# 0027. In-process bus, generic service shell, tick-draining runner

- Status: Accepted
- Date: 2026-10-02

## Context

Milestone 2 (`docs/spec.md`) runs all services in one process over an in-memory bus, headless, with an invariant checker. Brains exist (ADR 0022) and are pure; shells don't. The same shells must later run over NATS (milestone 3, ADR 0017) without changes. Offers must reach only the driver shard that owns the driver (the driver brain throws otherwise).

## Decision

We will:

- Define one `Message` union in `src/shared/messages.ts` covering every message brains consume or publish. `input_rejected` is excluded: it is never published.
- Define a `Bus` port in `src/bus/bus.ts`: `publish(message)` and `subscribe<Input extends Message>(accepts: (message: Message) => message is Input, handle: (message: Input) => void)`. Subscriptions filter by type-guard predicate, so a driver shard accepts only offers for its own drivers and the handler receives the brain's own input type without casts. A message nobody accepts is dropped (e.g. `request_trip_accepted`, `cancel_trip_accepted`).
- Implement `createInMemoryBus()` in `src/bus/in-memory.ts`: published messages go into one FIFO queue; `drain()` delivers them in publish order, subscribers in subscription order, until the queue is empty. No async.
- Implement one generic service shell in `src/bus/service.ts`, built from a start result `{ state, outputs }`: publishes the start outputs when the service starts (e.g. `driver.went_online`; brains whose start returns bare state are wrapped with empty outputs by the runner), then feeds each accepted message to `decide`, publishes outputs in order except `input_rejected`, which it logs and never publishes (ADR 0026). Brains stay unaware of the bus.
- Implement the runner in `src/sim/`: starts services at tick 0 in a fixed order (driver shards by index, dispatch, riders) with seeded child streams, drains, then for each tick publishes `clock.ticked` itself (the runner is the clock in milestone 2; a clock service replaces it in milestone 3) and drains. The event log is every published message in publish order, start outputs included. Runner config parsed with Zod where it enters from the CLI (ADR 0005).
- Check spec invariants with a pure `checkInvariants(eventLog)`.

## Rationale

- FIFO drain per tick makes the whole in-process run deterministic: same seed and config give an identical event log, so system bugs replay exactly in milestone 2 even though milestone 3 gives that up (ADR 0017).
- Predicate subscriptions express both broadcast events and shard routing without a subject scheme; NATS subjects (ADR 0015) map onto them later.
- Three services share the exact same shell shape (third use, AHA), so one shell hides the bus from every brain.

## Alternatives considered

- Per-service shells: three copies of the same loop.
- Synchronous delivery inside `publish` (recursive): message order would depend on call depth, not publish order.
- Topic strings instead of predicates: duplicates the NATS subject scheme before it's needed.

## Consequences

- Shells and runner are testable without NATS; the NATS adapter (milestone 3) implements the same `Bus` port.
- Zod schemas for messages arrive with the NATS adapter, where messages cross a process boundary; the in-memory bus passes typed values.
- `drain()` exists only on the in-memory bus; the NATS runner paces by the clock service instead.
- `publish` is fire-and-forget; offer replies and command replies are ordinary messages routed by predicate. The NATS adapter (milestone 3) decides whether to map them onto request/reply (ADR 0014, 0015) or plain subjects.
