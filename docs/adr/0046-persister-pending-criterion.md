# 0046. Judge the persister by events not yet delivered to it

- Status: Accepted
- Supersedes 0038
- Date: 2026-10-06

## Context

ADR 0038 bounds the persister's backlog, consumer `num_pending + num_ack_pending`, at 3 ticks of events (second-half max over the 5 s samples). The two parts are different things: `num_pending` is published events not yet delivered to the persister, `num_ack_pending` is events delivered to it but not yet acked, i.e. its own in-flight batches. Since ADR 0044 two batches are in flight (the one being inserted and the next fetch), each up to 10,000 messages or 1 s of fetch wait, capped at 20,000 ack pending.

At milestone 17 (35-45k events per tick) the in-flight part was at most 0.44-0.57 ticks. Since ADR 0045 one `drivers.moved` is one event, so a tick is 350-3,000 messages and a persister that keeps up holds about 1-2.5 ticks in flight by design; batched publishes in bursts on batch ticks, so one 1 s fetch can hold more than an average tick. Batched 40k failed ADR 0038's bound in both runs while keeping up: the backlog max equalled the ack pending max, nothing waited ([What one unit of backlog now is](../performance.md#what-one-unit-of-backlog-now-is)).

## Decision

We will bound only the events not yet delivered to the persister: consumer `num_pending`, its maximum over the second half of the samples, must be at most 3 x the run's events per tick. Events in the persister's hands (`num_ack_pending`) don't count. The sampler records `num_pending` and `num_ack_pending` separately per sample; `bun run loadtest` prints both series, the ack pending max, and the verdict line `persister backlog (pending) <= 3 ticks of events`. Every other ADR 0037 criterion stays.

## Rationale

- Measures lag, not the persister's own work: a pull consumer that keeps up has a fetch open, so new events are delivered at once and `num_pending` stays near 0 whatever the message size or burst; it grows only when the persister stops pulling (slower than the fetch window, or 20,000 ack pending reached). In-flight work is bounded separately, by ADR 0044's max ack pending and 1 s fetch wait.
- Keeps 0038's meaning and number: at most about 3 s of events waiting, beyond what the persister holds.
- Classifies every milestone 17-18 run that the old reports allow (they record the sum per sample and only the run's ack pending max, so a sample's `num_pending` lies in [sum - ack max, sum], exact where only one sample reaches the ack max). Runs as in [After milestone 17](../performance.md#after-milestone-17), [Persister pipelining](../performance.md#persister-pipelining), [After milestone 18](../performance.md#after-milestone-18):
  - Milestone 17, 26 runs: every verdict is unchanged. The 7 failing runs fall behind at the large ClickHouse merge and stay over 3 ticks after removing all 20,000 ack pending: 37383743954 (40k) 4.47 ticks or more, 37386237720 (37.5k, 40k, 45k) 10.4, 14.4, 98.3, 37386254485 (37.5k, 40k) 4.42, 4.09, 37388839975 (37.5k) 3.01. The 19 passing runs stay at or under their old maximum (at most 2.98 ticks, 37387565997 at 37.5k).
  - Milestone 18, the 19 greedy runs that passed the old bound (50k-225k, 250k on 37496763902 and 37498301955, 300k on 37496753667) still pass. Batched 35k (37498494906, 37498506054), 45k (same runs) and 50k in 37496888714 still pass. Batched 40k in 37498494906 and 37498506054 (at most 2.46, 2.47 ticks), 50k in 37496899926 (2.79) and 100k in 37496888714 (1.42) now pass: their old maxima were in-flight bursts.
  - Not reclassifiable (the sum bounds `num_pending` only to [0, sum] there): greedy 250k in 37496753667 and 37498291450, 300k in 37496763902; batched 75k in 37496888714 and 37496899926, 100k in 37496899926, 150k in 37498516823; batched 200k in 37498516823 printed no report. Each of these also fails settle, overruns or slow consumers, so no run's overall verdict, and no live limit, changes.

## Alternatives considered

- Age of the oldest unacked event (server time minus the publish time of the message after the ack floor): lag in seconds, immune to message size, but needs a stream message read per sample, still counts in-flight time (up to about 2 s by design), and no old run can be reclassified with it.
- Keep the sum, raise the limit by max ack pending (3 ticks + 20,000): computable from old reports, but 20,000 is 7-58 ticks at milestone 18 rates, so a persister seconds behind would pass.
- Keep the sum, raise the limit to 3 ticks + two fetch windows: ties the criterion to persister config, and a burst larger than an average tick still fails it.

## Consequences

- Batched 40k passes, so batched is supported at 35k, 40k and 45k (live limit unchanged at 45k).
- A persister whose in-flight batches are slow but which never stops pulling passes this bound; the drain bound still catches one that leaves work at the end.
- Reports from now on record `num_ack_pending` per sample, so in-flight size can be studied per run.
