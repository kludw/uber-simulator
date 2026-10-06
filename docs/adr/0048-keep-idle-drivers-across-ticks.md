# 0048. Keep dispatch's idle drivers across ticks

- Status: Accepted
- Supersedes 0036's per-tick dispatch snapshot (the exact grid search, its ID tie-break and linear fallback are kept)
- Date: 2026-10-06

## Context

ADR 0036 has dispatch take one snapshot of idle drivers per tick: a busy set from every active trip, an idle list over every known driver, sorted by ID, then a grid index built from it. The [dispatch profile](../performance.md#dispatch-profile) (#221, greedy 200k, EPYC 7763) puts that rebuild at 30.3-31.4% of dispatch live (129-152 ms per tick) and 60.4-62.4% in process; the nearest search itself is 4.1-4.2% live. Nearly every driver moves every tick and only a few hundred change busy state, so most of each rebuild repeats the last one. ADR 0033 lets a brain update containers it owns in place.

## Decision

We will keep dispatch's drivers in its state across ticks, in one module (`src/dispatch/idle-drivers.ts`): known drivers' cells, the busy drivers, and the idle ones (known and not busy) in the grid buckets, updated in place:

- `placeDriver` on `driver.went_online` and each move of `drivers.moved` (a driver changes bucket only when its cell crosses one), `removeDriver` on `driver.went_offline`.
- `markBusy` / `markFree` from `storeTrip`, the one place trips change: a driver is busy from its offer until the offer is declined or expires or the trip ends. Dispatch offers only idle drivers, so a driver is busy for at most one trip; a second `markBusy` (or a `markFree` of an idle driver) is a bug and throws.
- `nearestIdle` returns the nearest idle driver not excluded, ties to the lowest ID, without taking it: greedy's offer makes it busy before the next trip searches. `idleDriversById` gives batched its columns, ordered by ID as before.

Outcomes stay byte-identical to master (event logs of the README commands, greedy and batched).

## Rationale

- Removes the per-tick O(active trips + known drivers) rebuild and sort, the largest part of dispatch's step; the per-move cost added to position updates is a map lookup and, rarely, a bucket swap.
- Busy marks follow trips through `storeTrip`, so there is one source of truth for "busy" and no second scan to drift from it.
- The search, its exactness argument and its tuning (ADR 0036, [Grid index tuning](../performance.md#grid-index-tuning)) are unchanged; only how the buckets are kept changes.

## Alternatives considered

- Keep only the busy set, rebuild the idle list and index per tick: removes about half the cost (the trip scan's `busy.add`), keeps the idle list, sort and index build.
- Keep the snapshot but update it from a per-tick diff of moves: same per-move work as updating in place, plus a diff to hold.

## Consequences

- Dispatch's state holds the bucketed drivers; tests that compare a state before and after `decide` must `structuredClone` it (ADR 0033).
- The busy invariant (one trip per driver) is now checked at run time: a violation throws instead of silently double-counting.
- Batched still sorts its idle drivers on each window tick; greedy no longer sorts.
