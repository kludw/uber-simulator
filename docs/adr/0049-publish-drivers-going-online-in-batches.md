# 0049. Publish drivers going online in batches per shard and tick

- Status: Accepted (`driverIds` superseded by 0052)
- Date: 2026-10-07
- No ADR is superseded: `driver.went_online` is defined in the `domain` skill and `src/shared/messages.ts` (ADR 0032 introduced going offline and back, not the message shape); the new subject follows 0028's scheme

## Context

Every driver online at start publishes its own `driver.went_online` when its shard starts, before tick 1: N messages in a few seconds, which dispatch, the persister and the load test's observer each receive. From 375k drivers, NATS disconnects dispatch as a slow consumer about 6 s after start (64 MiB pending); dispatch then misses 51k-129k `driver.went_online` and 160-228 `drivers.moved` (2-3 ticks), and the same burst makes the observer receive tick 1 752-1,808 ms late in 16 of 20 greedy runs ([After milestone 19](../performance.md#after-milestone-19), runs 37544202908, 37544208726, 37545407997; the 400k run without a slow consumer, 37545410989, received all 400,000).

With shifts on (ADR 0032), drivers also go online and offline during the run: about one of each per 2,400 ticks per driver (online 1,200-2,400 ticks, offline 300-900). The README's shifts runs (100 drivers, 3,600 ticks) have 105-106 `driver.went_offline` per matching, 0.03 per tick; at 500k that is about 150 `driver.went_online` and 150 `driver.went_offline` per tick across the fleet, against 500k moves per tick in 100 `drivers.moved`. Only the startup burst is a problem; the load test runs with shifts off.

## Decision

We will replace `driver.went_online` with `drivers.went_online { tick, driverIds, xs, ys }` (subject `sim.events.drivers.went_online`): driver i is `driverIds[i]`, online at cell `(xs[i], ys[i])`.

- Same shape and checks as `drivers.moved` (ADR 0047): parallel arrays, one Zod refine per array plus one across them, a transform branding what passed. `driversWentOnline(tick, drivers)` builds one, `forEachWentOnline(message, visit)` reads one, both in `src/shared/messages.ts`, sharing the arrays' schema and loop with `drivers.moved`.
- Every `went_online` a shard has for a tick, at start and on shift changes, goes in chunks of at most 5,000, none when no driver went online, published before the shard's other events of that tick, `drivers.moved` included (a driver going online doesn't move that tick).
- Every consumer treats one entry exactly as it treated one `driver.went_online`: dispatch places the driver (ADR 0043, 0048), the invariant checker marks it online at that cell, the UI shows it idle there (one copy of its maps per message, as for moves). The persister stores one row per message, driver id empty (ADR 0029); replay republishes it unchanged (ADR 0034).
- `driver.went_offline` stays one message per driver.

## Rationale

- Startup goes from N messages to N / 5,000 per shard (100 at 500k), the burst behind dispatch's disconnection and the observer's lateness, with the shape dispatch already decodes cheaply every tick.
- Replacing the event, not adding a startup-only batch beside it: one shape for one fact, so each consumer has one case, as ADR 0045 chose for moves. Batching shift changes too costs nothing extra (the same chunking) and turns ~150 messages per tick at 500k into one per shard.
- `driver.went_offline` is never a burst (at most ~150 per tick at 500k with shifts on, none with shifts off), and the invariant checker's per-driver check of an active trip reads it as is. Batching it would change three consumers for no measured cost; revisit if a profile shows one.

## Alternatives considered

- Batch only the start outputs, keep `driver.went_online` for shift changes: fixes the burst, but every consumer reads two shapes of the same fact.
- Batch going offline too (`drivers.went_offline`): symmetric, but more change for no measured problem.
- Raise NATS's `max_pending` or slow the shards' start: hides the burst instead of removing it; the observer and the persister still decode N messages.

## Consequences

- At start a shard publishes one message per 5,000 drivers; dispatch, the observer and the persister decode about 100 messages at 500k instead of 500k.
- Within a shard's tick the order is now: `drivers.went_online`, `drivers.moved`, the rest; before, a shift change's `driver.went_online` came among the other events in driver ID order. No consumer depends on that order (none reads a driver's `went_online` and another event of the same driver in one tick). In-process outcomes are identical to before.
- Runs stored before this change keep `driver.went_online` rows: replay skips them (`stored_event_skipped`, as for 0047's old moves), so a replayed old run shows drivers once they first move; `bun run report` reads only trip events and is unaffected.
