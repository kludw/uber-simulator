# 0042. Each service subscribes only to the message types it takes

- Status: Accepted
- Date: 2026-10-05
- Supersedes 0028's one `sim.>` subscription per service with local predicate filtering

## Context

ADR 0028 gives every service one `sim.>` subscription and filters by predicate: it keeps each publisher's order with no reasoning about subscriptions, and per-service subjects were named as the scaling step "when needed". [Service timing](../performance.md#service-timing) (#189, greedy 25k / 27.5k, 4-CPU CI runners) shows it is needed:

- Every service receives and decodes all ~15-17M messages of a 600-tick run, ~N `driver.moved` per tick. Dispatch uses 98.9% of them; the shards 0.3%, the riders 0.2%, the clock none.
- Decode (JSON parse + Zod) is 57-59% of each shard's timed ms, 97-99% of the riders' and clock's, 76-78% of dispatch's: 5-11 µs per message on CI. The same decode costs ~0.45 µs in isolation on an M1 Pro (JSON.parse 0.22 + Zod 0.22): on CI it is mostly waiting for one of 4 CPUs while five services each decode the same burst. The clock alone, which only publishes, uses 76-114 s CPU per run ([CPU time per service](../performance.md#cpu-time-per-service)).
- `trip.matched` closes 99.8% of ticks: the path is clock -> shards move drivers -> dispatch offers -> the shard handles the offer -> its reply -> dispatch. A shard handles an offer only after decoding every `driver.moved` queued before it (both shards' ~N), and dispatch handles the reply after its own ~N. Both queues are on the settle path.

## Decision

We will:

- Make each subscriber name the message types it takes: `Bus.subscribe(types, handle)`; `startService` takes `inputs` (types) and an optional `accepts` narrowing them (a shard's offers to its own drivers). The type list replaces the predicates; handlers still get their own input type.
- Have each NATS bus subscribe, at connect, one subject per input type (`subscriptionSubject` in `src/shared/subjects.ts`: the type's subject, `sim.offers.*` for offers), flushed before connect returns. The clock subscribes to nothing; `runOverNats`'s recorder to every type.
- Deliver every subscription through one synchronous client callback (nats.js `callback` option), which the client calls in the order messages arrive on the connection; the server queues one publisher's messages to a connection in publish order. Per-publisher order (offer before `trip.cancelled` at a shard) holds across subscriptions; a NATS test checks it.
- Keep messages, subjects, and the in-memory bus's delivery order and loss draws unchanged: in-process runs are byte-identical.

## Rationale

- Cuts the work no brain uses: locally (M1 Pro, 27.5k greedy, 120 ticks) CPU per service fell from 10.3-13.2 s to 0.4 s (clock), 0.9 s (riders), 3.9 s (each shard); dispatch 12.8 -> 10.5 s. On a 4-CPU runner that frees most of the contention inflating every decode.
- Takes the shards' decode off the settle path: a shard now receives ~70 messages per tick instead of ~N, so its offers wait only on its own moves. Locally, settle p95 fell from 242.9 to 108.7 ms. On CI (two runs each), greedy 27.5k settles at p95 313.1-321.8 ms (595.0-645.3 before, one failing) and 30k at 197.7-381.0 ms, every criterion passing; dispatch decodes at 4.2-4.7 µs per message instead of 7.3-10.9 on the same CPU models ([Subscriptions per service](../performance.md#subscriptions-per-service)).
- Small change: no message, subject, or consumer changes; the predicates were already a type list in a switch.

## Alternatives considered

- Fewer, larger messages (one positions message per shard per tick): cuts dispatch's own per-message cost too, but changes the event shape for every consumer (persister rows, UI, replay, invariants, analytics). Its per-item decode stays (Zod 0.18 vs 0.21 µs per item batched, measured), so the gain is the per-message client and server overhead. Kept as the next step if dispatch's decode still sets settle.
- Skip decoding unaccepted messages on one `sim.>` subscription (filter by subject first): keeps 0028's ordering argument verbatim, but every service still receives, frames, and allocates every message, and the server still fans each one out five times.
- Cheaper decode (no Zod for hot types, or `JSON.parse` only): Zod stays the validation (ADR 0005), and on CI the cost is mostly contention, not the parse itself.
- Separate async iterators per subscription: loses the order between them (each is its own queue).

## Consequences

- 0028's subject scheme, core NATS, and no request/reply stand; its single `sim.>` subscription per service does not. A service's types are listed once, in `src/sim/services.ts`; a missing type means its brain never sees those messages (in-process tests catch it).
- Ordering now also relies on the client calling callbacks in socket order and on one server; a cluster would need this revisited.
- A throw in a handler must not escape into the client (it would only stop the client's reader): the bus stops delivering and rethrows it as an uncaught error, as the iterator loop's rejection did before.
- `messages_timed.received` counts only subscribed messages.
