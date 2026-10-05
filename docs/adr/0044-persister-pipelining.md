# 0044. Fetch the persister's next batch while the current one is persisted

- Status: Accepted
- Supersedes 0039's one-round-at-a-time loop and max ack pending
- Date: 2026-10-05

## Context

The persister (ADR 0029, 0039) runs one round at a time: fetch up to 10,000 messages or 1 s, decode, insert (async insert with wait), ack after the insert, then fetch again. Max ack pending equals the batch size, so the next fetch can't start until the current batch is acked anyway.

[Infra CPU](../performance.md#infra-cpu) (#198) on the live greedy 35k runs: the runner isn't saturated (1.8-2.3 of 4 cores), and the persister uses under two thirds of a core. 35k fails ADR 0038's backlog bound only when a large ClickHouse merge (about 20.7M rows at 1.1-1.2 cores, about 20 s) lands before tick 600; the backlog then climbs from 42k to 130k against a limit of 106k. In the rounds while it was behind (EPYC 7763, run 37363362139, about 568-610 s), per 10,000 events: fetch 89-142 ms, decode + insert + ack 165-200 ms, round 259-336 ms, so 30-39k events/s against 35.3k published. Fetch and the rest run one after the other, so the merge's extra insert and decode time adds straight to the round. While keeping up, a round is 10,000 events / arrival rate and fetch is mostly waiting.

## Decision

We will start the next fetch as soon as a fetch returns, so it runs while the batch just fetched is decoded, inserted and acked. Persisting stays serial: one insert at a time, batches inserted in fetch order, each batch acked only after its own insert succeeds. Max ack pending becomes 2 x the batch size (20,000): the batch being persisted plus the one being fetched. On stop, no new fetch starts; the batch in hand and the one already being fetched are both persisted (or given up) before `stopped` resolves, so a stop leaves no fetched message waiting out the ack wait. Batch size, batch wait, async insert with wait, the retry policy and ack wait (60 s) are unchanged. The `rounds_timed` log's `fetchMs` now counts only the wait for a batch once the previous round is done.

## Rationale

- Removes the cost the behind-state rounds show: a round becomes about max(fetch, decode + insert + ack) instead of their sum, about 170-200 ms instead of 259-336 ms per 10,000 events, about 50-59k events/s against 35.3k published. That headroom is what a 20 s merge at 35k needs. Decode is synchronous on the same thread as the NATS client's reading, so the overlap is mostly with the insert's and the fetch's network waits; the CI runs below measure what is left.
- At-least-once and FINAL dedupe are untouched: ack after insert, retries and stop-time give-up as before, one insert in flight, so no extra parts per second and no reordering of inserts.
- Small, local change in one module (`src/persister/persister.ts`); no message shape, consumer, or table changes.
- Backlog: up to 20,000 ack pending is 0.57 ticks at 35k (35.3k events per tick), inside ADR 0038's 3-tick bound, which already allowed for a pipelined persister.

## Alternatives considered

- ClickHouse merge settings (e.g. limiting merge size or threads on the events table): would likely move the large merge in time or split it, not remove the work; not measured. Changes table settings for every reader and can raise the part count. Kept in reserve if a pipelined persister still falls behind during merges.
- Fewer, larger position messages (one `driver.moved` batch per shard per tick): cuts NATS and per-message decode cost, but is a message-shape change for every consumer (persister rows, UI, replay, invariants, analytics). The runner has 1.7-2.2 idle cores on average, so CPU elsewhere isn't what the persister waits on.
- Concurrent inserts (two batches inserting at once): more parts per second and out-of-order acks across batches; serial persisting already hides fetch, the larger part of the round.
- Larger batches (20,000+): halves the fixed insert cost per event, but the fetch still runs serially and adds a full tick of ack pending per batch.

## Consequences

- A batch fetched during a slow insert also waits out that insert before its own; with two inserts at the 30 s client timeout in a row it can outlive the 60 s ack wait and be redelivered while still in hand. Harmless as for retries (ADR 0029): copies share `stream_seq` and collapse under FINAL.
- After a crash, up to 20,000 events are redelivered instead of 10,000.
- `rounds_timed` `fetchMs` is no longer comparable to earlier measurements: it now shows only fetch time not hidden behind the previous round.
- The existing durable consumer's max ack pending is updated in place on the next persister start (ADR 0029's add-then-update).
- Measured on CI ([Persister pipelining](../performance.md#persister-pipelining), runs 37383732053 and 37383743954): greedy 35k passes every criterion in both runs, both on the EPYC 7763 with the large merge inside the run; the backlog peaks at 47-67k against the 106k limit (130k before). Rounds while the merge runs are 266-294 ms, not the projected 170-200: fetch is hidden (18-27 ms left), but decode and insert grow by about 20 ms each, presumably the NATS client parsing the next batch on the same thread. 40k passes on an EPYC 9V74 and fails the backlog bound on an EPYC 7763 (201k vs 121k) when the merge lands. Further headroom needs less work per event in the persister or less merge work, not more overlap.
