# 0036. Scale to 50k: indexed brain state, spatial driver lookup, exact results

- Status: Accepted (per-tick dispatch snapshot superseded by 0048; batched sentinel rule superseded by 0051)
- Date: 2026-10-04

## Context

`docs/performance.md` "Toward 50k" (CI runs 37197242785, 37197252026) measured 20k and 50k drivers after the milestone 9 fixes (ADR 0033). At 50k, unprofiled p95 is 267 ms/tick (greedy) and 972 ms/tick (batched); from 20k to 50k, profiled mean time per tick grows ~6x for 2.5x drivers. Ranked by measured CPU share at 50k (attributed to the nearest `src/` caller): driver shards scanning and copying the whole drivers array per event (44% greedy / 36% batched), dispatch matching work per (trip, idle driver) pair (24% / 37%, incl. a cell lookup per pair and a flattened copy of the cost matrix), rider brain scanning and copying the riders array per event (20% / 17%). The profiler itself slows 50k runs by 1.3-1.75x. ADR 0033 already allows brains to update containers they own in place.

## Decision

We will:

- Keep driver shard state in a map by driver ID (a fixed set inserted in sorted order, so iteration order is unchanged) and rider state in a map by trip ID (how riders are looked up), updating entries in place (ADR 0033). This removes per-event full-array scans and copies. Iteration that affects outputs keeps today's order (sorted by ID, plain string order; riders keep their per-tick sort, since insertion order differs from string order), so results are unchanged.
- In dispatch, take one snapshot per tick of eligible idle drivers and their cells. Greedy finds the nearest eligible idle driver with a uniform grid index over cells, returning exactly the driver the linear scan returns: eligible = in the snapshot (known cell, no pending offer, no active trip) and not already taken this tick and not excluded for the trip; search buckets in growing square rings around the pickup and keep expanding until the ring's minimum possible Manhattan distance exceeds the best distance found (a square ring at radius r holds distances r..2r, so the first non-empty ring isn't enough); among all candidates at the best distance pick the lowest driver ID (plain string order). When few drivers are eligible, a linear scan over the snapshot is used instead (same result), bounding the worst case. Batched builds its cost matrix from the snapshot, and the solver computes the same sentinel value (sum of real costs + 1) without flattening the matrix, so ties resolve as before.
- Require every fix to keep outputs byte-identical to master (`bun run sim` seeds and the README `--compare` commands, full in-process event logs).
- Judge the milestone on CI, unprofiled: 50k drivers, greedy and batched, p95 < 1,000 ms per tick, counted as reliably met only if the slower of two separate runs has p95 <= 610 ms (headroom >= 1.64x, the largest run-to-run spread seen so far); a pass inside that band is reported as "not reliably met". Memory grows with trips, not messages (peak RSS and heap at 600 vs 1,800 ticks). Profiles explain, they don't judge.

## Rationale

- Each change removes an O(n) or O(trips x drivers) step that the profile shows; together they cover ~85-90% of measured CPU at 50k.
- Exact equivalence keeps every earlier result, test, and README table valid and makes each change easy to verify (identical logs).
- A uniform grid index is the simplest exact nearest-neighbour structure for integer cells and a bounded grid; no dependency.
- Unprofiled timing and a headroom band address what milestones 9 and 12 measured: single runs vary by up to ~60-64%, and the profiler distorts timings at this scale by 1.33-1.75x.

## Alternatives considered

- k-nearest candidate pruning for batched matching: faster still, but gives up the exact optimum (ADR 0030); revisit only if exact batched misses the target after these fixes.
- Sharding dispatch: a larger architectural change (new ownership of trips); not needed while one dispatch fits the budget.
- More driver shards: helps distributed runs, not the single-process measurement, and doesn't remove per-event O(n) work.

## Consequences

- Driver, rider, and dispatch internals change shape; their interfaces and messages don't.
- If exact batched still misses the target, a follow-up ADR decides between pruning and dispatch sharding.
- The grid search's worst case (few, far eligible drivers) is bounded by the linear-scan fallback; its threshold is a tuning detail chosen from measurement.
