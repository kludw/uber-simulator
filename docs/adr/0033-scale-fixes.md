# 0033. Scale fixes: owned brain state, rectangular matching, streaming run checks

- Status: Accepted (dense rectangular solve for queued ≤ idle superseded by 0051)
- Date: 2026-10-03

## Context

`docs/performance.md` (CI runs 37147796738, 37147805973, 37150061471) measured the simulation at 1k, 5k, and 10k drivers:

- Greedy: copying dispatch's `driverCells` map on every `driver.moved` / `driver.went_online` (`onDriverReported`) takes 83-97% of CPU; per-tick cost grows with drivers². 10k greedy runs at ~0.8 s mean, >1 s p95 per tick (real-time budget is 1 s).
- Batched: `minCostMatching` pads the cost matrix to a square of max(trips, drivers); 99% of CPU, cost grows with drivers³ (~28 min per batch at 5k).
- Memory: `runInProcess` keeps every message (~100-150 B each), so memory grows linearly with run length (several GiB for an hour at 10k).

ADR 0022 defines brains as `decide(state, input, random) -> { state, outputs }`, pure and synchronous; it says nothing about copying, but the code copies state containers on every update by convention (also stated in the `design` skill as "pure functions over immutable data"). The service shell (ADR 0027) never reuses a previous state. Brain state holds references to objects from input messages (e.g. a driver's `Cell` from `driver.moved`), and the in-memory bus delivers the same message object to every subscriber and the event log.

## Decision

We will:

- Treat brain state as owned: `decide` may update containers it created itself (maps, arrays, records inside its state) in place and return the state; callers must not use a state after passing it to `decide`. Input messages, value objects (`Cell`, IDs), and anything placed in an output stay immutable and may be shared. Determinism and the no-I/O / no-wall-clock / seeded-randomness rules are unchanged. Apply it where a profile shows copying cost: dispatch's driver positions now. Tests that compare before/after states copy explicitly.
- Run the Hungarian algorithm on the rectangular matrix (rows = the smaller side, transposing if needed) instead of padding to a square: O(rows² x columns), exact, same objective and determinism guarantees (ADR 0030). With tens of trips per batch against thousands of drivers this is milliseconds.
- Make the invariant checker and the run summary incremental observers (`observe(message)` then `result()`), fed while the run happens. `runInProcess` keeps the full event log only when a caller asks for it (tests) and always reports a message count; `bun run sim`, `--compare`, and `bun run bench` don't keep the log.
- Re-measure with the CI bench workflow and update `docs/performance.md`. Targets: 10k drivers, greedy and batched, p95 under 1,000 ms per tick on the CI runner; memory grows with the number of trips (the checker and summary must remember every trip to flag late events), not with the number of messages. Memory is measured without `--cpu-prof` (it inflates RSS, `docs/performance.md`) by comparing peak RSS of two runs at 10k with different tick counts.

## Rationale

- Each fix targets one measured hot spot (>80% of CPU or linear memory growth); nothing speculative (`design` skill §6).
- Owned state is the smallest change that removes O(n) copies per message; it keeps every brain's interface and determinism, and matches how the shell already uses state.
- Rectangular Hungarian keeps batched matching exact; candidate pruning (k nearest drivers) would be faster still but gives up optimality, and isn't needed once padding is gone.
- Streaming checks keep the invariant checker an independent oracle (it still sees only messages) while memory no longer grows with the number of messages.

## Alternatives considered

- Persistent immutable maps (structural sharing): keeps immutability, adds a dependency or a hand-rolled HAMT for one hot path.
- Batching driver reports per tick: changes message semantics for one consumer.
- k-nearest candidate pruning for batched matching: faster, not exact; revisit if rectangular isn't enough.
- Sampling the event log: weakens the invariant checker.

## Consequences

- No ADR is superseded: 0022's interface is unchanged; the copy-on-update convention, which lived in code and the `design` skill, is narrowed. The `simulation` and `design` skills state the ownership rule.
- Batched runs may pick a different (equally optimal) assignment than before, so batched comparison numbers can shift slightly; greedy and uniform defaults stay byte-identical.
- Scaling past 10k (sharded dispatch, per-service subjects) stays out of scope until measured.
