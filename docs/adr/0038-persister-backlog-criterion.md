# 0038. Judge the persister by its backlog in ticks of events

- Status: Accepted
- Supersedes 0037's persister trend criterion
- Date: 2026-10-04

## Context

ADR 0037 counts a fleet as supported live only if the persister's mean pending count in the second half of a run is not higher than in the first half. On the milestone 13 runs ([Live limits](../performance.md#the-pending-trend-rule-at-t--600)) that rule read "rising" in 15 of 16 runs, including 9 of the 10 where the persister kept up: there pending steps from about 0 to a flat level just under one tick's events and stays there. The 5 s sampler is not aligned with the 1 s tick, so a sample's phase within the tick moves over the run. The drain bound can't stand in for it: runs that fell behind by about 2.3k events/s still drained within 5 minutes. Runs that kept up stayed at or under 1 tick of events; runs that fell behind grew linearly, at 337 events/s or more.

## Decision

We will replace ADR 0037's persister trend criterion with a backlog criterion: the persister's backlog (consumer `num_pending` + `num_ack_pending`, i.e. events published but not yet persisted and acked), taken as its maximum over the second half of the samples, must be at most 3 x the run's events per tick. Every other ADR 0037 criterion (T >= 600, settle p95 <= 610 ms, <= 1% overruns, drain within the bound, no slow consumers, slower of two runs) stays. `bun run loadtest` prints the backlog maximum, the limit, and the verdict in place of the trend.

## Rationale

- Bounds lag, the thing that matters: the persister is never more than about 3 s of events behind, regardless of where in the tick a sample lands.
- Separates the milestone 13 runs cleanly: in those that kept up, `num_pending` peaked at 1 tick or less (ack pending, at most 1,000 there, adds under 0.1 tick at 10k+); the smallest failing one (11k, 337 events/s) reached 173k, about 15 ticks.
- 3 ticks, not 1 or 2: leaves room for a persister that holds more than one batch in flight (milestone 14 may pipeline it), counted in `num_ack_pending`, without letting sustained growth pass over a 300 s second half (337 events/s grows by about 100k).
- Needs one small sampler change: the report records `num_pending` per sample but `num_ack_pending` only as a run-wide maximum; it must sample both together.

## Alternatives considered

- Keep the trend, sample at a fixed phase after `clock.ticked`: fixes the step artifact, but a slow, steady rise still passes or fails on noise; it says nothing about how far behind the persister is.
- Least-squares slope with a threshold: sensitive to batch oscillation, and its threshold has no unit a reader can relate to.
- Drain time only: misses persisters that fall behind slowly and catch up after the last tick.

## Consequences

- Live limits from milestone 13 ([Live limits](../performance.md#live-limits)) were judged with a 2-tick version of this rule on `num_pending` alone; every run that passed there peaked at 1 tick or less of `num_pending` and at most 1,000 more in ack pending, so they stand under 3 ticks of backlog.
- The loadtest sampler records `num_pending + num_ack_pending` per sample, and the report's trend line is replaced by the backlog line.
- A persister that falls behind by less than about 3 ticks' worth over a 600-tick run passes; longer runs judge it more strictly.
