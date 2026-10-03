# 0033. Scale fixes: owned brain state, rectangular matching, streaming run checks

- Status: Accepted
- Date: 2026-10-03

## Context

`docs/performance.md` (CI runs 37147796738, 37147805973, 37150061471) measured the simulation at 1k, 5k, and 10k drivers:

- Greedy: copying dispatch's `driverCells` map on every `driver.moved` / `driver.went_online` (`onDriverReported`) takes 83-97% of CPU; per-tick cost grows with drivers². 10k greedy runs at ~0.8 s mean, >1 s p95 per tick (real-time budget is 1 s).
- Batched: `minCostMatching` pads the cost matrix to a square of max(trips, drivers); 99% of CPU, cost grows with drivers³ (~28 min per batch at 5k).
- Memory: `runInProcess` keeps every message (~100-150 B each), so memory grows linearly with run length (several GiB for an hour at 10k).

ADR 0022 defines brains as `decide(state, input, random) -> { state, outputs }` and the code treats state as immutable, copying on every update. The service shell (ADR 0027) never reuses a previous state.

## Decision

We will:

- Treat brain state as owned: `decide` may update the state it receives in place and return it; callers must not use a state after passing it to `decide`. Determinism and purity of inputs/outputs are unchanged (no I/O, no wall clock, seeded randomness). Apply it where a profile shows copying cost: dispatch's driver positions now. Tests that compare before/after states copy explicitly.
- Run the Hungarian algorithm on the rectangular matrix (rows = the smaller side, transposing if needed) instead of padding to a square: O(rows² x columns), exact, same objective and determinism guarantees (ADR 0030). With tens of trips per batch against thousands of drivers this is milliseconds.
- Make the invariant checker and the run summary incremental observers (`observe(message)` then `result()`), fed while the run happens. `runInProcess` keeps the full event log only when a caller asks for it (tests); `bun run sim`, `--compare`, and `bun run bench` don't.
- Re-measure with the CI bench workflow and update `docs/performance.md`. Target: 10k drivers, greedy and batched, p95 under 1,000 ms per tick on the CI runner; memory independent of run length.

## Rationale

- Each fix targets one measured hot spot (>80% of CPU or linear memory growth); nothing speculative (`design` skill §6).
- Owned state is the smallest change that removes O(n) copies per message; it keeps every brain's interface and determinism, and matches how the shell already uses state.
- Rectangular Hungarian keeps batched matching exact; candidate pruning (k nearest drivers) would be faster still but gives up optimality, and isn't needed once padding is gone.
- Streaming checks keep the invariant checker an independent oracle (it still sees only messages) while making memory flat.

## Alternatives considered

- Persistent immutable maps (structural sharing): keeps immutability, adds a dependency or a hand-rolled HAMT for one hot path.
- Batching driver reports per tick: changes message semantics for one consumer.
- k-nearest candidate pruning for batched matching: faster, not exact; revisit if rectangular isn't enough.
- Sampling the event log: weakens the invariant checker.

## Consequences

- ADR 0022's "returns a new state" contract becomes "returns the (possibly updated) state"; the `simulation` skill states the ownership rule.
- Batched runs may pick a different (equally optimal) assignment than before, so batched comparison numbers can shift slightly; greedy and uniform defaults stay byte-identical.
- Scaling past 10k (sharded dispatch, per-service subjects) stays out of scope until measured.
