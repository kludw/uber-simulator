# 0043. Learn drivers from moves instead of ordering service start

- Status: Accepted
- Date: 2026-10-05

## Context

`bun run dev` and `bun run loadtest` start the persister first, then dispatch, the riders, the driver shards, and the clock at once. Each driver shard publishes its online drivers' `driver.went_online` right after its subscriptions are flushed (ADR 0042). Core NATS delivers a message only to subscriptions that exist when the server routes it, with no replay (ADR 0028). When dispatch subscribes after a shard started publishing, it misses some or all of that shard's start-up `driver.went_online`.

Measured on the load test artifacts ([#195](https://github.com/kludw/uber-simulator/issues/195), [performance.md](../performance.md#start-up-race)): dispatch's received count is constant per size in most runs and short by 1,408 (greedy 40k), 22,568 (batched 30k) and 8,168 (batched 32.5k) in three runs; each shortfall is below the fleet size, and in the two largest dispatch logged `service_started` after both shards. The shards' and riders' received counts (offers, `trip_status`, replies) are the same in the short and full runs at 40k greedy and 30k batched: the trip flow didn't change.

Dispatch already treats `driver.moved` like `driver.went_online` (stores the driver's cell). An idle driver moves on tick 1 (unless its first wander target is its own cell, then on a later tick), and dispatch matches only on `clock.ticked`, from tick 2 for the first requests (tick 1). So a missed start-up `driver.went_online` delays nothing.

## Decision

We will keep the start order as is and rely on dispatch learning a driver from its first `driver.moved` when it missed `driver.went_online`, pinned by a brain test ("offers a trip to a driver first seen moving"). Load test comparisons of dispatch's received count allow a start-up shortfall of up to one fleet.

## Rationale

The race costs no behavior, only up to N of ~600N messages in dispatch's count. Ordering start adds a readiness handshake for one more service in two launchers to fix a measurement detail.

## Alternatives considered

- Start dispatch (and other subscribers) before the shards, waiting for each `service_started` as for the persister: makes counts exact, at the cost of a slower, more coupled start in `src/sim/dev.ts` and `src/loadtest/main.ts`; no behavior gained.
- Have the shards publish `driver.went_online` on tick 1 instead of at start: the clock's start delay then orders it after every subscription, but it changes the driver brain and the events' tick (0 -> 1) for every consumer.
- JetStream for driver events: replay for a start-up detail, against ADR 0028.

## Consequences

- Dispatch's received count may differ between runs of one size by up to the fleet size; compare counts net of that.
- Any new consumer of driver events must also learn a driver from `driver.moved` (the UI view already does, ADR 0020), or need its own start-order guarantee.
