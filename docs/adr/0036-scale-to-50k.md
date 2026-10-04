# 0036. Scale to 50k: indexed brain state, spatial driver lookup, exact results

- Status: Accepted
- Date: 2026-10-04

## Context

`docs/performance.md` "Toward 50k" (CI runs 37197242785, 37197252026) measured 20k and 50k drivers after the milestone 9 fixes (ADR 0033). At 50k, unprofiled p95 is 267 ms/tick (greedy) and 972 ms/tick (batched); from 20k to 50k, mean time per tick grows ~6x for 2.5x drivers. Ranked by measured CPU share at 50k (attributed to the nearest `src/` caller): driver shards scanning and copying the whole drivers array per event (44% greedy / 36% batched), dispatch matching work per (trip, idle driver) pair (24% / 37%, incl. a cell lookup per pair and a flattened copy of the cost matrix), rider brain scanning and copying the riders array per event (20% / 17%). The profiler itself slows 50k runs by 1.3-1.75x. ADR 0033 already allows brains to update containers they own in place.

## Decision

We will:

- Keep driver shard and rider state indexed by ID (maps) and update entries in place (ADR 0033), removing per-event full-array scans and copies. Iteration that affects outputs keeps today's order (sorted by ID, plain string order), so results are unchanged.
- In dispatch, take one snapshot per tick of eligible idle drivers and their cells. Greedy finds the nearest eligible idle driver with a uniform grid index over cells (bucket search in growing rings), returning exactly the driver the linear scan returns (minimum distance, ties by driver ID). Batched builds its cost matrix from the snapshot and the solver stops flattening the matrix to compute its sentinel.
- Require every fix to keep outputs byte-identical to master (`bun run sim` seeds and the README `--compare` commands, full in-process event logs).
- Judge the milestone on CI, unprofiled: 50k drivers, greedy and batched, p95 < 1,000 ms per tick in two separate runs each; memory grows with trips, not messages (peak RSS and heap at 600 vs 1,800 ticks). Profiles explain, they don't judge.

## Rationale

- Each change removes an O(n) or O(trips x drivers) step that the profile shows; together they cover ~85-90% of measured CPU at 50k.
- Exact equivalence keeps every earlier result, test, and README table valid and makes each change easy to verify (identical logs).
- A uniform grid index is the simplest exact nearest-neighbour structure for integer cells and a bounded grid; no dependency.
- Two runs and unprofiled timing address what milestone 9 learned: single runs vary by up to ~60%, and the profiler distorts timings at this scale.

## Alternatives considered

- k-nearest candidate pruning for batched matching: faster still, but gives up the exact optimum (ADR 0030); revisit only if exact batched misses the target after these fixes.
- Sharding dispatch: a larger architectural change (new ownership of trips); not needed while one dispatch fits the budget.
- More driver shards: helps distributed runs, not the single-process measurement, and doesn't remove per-event O(n) work.

## Consequences

- Driver, rider, and dispatch internals change shape; their interfaces and messages don't.
- If exact batched still misses the target, a follow-up ADR decides between pruning and dispatch sharding.
