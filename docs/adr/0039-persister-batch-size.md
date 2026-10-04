# 0039. Persist up to 10,000 events per round

- Status: Accepted
- Supersedes 0029's batch size and max ack pending
- Date: 2026-10-04

## Context

The persister (ADR 0029) fetches up to 1,000 messages or 1 s, inserts them in one ClickHouse insert (`async_insert = 1, wait_for_async_insert = 1`), acks them, and only then fetches again. The consumer's `max_ack_pending` is 1,000. [Persister timing](../performance.md#persister-timing) (#165, 10k and 12k greedy on CI) shows every round full (1,000 events), the persister in a round almost all the time, and per 1,000-event round: insert 62-67 ms (63-76%), fetch 12-29 ms, decode about 8 ms, ack under 1 ms. That caps it at 11-12k events/s; milestone 14 targets live greedy 20k, about 20k events/s.

ClickHouse recommends inserts of at least 1,000 rows, ideally 10,000-100,000, at about one insert per second, and async inserts only when clients can't batch ([insert strategy](https://clickhouse.com/docs/best-practices/selecting-an-insert-strategy)). Async inserts with wait return after the buffer flushes, at an adaptive timeout of 50-200 ms ([async inserts](https://clickhouse.com/docs/optimize/asynchronous-inserts)).

Local measurement (one serial client, events-table rows, median of 20 inserts, laptop under load, so indicative only): 1,000 rows 70 ms async / 72 ms sync; 5,000 rows 84 ms sync; 10,000 rows 105 ms async / 102 ms sync; 20,000 rows 144 ms sync. An insert costs about 60-70 ms however small, plus about 4 µs per row.

## Decision

We will raise the persister's batch size from 1,000 to 10,000 messages, and the consumer's `max_ack_pending` with it (it stays equal to the batch size). Batch wait (1 s), async insert with wait, ack after insert, the retry policy, and the one-round-at-a-time loop stay as in ADR 0029.

## Rationale

- Targets the measured cost: the fixed ~60 ms per insert is paid once per 10,000 events instead of ten times. Projected round at 10,000 events, from the per-event costs above: insert about 105 ms, decode about 80 ms, fetch about 120 ms at 12k's 12 µs per event, about 300 ms in all, about 30k events/s, 1.5x the 20k target. Per-event fetch cost is the uncertain part: the 1,000-event rounds didn't separate delivery from waiting on ack pending.
- 10,000 rows is the bottom of ClickHouse's recommended range; at 20k events/s it is 2 inserts per second, near the recommended one.
- `max_ack_pending` must be at least the batch size, or a fetch returns at most that many messages.
- Smallest change: one constant. At-least-once and FINAL dedupe are untouched; a failed insert still leaves its whole batch unacked.
- Async insert kept: at 10,000 rows it measured the same as sync, and at low volume (dev, ~200 events/s per 1 s batch) batches stay under 1,000 rows, where ADR 0029's reason for it still holds.

## Alternatives considered

- Sync inserts at 1,000 rows: measured the same per insert as async (72 vs 70 ms); doesn't move the cap.
- Pipelining (fetch and decode the next batch while the current one inserts, `max_ack_pending` 2x batch): hides fetch and decode behind insert, but adds ordering and stop-time bookkeeping for acks across overlapping rounds. Kept as the next step if 10,000-event rounds still fall short.
- Concurrent inserts from several rounds, or several persister processes: more parts per second and more moving parts; the issue rules out multiple processes unless a single one can't keep up.
- Larger batches (50,000-100,000): fewer inserts, but up to 5-10 ticks of events in ack pending, which ADR 0038's 3-tick backlog bound counts, and longer redelivery after a crash.

## Consequences

- Backlog under load includes up to 10,000 ack pending (under 1 tick at 12k, 0.5 at 20k), inside ADR 0038's 3-tick bound.
- A crash or failed batch redelivers up to 10,000 events instead of 1,000; FINAL collapses them as before.
- The existing durable consumer is updated in place on the next persister start (ADR 0029's add-then-update).
- Measured on CI ([After raising the batch size](../performance.md#after-raising-the-batch-size)): 12k and 20k greedy each keep up in two runs; insert 54-88 ms per 10,000 events; the persister now spends most of each round waiting in fetch for a full batch, and decode is its largest busy phase.
