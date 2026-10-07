# 0051. Search untouched drivers by nearest query in batched matching

- Status: Accepted
- Supersedes 0033's dense rectangular solve (for queued ≤ idle) and 0036's sentinel rule (sum of real costs + 1); 0030's objective, determinism and offers are kept
- Date: 2026-10-07

## Context

Batched matching (ADR 0030) solves each batch window's queued trips × idle drivers exactly with a rectangular Hungarian solver (ADR 0033) that never stores the matrix (#213): each augmenting-path step asks for one trip's row of distances to every idle driver and scans it, so a batch costs O(steps × idle drivers). One dispatch instance holds 50k live and fails settle at 55k; `2x2` regions hold 100k ([After milestone 21](../performance.md#after-milestone-21)). Milestone 22's target: 100k at `1x1`, 150k at `2x2`.

[Cheaper batched matching](../performance.md#cheaper-batched-matching) profiles it: the Hungarian loop plus row filling are 64-74% of dispatch's CPU live (50k-55k `1x1`, 100k `2x2`) and 87-95% in process (50k-100k). Yet each queued trip's augmenting path is short (2-4 steps on average), and, with queued ≤ idle, every path ends at a driver no earlier path matched, so each trip adds exactly one new driver to those any path has reached: almost all of the scanned drivers are never used.

In the solver, an idle driver no path has reached yet ("untouched") still has dual potential 0 and no trip. So, from a trip on the path, the cheapest untouched driver is its nearest untouched allowed idle driver: a nearest-driver query, which the idle driver index already answers exactly (ADR 0036/0048).

## Decision

We will make the batch solver work over touched drivers plus one nearest query per visited trip, instead of scanning every idle driver:

1. **Same objective and outputs** (ADR 0030): as many pairs as possible, least total pickup distance among those; drivers excluded for a trip not allowed; offers as today. Which of several optimal assignments comes back stays unspecified.
2. **Shortest augmenting paths with potentials, drivers materialized lazily**: when a path visits a trip, its costs to touched drivers are computed directly, and its untouched candidate is the nearest idle driver neither touched nor excluded for it (ties to the lowest ID, as `nearestIdle`). The candidate is cached per trip for the batch and re-queried only once that driver is touched (untouched drivers only shrink, so it stays the nearest). Reaching an untouched candidate ends the path, which touches it. A trip with no allowed untouched driver gets any untouched driver at the sentinel cost, as a disallowed pair today; sentinel = queued × (grid width + height − 2) + 1, more than any whole set of allowed pairs, so no sum over the matrix.
3. **When more trips are queued than drivers are idle**, keep today's dense solver on the transpose (rows = idle drivers, the small side).
4. **Exact, so no option and no mode**: it replaces the dense path whenever queued ≤ idle; `--matching batched` keeps its meaning. k-nearest pruning is not adopted.
5. **Module boundaries**: the solver stays in `src/dispatch/matching.ts` and doesn't import the index; dispatch passes the nearest query as a callback (a trip, a predicate for drivers to skip) and the index gains a variant of `nearestIdle` that takes the predicate and returns the driver's cell. The sorted idle list (`idleDriversById`) is built only for the dense case.

## Rationale

- Exact: the query returns the true minimum over all untouched drivers, so each path costs what the dense solver's would. Measured: same pair count and total distance as the dense solver on 3,000 random instances (heavy exclusions included) and on 660 in-process batches with both solvers on the same input (50k `1x1` and `2x2`, 100k `1x1`); every README `--compare` summary unchanged.
- It removes the work the profile shows instead of shaving it: a batch at 50k takes 5.3 ms instead of 215 (same CPU model, unprofiled), 96 instead of 2,402 at 100k. Spike, live: `1x1` 100k and 125k and `2x2` 150k pass twice each; 50k `1x1` settle p95 drops from 288-576 ms to 67-71 ms.
- No quality cost to measure or explain: it is exact matching.
- Each decision stays in one module: the solver owns the algorithm, the index owns spatial search.

## Alternatives considered

- **Each trip's k nearest idle drivers only** (the issue's starting idea): inexact unless k ≥ queued trips (a trip matched outside its queued-nearest drivers can always swap to a free one among them), which at 400-1,100 queued trips prunes little; smaller k changes outcomes and needs a quality trade-off. The exact solver already meets the targets.
- **Candidate bound k = queued + excluded per trip** (exact by the same swap): still fills up to queued² costs per batch; the lazy solver touches about one driver per trip.
- **Warm-started duals across windows**: trips and idle drivers change every window, and the cost is scanning drivers per step, not the number of steps.
- **Cheaper row filling** (typed arrays, tighter loop): at most its 12-20% share; each step stays O(idle drivers).
- **Splitting a batch into independent spatial subproblems**: needs a proof of independence and a second partition beside regions; the lazy solver already touches only nearby drivers.

## Consequences

- A batch's cost now follows how far idle drivers are from pickups, not how many there are: at 100k in process 14-357 ms, highest mid-run when most drivers are busy. Its terms: one nearest query per path step (fewer with the cache), plus each step's scan of the touched drivers, O(queued × steps) per batch since at most one driver per queued trip is touched. The nearest queries are the largest part of the solver (40% of dispatch at 100k, profiled; the rest of the solver 17%).
- Batched event logs may differ from master where several assignments are equally optimal (seen with `--preferences picky`); README outputs stay the same.
- The trips > idle case keeps the dense solver and its cost, cheap there because the idle side is small.
- Follow-up: implement (#241), then re-measure live limits per layout (#242).
