# 0051. Search untouched drivers by nearest query in batched matching

- Status: Accepted
- Date: 2026-10-07
- Refines 0030 and 0033 (solver only; objective, determinism and offers unchanged)

## Context

Batched matching (ADR 0030) solves each batch window's queued trips × idle drivers exactly with a rectangular Hungarian solver (ADR 0033) that never stores the matrix (#213): each augmenting-path step asks for one trip's row of distances to every idle driver and scans it. A batch costs O(steps × idle), where steps is the total number of shortest-path steps over all queued trips. One dispatch instance holds 50k live and fails settle at 55k; `2x2` regions hold 100k ([After milestone 21](../performance.md#after-milestone-21)). Milestone 22's target: 100k at `1x1`, 150k at `2x2`.

Profile and spike in [Cheaper batched matching](../performance.md#cheaper-batched-matching): at 50k-55k in process, the Hungarian loop is 71% of dispatch's CPU and row filling 16-20%; a batch takes 215 ms unprofiled (EPYC 9V45) for about 412 queued trips against 32k idle drivers. Each trip's augmenting path is short (2-4 steps on average), so almost all of that work reads drivers no path ever reaches.

In the solver, a column (idle driver) no augmenting path has reached yet ("untouched") still has potential 0 and no trip. So, from a trip whose row the path visits, the least reduced cost over all untouched columns is its nearest untouched allowed driver's distance minus the trip's potential: a nearest-driver query, which the idle driver index already answers exactly (ADR 0036/0048). Only touched columns (at most one per queued trip plus those reached by paths) need explicit costs.

## Decision

We will make the batch solver exact over touched columns plus one nearest query per visited trip, instead of scanning every idle driver:

1. **Same objective and outputs** (ADR 0030): as many pairs as possible, least total pickup distance among those; excluded drivers not allowed; offers as today. Which of several optimal assignments comes back stays unspecified.
2. **Shortest augmenting paths with potentials, columns materialized lazily**: a trip's row is visited, its costs to touched columns computed directly, and its untouched candidate is the nearest idle driver neither touched nor excluded for it (ties to the lowest ID, as `nearestIdle`). The candidate is cached per trip and re-queried only once that driver is touched (untouched columns only shrink, so the cached one stays nearest). Reaching an untouched candidate ends the path. A trip with no allowed untouched driver gets any untouched driver at the sentinel cost, as a disallowed cell is today; sentinel = queued × (grid width + height − 2) + 1, larger than any whole set of allowed pairs (no sum over the matrix).
3. **When more trips are queued than drivers are idle**, keep today's dense solver on the transpose (rows = idle drivers, the small side).
4. **Exact, so no option and no mode**: the solver replaces the dense path for queued ≤ idle; `--matching batched` keeps its name and meaning. Inexact k-nearest pruning is not adopted.
5. **Module boundaries**: the solver stays in `src/dispatch/matching.ts` and doesn't import the index: dispatch passes the nearest query as a callback (pickup, a predicate for drivers to skip) and the index gains the variant that returns the driver's cell. The per-batch idle list sorted by ID (`idleDriversById`) is built only for the dense case.

## Rationale

- Exact: the untouched candidate is the true minimum over all untouched columns, so each path is the one the dense solver would find up to ties. Checked on 3,000 random instances (grids of 1-120 cells across, up to 200 drivers, heavy exclusions: same pair count and total distance as the dense solver) and on every batch of 50k in-process runs (both solvers on the same input: 40 batches at `1x1`, 160 at `2x2`, all equal).
- It removes the work the profile shows (Hungarian loop + row filling, 87-91% of dispatch's CPU at 50k-55k) rather than shaving it: a batch at 50k drops from 215 to 5.3 ms (same CPU model, unprofiled); live results in [Cheaper batched matching](../performance.md#cheaper-batched-matching).
- No quality cost to measure or to explain in the README: summaries of every README `--compare` scenario are unchanged.
- Keeps the decisions where they live: the solver owns the algorithm, the index owns spatial search.

## Alternatives considered

- **k-nearest candidate pruning** (each trip only sees its k nearest idle drivers): inexact unless k = queued (a trip matched outside its queued-nearest drivers can always swap to a free one among them), which at 400-900 queued trips is little pruning; any smaller k changes outcomes and needs a quality trade-off. The exact option is faster than any pruned dense matrix of useful k, so not needed.
- **Candidate bound k = queued + excluded** (exact by the swap argument): cuts columns to at most queued² but still fills them; the lazy solver touches about one column per trip.
- **Warm-started duals across windows**: queued trips and idle drivers change each window, and most of the cost is scanning columns, not the number of steps.
- **Cheaper row filling** (typed arrays, SIMD-friendly loops): at most the 16-20% row filling share; the scan stays O(idle) per step.
- **Decomposing into independent subproblems** (spatial clusters): needs a bound to prove independence and adds a second partitioning beside regions; the lazy solver already only touches local drivers.

## Consequences

- Batched dispatch's batch cost no longer grows with idle drivers per step, only with how many drivers paths reach and the nearest queries; at 100k in process a batch takes 14-357 ms depending on how far idle drivers are from pickups (mid-run, when most drivers are busy).
- Event logs of batched runs may differ from master where several assignments are equally optimal; summaries and invariants unchanged (README outputs unchanged).
- The trips > idle case keeps the dense solver: rare at the live limits, cheap when it happens (the idle side is small).
- Follow-up: implementation (#241), then re-measure live limits (#242).
