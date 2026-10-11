# 0058. Join a pool only when it beats the nearest idle driver

- Status: Accepted
- Date: 2026-10-11
- Supersedes: [0056](0056-pool-two-riders-going-the-same-way.md) rule 4's "a pooled trip joins even when an idle driver is nearer" and its open pooled trip count, and rule 2's partner tie-break

## Context

The live check of pooling ([#352](https://github.com/kludw/uber-simulator/issues/352), [PR #360](https://github.com/kludw/uber-simulator/pull/360), `docs/performance-history.md` "After milestone 31") failed: greedy `1x1` 600k, surge on, pooling on misses settle in 4 of 4 runs (p95 622-659 ms against 523-525 ms at milestone 30 on the same CPU model), dispatch uses 0.34-0.36 cores against 0.29, and riders lose: mean request → pickup 21.6 ticks against 6.7 off, completed per tick −12.6%. Two causes, both from [ADR 0056](0056-pool-two-riders-going-the-same-way.md) rule 4:

- **Cost**: on every matching tick with a pooled trip open, dispatch built the tick's partners in one pass over all its open trips (`openPool`), O(open trips) per tick, about 300k at 600k drivers.
- **Riders**: a pooled trip joined before the nearest idle driver was tried, at a join ETA up to 120 ticks. Where idle drivers are everywhere (600k at spec ratio: an idle driver ~7 ticks away), a join 60-120 ticks away replaced a pickup a few ticks away.

Spike on the unmerged branch [`361-exp-pool-cost`](https://github.com/kludw/uber-simulator/tree/361-exp-pool-cost) (`812e1d4`): the rule below behind `SPIKE_JOIN_MARGIN=<n>` (join ETA at most the nearest idle driver's distance + n; unset: ADR 0056's cap only), partners in buckets of the idle driver index instead of the per-tick pass. With pooling off, the event logs of the six scenarios of ADR 0056's spike (plus 1% loss) hash identical to master's.

Profile (`bun --cpu-prof-md`, 600k, 600 ticks, surge on, greedy, M1 Pro): on master, pooling on spends 12.5 s of 137 s in `openPool` alone; dispatch's self time is 35.9 s on against 25.1 s off. Dispatch alone, timed around `decideDispatch` per tick (scratch instrumentation, one run each):

| 600k, 600 ticks, surge on | Pooling off: mean / p95 ms | Pooling on: mean / p95 ms |
| --- | --- | --- |
| master (`d3c0699`) | 45.15 / 58.70 | 61.40 / 84.37 |
| spike, margin 0 | 42.03 / 51.95 | 46.40 / 54.82 |

Whole in-process bench (`bun run bench --drivers 600000 --ticks 300`, surge off, two rounds alternating; dispatch is about a fifth of it, so this mostly shows noise): master off 196.85 / 197.27 ms mean (p95 230.81 / 227.38), on 193.03 / 184.70 (217.28 / 207.01); spike off 197.23 / 191.21 (229.91 / 231.84), on 197.69 / 208.47 (224.25 / 233.89). Peak RSS 2,229-2,362 MiB master, 2,530-2,690 MiB spike; at 600 ticks (the dispatch timing runs) master 3,066 off / 3,372 on, spike 3,582 off / 3,354 on, and other 600-tick runs of each tree spread 3,213-3,784 MiB, so RSS differences here are within run-to-run noise (the spike adds three fields per known driver and one empty bucket set, a few MiB).

Rider outcomes, `bun run sim -- --compare-pooling` (each cell pooling off → on):

| Scenario | Rule | Completed | Cancelled | Shared | Ticks to pickup | Ride |
| --- | --- | --- | --- | --- | --- | --- |
| 600k, 600 ticks, surge on, seed 1 | 0056 | 260,938 → 228,328 | 0 → 10 | 95,977 | 6.7 → 21.4 | 239.4 → 234.9 |
| | margin 0 | 260,938 → 260,139 | 0 → 0 | 72,313 | 6.7 → 3.5 | 239.4 → 237.2 |
| | margin 10 | 260,938 → 248,475 | 0 → 0 | 115,210 | 6.7 → 5.8 | 239.4 → 235.8 |
| 10k city, greedy | 0056 | 32,764 → 34,185 | 2,931 → 604 | 16,933 | 68.2 → 57.4 | 290.2 → 315.4 |
| | margin 0 | 32,764 → 34,527 | 2,931 → 572 | 15,281 | 68.2 → 48.8 | 290.2 → 307.4 |
| | margin 10 | 32,764 → 34,362 | 2,931 → 581 | 16,674 | 68.2 → 50.1 | 290.2 → 310.8 |
| | margin 30 | 32,764 → 34,244 | 2,931 → 604 | 17,012 | 68.2 → 53.0 | 290.2 → 313.8 |
| 10k city, batched | 0056 | 33,232 → 34,211 | 2,622 → 605 | 16,930 | 63.1 → 56.2 | 290.4 → 315.4 |
| | margin 0 | 33,232 → 34,859 | 2,622 → 635 | 15,158 | 63.1 → 43.1 | 290.4 → 304.8 |
| 10k city, greedy, surge on | 0056 | 34,343 → 34,860 | 505 → 0 | 17,040 | 32.3 → 30.4 | 290.0 → 316.7 |
| | margin 0 | 34,343 → 35,404 | 505 → 15 | 14,032 | 32.3 → 18.7 | 290.0 → 304.3 |

README seeds (3,600 ticks, the ADR 0056 table's scenarios), completed pooling on, 0056 → margin 0 (margin 10 / 30): spec greedy 483 → 483 (480 / 481), spec batched 484 → 479 (482 / 476), spec city greedy 483 → 485, batched 483 → 486, busy city greedy 693 → 700 (727 / 715), batched 764 → 751 (755 / 751), heavy greedy 388 → 382 (388 / 388), heavy batched 504 → 500 (508 / 498), heavy `2x2` greedy 375 → 375, batched 479 → 479, heavy greedy surge on 355 → 366, heavy greedy shifts + picky 357 → 338 (338 / 339). No invariant violation in any run. At spec load fewer trips are shared (176 → 102 greedy), since an idle driver is usually nearer; ticks to pickup fall (61.0 → 57.3). Under overload there is rarely an idle driver, so the 120 cap rules as before. (0056's rows here use the new partner tie-break (rule 4); they match the README table except busy city batched, 743 → 764, and 10k, within 20 trips.)

## Decision

We will join a pooled trip to a partner only when the join is no farther than the nearest idle driver, and find partners through the idle driver index instead of a pass over all trips.

1. **Join reach**: a queued pooled trip joins a partner only if its join ETA is at most the **join reach**: the nearest idle driver's pickup distance (Manhattan, dispatch's view, drivers not excluded for the trip), capped at 120; 120 when no idle driver is left. Equal counts as beating it: a join saves a driver. ADR 0056's other join conditions (detour limit, capacity, same region, driver online, not excluded) are unchanged. Greedy: each queued pooled trip in FIFO order looks up its nearest idle driver, then the partner with the least join ETA within the reach; it joins that partner, else takes that idle driver. Batched: the join passes stay before and after batched matching on window ticks, each trip's reach taken from the idle drivers left at that moment (before: all; after: those batched matching left).
2. **Distance, not match cost**: the reference is the nearest idle driver by pickup distance, never a rating-weighted match cost ([ADR 0057](0057-weigh-driver-ratings-into-matching.md)); whichever of ratings and this lands second keeps a distance-only nearest query for the join reach.
3. **Partner index**: the idle driver index keeps **joinable** drivers (busy, holding one pooled trip alone, online) in its own buckets, moved as drivers move. Dispatch keeps, per joinable driver, its partner trip, and per driver holding two trips, both; it marks a driver joinable or not as trips are held and released. A search visits square rings of buckets around the joining pickup and stops once nothing farther out can have a join ETA within the reach or as low as the best found (a join ETA is never below the driver's distance to the pickup). Nothing is built per tick, and there is no open pooled trip count: with no joinable driver the search finds nothing at once.
4. **Ties**: among partners with the least join ETA, the lowest driver ID (ordered by ID, as for idle drivers), replacing "the partner requested earlier", which needed each trip's place in request order.

## Rationale

- **Margin 0 over 10 or 30**: the plainest rule ("join when no idle driver is nearer") and the best at scale: 600k completes within 0.3% of pooling off with ticks to pickup halved (6.7 → 3.5), where margin 10 loses 4.8% of completions; at 10k it completes the most (+5.4% greedy, +4.9% batched against +4.3% / +2.9% under 0056). README overload gains stay (heavy greedy +147 against +153, batched +79 against +83); margin 10 keeps a few more there, not enough to pay for the 600k loss.
- **Why the 600k loss happened**: a join adds a stop to a driver who still has to pass its partner's pickup; with idle drivers 7 ticks from every pickup, each join slowed two riders to save one driver nobody was short of. The reach makes that trade only where a driver is scarce.
- **An index, not a cheaper pass**: any per-tick pass is O(partners), a few hundred thousand at 600k; the index costs one bucket check per joinable driver's move, which dispatch already reads, and a search proportional to the pooled trips queued. Dispatch per tick at 600k: 46.40 ms mean on against 42.03 off (+10%), where master was +36% (p95 +6% against +44%).
- **Ties by driver ID**: the index has no request order; driver ID order is what every other tie in dispatch uses.

## Alternatives considered

- **Keep ADR 0056's rule, index only**: fixes the cost, keeps the rider loss at 600k (21.4 ticks to pickup, −12.5% completed). Rejected.
- **A margin over the nearest idle driver (10, 30 ticks)**: measured above; worse at 600k, within noise elsewhere. Rejected.
- **Join only before the first rider's pickup**: ADR 0056 measured half the overload effect. Not revisited.
- **Keep the per-tick pass over partners only** (an incremental partner list): still O(partners) per tick, plus a scan of every partner per queued pooled trip. Rejected.
- **Compare by rating-weighted match cost**: ratings would change pooling; decided against with ADR 0057.

## Consequences

- With pooling off nothing changes: no trip is pooled, no driver is joinable, outputs and event logs byte-identical to master.
- README and `--compare-pooling` numbers change (spec load shares fewer trips; 10k and 600k complete more); the README table records them.
- Dispatch looks up the nearest idle driver once more per pooled queued trip in batched's join passes.
- The idle driver index grows a second bucket set and three fields per known driver; `busyDriverCell` goes.
- #352 re-runs the live greedy `1x1` 600k check with pooling on.

Domain terms (domain skill): **Join reach**; **Join** and **Join ETA** updated.

Implementation: one PR ([#361](https://github.com/kludw/uber-simulator/issues/361)): `joinReachOf` and the reach in `joinEtaOf` (`src/shared/pool.ts`), joinable drivers and `bestPartner` in the idle driver index, dispatch's partners and joins. Tests: pool unit tests (reach with and without an idle driver, cap), the index's partner search against a linear scan on random sequences, dispatch brain (a nearer idle driver wins, an equally near join wins, no idle driver: cap 120, excluded idle drivers don't set the reach, ties to the lower driver ID, batched passes); event-log hashes and README outputs with pooling off identical to master; the 600k bench and dispatch timing above.
