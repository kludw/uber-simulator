# 0030. Batched matching as a selectable dispatch strategy

- Status: Accepted
- Date: 2026-10-03

## Context

Dispatch matches greedily (ADR 0018): each tick, queued trips in FIFO order take the nearest idle driver. Greedy is myopic: an early trip can take the only driver close to a later trip while a slightly farther driver would have served both. The spec lists batched matching as the next experiment, to compare wait times. 100 drivers and ~10 requests/min keep each batch small (tens of trips and drivers at most).

## Decision

We will:

- Add a dispatch `matching` config: `{ type: "greedy" }` (default, unchanged) or `{ type: "batched", windowTicks }`.
- In batched mode, dispatch matches only on ticks where `tick % windowTicks === 0`. It collects queued trips without a pending offer and known-idle drivers without a pending offer or active trip, builds a cost matrix of Manhattan distance driver -> pickup (pairs where the driver is excluded for that trip are not allowed), and picks a maximum-cardinality assignment (as many trips as possible get an offer, like greedy), with minimum total distance among those. Each pair gets an offer exactly as today; offer replies, exclusions, and offer expiry (still checked every tick) are unchanged. Declined or expired trips wait for the next window.
- Solve it with the Hungarian algorithm (O(n³)) in a pure module `src/dispatch/matching.ts`. The rectangular matrix is padded to square; disallowed and padding cells get a finite sentinel cost larger than the sum of all real costs (not `Infinity`, which breaks the potentials), and sentinel pairs are dropped from the result. Input order is fixed (trips FIFO, drivers by ID) and no randomness is used, so the result is a pure function of the input; which of several equally optimal assignments is returned is not specified.
- Select the strategy per run: in-process runner and `bun run sim` (`--matching greedy|batched`, `--batch-window`), services via env, and `bun run sim -- --compare` running both strategies on the same seed and printing their summaries side by side.

## Rationale

- Minimum total pickup distance is the standard objective for batched ride matching and directly targets the metric we compare (ticks to pickup).
- Hungarian is exact and fast at these sizes; a greedy-over-pairs heuristic would blur the comparison.
- A strategy switch keeps greedy as the baseline and makes the comparison a single command on identical seeds (in-process runs are deterministic, ADR 0027).
- Keeping the offer protocol unchanged means drivers, riders, the UI, persistence, and the invariant checker need no changes.

## Alternatives considered

- Replace greedy with batched: loses the baseline the experiment needs.
- Greedy over all (trip, driver) pairs sorted by distance: simpler, not optimal.
- Min-cost flow or an LP solver library: more general than needed; a dependency for a small exact problem.
- A lexicographic tie-break (trip FIFO, then driver ID) among optimal assignments: needs a post-pass or huge weights; determinism doesn't require it.
- Note: `windowTicks: 1` (batch solver every tick) is allowed and isolates the objective's effect from the waiting effect.

## Consequences

- In batched mode, trips can wait up to `windowTicks - 1` extra ticks before an offer; whether total wait improves is what `--compare` shows. `--compare` runs in-process: rider demand is drawn per tick (`demand:<tick>` child streams), so both strategies see identical requests.
- Persisted runs don't record their strategy; comparisons use `bun run sim -- --compare` (out of scope: tagging runs in ClickHouse).
