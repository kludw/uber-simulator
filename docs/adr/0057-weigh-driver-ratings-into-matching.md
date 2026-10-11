# 0057. Weigh driver ratings into matching

- Status: Accepted
- Date: 2026-10-11

## Context

Milestone 32 ([#330](https://github.com/kludw/uber-simulator/issues/330)) adds driver ratings: riders rate their driver after a completed trip, drivers carry an average rating, and dispatch can prefer better-rated drivers among near-equal candidates. Like surge ([ADR 0054](0054-price-trips-with-zone-surge.md)) and pooling ([ADR 0056](0056-pool-two-riders-going-the-same-way.md)) it is a portfolio feature: rules that fit in a few sentences, off by default, outputs byte-identical when off.

Forces:

- Drivers in the simulation all drive the same way: one cell per tick, the same route rule. A rating made only of pickup wait and detour would rate dispatch and the map, not the driver, and preferring "better-rated" drivers would mean nothing. Something per driver has to differ.
- Brains are pure and seeded; a new random draw needs its own child stream so nothing else shifts (simulation skill). Riders see their own request, pickup and completion ticks; they don't see the driver's state.
- Greedy matching takes the nearest idle driver, ties to the lowest ID, through the idle driver index's ring search (ADR [0036](0036-scale-to-50k.md), [0048](0048-keep-idle-drivers-across-ticks.md), [0052](0052-driver-indexes-in-moves.md)); batched matching is exact, least total pickup distance, with the solver asking the index for each trip's nearest untouched driver ([ADR 0030](0030-batched-matching.md), [0051](0051-search-untouched-drivers-in-batched-matching.md)). Both are dispatch's hot path at 600k drivers.
- Each region's dispatch knows only drivers in its region; drivers cross borders ([ADR 0050](0050-split-dispatch-by-region.md)). A driver's rating must follow it.
- ADR 0056's spike found its off path 18-26% slower at 600k (per-trip maps, structures rebuilt per change); this design must cost nothing when off.

Spike on the unmerged branch [`331-exp-ratings`](https://github.com/kludw/uber-simulator/tree/331-exp-ratings) (`e967a04`): the rules below in process behind env knobs (`SPIKE_RATINGS=on SPIKE_WEIGHT=10`; knobs in `src/shared/rating.ts`), measured with `src/sim/rating-spike.ts` (one run, one JSON line, event-log SHA-256 included). With ratings off, the event logs of eleven scenarios (every README scenario below, pooling and surge included, and heavy batched with shifts and picky drivers) and of the 10k greedy run hash identical to master's (`d3c0699`). **Quality served**: the mean hidden driver quality (rule 1) over completed trips; **Bottom / Top**: the share of completed trips driven by the quarter of the fleet with the lowest / highest quality; **Stars**: mean stars of all ratings; **r**: correlation, over rated drivers, of their average rating with their quality. Off → on (ratings on with weight 0, i.e. no preference, gives exactly the off outcomes: rating changes nothing until dispatch uses it; its stars and r are shown).

README seeds, seed 42, 3,600 ticks, batch window 5 (spec: 10 req/min, 100 drivers; busy city: city, 20 req/min; heavy: city, 30 req/min, 50 drivers):

| Scenario, matching | Completed | Cancelled | Ticks to pickup | Quality served | Bottom | Top | Stars | r |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| spec, greedy | 477 → 474 | 19 → 20 | 61.1 → 61.9 | 4.325 → 4.365 | 19.9% → 16.7% | 28.3% → 29.7% | 4.20 → 4.22 | 0.74 → 0.75 |
| spec, batched | 474 → 475 | 21 → 22 | 62.0 → 59.4 | 4.341 → 4.353 | 18.8% → 17.7% | 28.9% → 29.5% | 4.22 → 4.24 | 0.82 → 0.82 |
| spec, pooling on, greedy | 483 → 484 | 12 → 11 | 61.0 → 60.8 | 4.342 → 4.356 | 18.2% → 17.4% | 27.5% → 30.0% | 4.10 → 4.10 | 0.78 → 0.76 |
| busy city, greedy | 558 → 558 | 488 → 493 | 107.1 → 113.6 | 4.340 → 4.340 | 18.8% → 19.0% | 28.7% → 29.0% | 3.92 → 3.86 | 0.78 → 0.77 |
| busy city, batched | 656 → 669 | 383 → 370 | 107.2 → 114.6 | 4.337 → 4.347 | 18.8% → 17.8% | 27.9% → 28.7% | 3.89 → 3.84 | 0.84 → 0.82 |
| heavy, greedy | 235 → 228 | 1,358 → 1,367 | 186.8 → 187.0 | 4.357 → 4.342 | 20.9% → 21.9% | 35.7% → 35.5% | 3.34 → 3.34 | 0.77 → 0.80 |
| heavy, batched | 421 → 421 | 1,160 → 1,160 | 124.2 → 124.2 | 4.354 → 4.354 | 20.2% → 20.2% | 36.6% → 36.6% | 3.77 → 3.77 | 0.85 → 0.85 |
| heavy 2x2, greedy | 277 → 277 | 1,316 → 1,317 | 184.7 → 184.5 | 4.377 → 4.377 | 18.8% → 18.8% | 38.3% → 38.3% | 3.32 → 3.32 | 0.80 → 0.79 |
| heavy, surge on, greedy | 229 → 220 | 991 → 1,013 | 174.5 → 172.6 | 4.356 → 4.377 | 21.0% → 18.6% | 37.1% → 38.6% | 3.37 → 3.33 | 0.75 → 0.77 |
| heavy, pooling on, greedy | 388 → 393 | 1,191 → 1,180 | 150.5 → 149.0 | 4.383 → 4.390 | 17.0% → 17.6% | 34.5% → 36.4% | 3.29 → 3.30 | 0.83 → 0.84 |

(Heavy with surge on: declined 400 → 394.) Heavy batched is unchanged here: with more trips queued than drivers idle every idle driver is matched, and a penalty that is the same for all of a driver's pairs leaves the optimal total unchanged (the solver may still pick another of several equal assignments, and an exclusion can leave a driver out).

10k drivers (2 × 5,000, 1,500 req/min, 1,800 ticks, city):

| Scenario | Completed | Cancelled | Ticks to pickup | Quality served | Bottom | Top | Stars | r |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| greedy | 32,764 → 32,666 | 2,931 → 3,073 | 68.2 → 68.6 | 4.258 → 4.271 | 24.3% → 23.4% | 25.7% → 26.7% | 4.01 → 4.01 | 0.70 → 0.70 |
| batched | 33,232 → 33,123 | 2,622 → 2,670 | 63.1 → 63.3 | 4.258 → 4.272 | 24.4% → 23.4% | 25.7% → 27.0% | 4.03 → 4.04 | 0.70 → 0.71 |
| greedy, surge on | 34,343 → 34,229 | 505 → 512 | 32.3 → 33.9 | 4.259 → 4.274 | 24.2% → 23.1% | 25.7% → 27.0% | 4.18 → 4.19 | 0.74 → 0.73 |

(Surge on at 10k: declined 2,003 → 2,152.)

Variants (weight in cells per star; spec greedy seed 42 / spec batched / 10k greedy unless noted):

- Weight 20: bottom 16.5% / 16.1% / 23.2%, ticks to pickup 63.3 / 61.6 / 69.7, 10k completed 32,581, cancelled 3,154; 10k surge on declined 2,384. Weight 30 (unrated at 4.5 here and below): 15.5% / 14.1%, 61.6 / 64.7 ticks. Weight 50: 14.8% / 12.8%, 69.8 / 67.4 ticks, spec batched completed 468 (−6). Spec greedy seed 1: weight 10 bottom 19.2% → 19.7%, weight 20 → 20.0%, weight 50 → 18.4% (noise is the size of the effect at 100 drivers).
- Unrated drivers at 4.5 instead of 5.0, or three pseudo-ratings at 4.5 added to every average: within noise of the plain average (spec greedy weight 10: bottom 18.0% and 17.2% against 16.7%).

With ratings on, two runs of one seed give one event log (heavy greedy). At 1% message loss (heavy greedy; heavy batched `2x2`; spec greedy): 234 / 424 / 471 completed, 230 / 414 / 458 ratings (a rider that missed its pickup or completion doesn't rate), no violation of today's invariants (the spike checks no rating invariant), 2 / 5 / 8 rejected inputs.

Cost, `bun run bench --drivers 600000 --ticks 300` (uniform, spec ratio, greedy, `1x1`), runs alternating with master's in one session:

- **Ratings off**: master 198.51 / 203.53 / 197.58 / 195.78 ms mean per tick, peak RSS 2,315 / 2,550 / 2,343 / 2,341 MiB; spike 196.71 / 204.04 / 197.02 / 204.72 ms, 2,375 / 2,273 / 2,379 / 2,491 MiB. Within noise: no rating, no array, today's search.
- **Ratings on**, weight 10: 175.12 / 181.31 ms, 2,627 / 2,331 MiB; about 47,500 trips rated by tick 300 (a few percent of drivers). The steady state, every driver already rated 3, 4 or 5 stars from the first rating on (`SPIKE_PREFILL=1`): weight 10 188.53 / 182.51 ms, weight 20 174.04 / 186.98 ms.
- **How the search got there**: the first rated search (a scored object per better candidate, rings only) cost weight 20 208.98 / 210.26 ms and, prefilled, 287.85 / 302.42 ms (+45-48%, p95 414-453 ms): a penalty of up to 80 cells widens the rings searched. The search measured above allocates nothing per candidate and skips any bucket whose nearest cell is farther than the best match cost found, then any driver farther than it, before reading its penalty. That makes it cheaper per search than today's distance-only search, which allocates per better candidate; today's search could take the same pruning, but not in this milestone (with ratings off it must stay today's code).
- **Batched**, `--drivers 150000 --matching batched` (ADR 0051's limit), one run each: master 57.62 ms mean (p95 207.93), spike off 45.98 (122.28), on prefilled weight 10 42.54 (96.89); 683 / 714 / 761 MiB.
- **Memory**: three fleet-sized `Int32Array`s per dispatch, 7.2 MB at 600k, only once a rating arrives.

## Decision

We will let each rider rate its driver 1-5 stars when its trip completes, from a hidden per-driver quality, its pickup wait and its detour, and let every dispatch keep each driver's average and add 10 cells of pickup distance per star below 5 when choosing a driver, in greedy and batched matching alike. Off by default.

1. **Rating model** (rider brain): with ratings on, a rider that rode (saw its `trip.picked_up`) and gets its `trip.completed` publishes `rider.rated_driver` with `stars = clamp(round(quality − wait penalty − detour penalty + noise), 1, 5)`:
   - **Driver quality**: how riders find a driver, uniform in [3.5, 5.0), drawn from the rider stream's child `quality:<driverId>`, the same for every rider (same label, same draw). It lives only in the rider service, never in a message: it is what ratings measure, hidden from dispatch.
   - **Wait penalty**: 1 star per 120 ticks from request to pickup beyond the first 60.
   - **Detour penalty**: 2 stars per 100% of detour, the rider's ticks from pickup to completion over its direct distance, minus 1 (pooling's 50% limit costs at most 1 star).
   - **Noise**: uniform in [−1, 1), from child `rating:<tripId>`.
   Surge doesn't enter: the rider agreed to the price, the driver didn't set it. The rider keeps its request tick, pickup tick and direct distance until then (three numbers per rider). No rating for cancelled trips or for a rider that missed its pickup event.
2. **Message `rider.rated_driver`** (event, `sim.events.rider.rated_driver`, no region: every dispatch takes every rating, like `zones.priced`): `{ tick, riderId, tripId, driverId, stars }`, stars an integer 1-5, published by the rider service in the same step as handling `trip.completed`.
3. **Where ratings live**: each dispatch keeps the fleet's ratings as a view rebuilt from events (as it keeps driver positions): per driver index, a rating sum and count and the derived penalty, three fleet-sized `Int32Array`s in the idle driver index, allocated on the first rating, so nothing exists with ratings off. A driver's **average rating** is sum / count; unrated drivers have none and no penalty. Every region's dispatch sees every rating, so a driver crossing a border keeps its rating; a dispatch that subscribes late (over NATS) misses earlier ratings and, unlike positions, they are not re-sent, so it prefers less for the rest of the run. A rating whose `driverId` is not a driver of the fleet (no driver index, or one at or beyond the fleet size) is rejected (`input_rejected`, like a `fleetSize` mismatch, ADR 0052), never dropped silently. Drivers don't know their rating (nothing they'd do with it), and the UI and summary build their own from events.
4. **Preference: rating penalty**: a driver's **rating penalty** is `round(10 × (5 − average))` cells (0 to 40; 0 unrated), recomputed when it is rated. Matching ranks idle drivers by **match cost** = pickup distance + rating penalty instead of pickup distance:
   - **Greedy**: each queued trip takes the idle driver with the least match cost, ties to the lowest ID. The ring search stays exact: penalties are never negative, so it stops at the first ring whose nearest cell is farther than the best match cost found (today: than the best distance), skips any bucket whose nearest cell is farther than it, and any driver farther than it before reading its penalty, keeping the best in locals (no object per candidate; the bench above is why). Without ratings it runs today's code.
   - **Batched**: least total match cost among the most pairs (ADR 0030's objective with match cost for distance). ADR 0051's solver stays exact: a trip's untouched candidate is the idle driver of least match cost (the same index query), still the cheapest until it is touched; the sentinel becomes trips × (width + height − 2 + 40) + 1 when any driver is rated. The dense path (more trips than idle drivers) adds each driver's penalty to its column; when every idle driver is matched, that leaves the optimal total unchanged, though the solver may return another of several equal assignments (heavy batched, above).
   "Near-equal" is the weight: a driver one star better wins against one up to 10 cells (100 m, 10 ticks) nearer. Pooling's joins are unchanged (the partner's driver is already chosen; see Consequences for #361's join rule); pricing, chasing, preferences and shifts are unchanged.
5. **Invariants** (spec, checker): a `rider.rated_driver` names a completed trip, that trip's rider and driver, comes after its `trip.completed`, and is the trip's only rating (`invalid_rating` for the first three, `duplicate_rating`). The checker already keeps every trip; it adds a rated flag.
6. **Switch and outputs**: `--ratings on|off` for `bun run sim` and `bun run bench`, `RATINGS` for `bun run dev` (riders only: dispatch acts on the ratings it sees, so like pooling it needs no switch), `SimConfig.ratings`; `bun run sim -- --compare-ratings` runs ratings off and on side by side. With ratings on the summary adds `ratings: <n>` and `mean stars: <x.xx>`. The weight is a constant (`ratingWeight` in `src/shared/rating.ts`), not a flag. Off: no draw, no event, no arrays; every output and event log byte-identical.
7. **Persistence**: no new ClickHouse column or migration: the rating lives in the payload, as fares and `pooled` do. `bun run report` adds `ratings: <n>` and `mean stars: <x.xx>` when any `rider.rated_driver` is stored. Replay republishes it unchanged.
8. **UI**: the panel adds ratings and mean stars once any rating arrives. Dots and heatmap unchanged.

Out of scope, deliberately: drivers deactivated or paid by rating, drivers rating riders, drivers seeing or acting on their rating, riders choosing or refusing a driver by rating, ratings that decay or count only recent trips, tips, ratings for cancelled trips, rating-aware pooling joins, a per-driver rating in the UI.

## Rationale

- **A hidden quality makes the preference mean something**: without a per-driver difference, ratings would only score dispatch (wait) and the map (detour). One uniform draw per driver, owned by the rider service as riders' shared opinion, is the least model that gives ratings a signal: averages track it (r 0.70-0.85) while wait and detour still move stars (heavy load: 3.3 stars against 4.2 at spec load).
- **The rider rates, dispatch keeps the average**: the rider has the facts (its wait, its ride) and the opinion; dispatch is the one that acts on the average, and keeping it as a view by driver index costs three array writes per rating and one array read per candidate. Making drivers own their rating would need it on `drivers.moved` (the hot path) or a lookup dispatch can't do.
- **A penalty in cells, not a tie-break or a filter**: one cost serves both strategies and keeps both exact (greedy's ring search and ADR 0051's untouched candidate rely only on costs being non-negative integers fixed during a search). A pure tie-break among drivers at equal distance would almost never fire; a window ("within N cells of the nearest") needs a second pass in greedy and has no batched form.
- **Weight 10**: most of the shift at the least cost. At spec load it moves 1-3 points of trips away from the worst quarter of drivers (spec greedy 19.9% → 16.7%) for under a tick of wait; 20 adds little more (16.5%) at twice the wait (+2.2 ticks), 50 costs completions. At 10k it costs 0.3% of completions and 5% more cancellations; 20 costs 0.6% and 8%. Under overload it does nothing, by design: every idle driver is taken anyway.
- **The effect is small, and the docs say so**: dispatch can only choose among drivers that are near, and at 1-5 trips per driver an average is mostly noise (r 0.70 at 10k). The `--compare-ratings` table shows both sides: a little better drivers, a little longer waits.
- **No prior**: a new driver unrated (no penalty) is the plainest rule; priors measured within noise.

## Alternatives considered

- **Ratings from wait and detour only**: no per-driver signal; preference would favour drivers who happened to get easy trips. Rejected.
- **Quality owned by the driver shard** (drawn there, reported on arrival or completion): truer ownership, but a field on driver messages that only riders read, and drivers would carry a number they never act on. Rejected for the rider-side draw.
- **Drivers keep their own average** and report it (on `drivers.moved` or a new message): hot-path bytes for every move, or another message per driver; dispatch can build it from ratings. Rejected.
- **A rating service**: one more process to own an average two consumers rebuild in one line each. Rejected.
- **Tie-break only among equally near drivers**, or **a window of N cells**: the first rarely fires, the second needs a second greedy pass and has no exact batched form. Rejected for the penalty.
- **Multiplicative cost** (distance × factor): a far driver's penalty grows with distance, and zero-distance drivers ignore ratings. Rejected.
- **Bayesian prior or recent-trips window**: measured within noise; more words. Rejected for now.

## Consequences

- **Messages**: one new event, `rider.rated_driver`, one per completed trip with ratings on, on an unregioned subject every dispatch takes.
- **Dispatch**: the idle driver index gains ratings by driver index and a match-cost search beside today's; the batched solver takes match costs. Without any rating, today's code runs unchanged.
- **Determinism**: ratings draw from `quality:<driverId>` and `rating:<tripId>` children of the rider stream, labels independent of order; nothing else shifts. A rating published in the rider's `trip.completed` step reaches dispatch in the same tick on the in-process bus (publish order) but can arrive a tick or more later over NATS, so with ratings on greedy's next offer for that driver can differ between the buses. Harmless, but a bus-dependent outcome: determinism tests compare runs on one bus only, never across buses.
- **Pooling joins and #361**: [#361](https://github.com/kludw/uber-simulator/pull/361) (ADR 0058, in progress) lets a pooled trip join only when the join beats the nearest idle driver. With ratings on, the index's matching query returns the driver of least match cost, but the join rule's reference stays the nearest idle driver by pickup distance, compared by pickup ETA / distance, never by match cost: ratings don't change pooling joins. Whichever of #332c and #361's implementation lands second must keep that (a distance-only nearest query for the join comparison), and the ratings-on `--compare-pooling` numbers are measured then.
- **Regions**: every dispatch keeps the whole fleet's ratings (12 bytes per driver: 7.2 MB at 600k, per dispatch, only with ratings on).
- **Performance**: with ratings off nothing changes (bench above); with ratings on the rated search must stay at or below today's cost, which the slicing gates.
- **Docs**: spec (trip lifecycle step 5, invariants, milestone 32), README `--compare-ratings` table, architecture (rating view in dispatch), domain skill (Ratings section), UI doc.
- **Risks**: the effect is small and noisy at README sizes, so the comparison may read as "ratings do nothing"; the summary can't show hidden quality, so the README links this ADR's quality-served and bottom-quarter numbers next to its table. A rider can't rate a trip whose `trip.picked_up` it missed (message loss): fewer ratings, never a wrong one.

Domain terms (domain skill, in this change): **Rating**, **Stars**, **Driver quality**, **Average rating**, **Rating penalty**, **Match cost**.

Implementation slicing (each PR keeps ratings-off outputs and event logs byte-identical to master on the README seeds and names its tests). #332b, #332c and #332d also gate on cost: `bun run bench --drivers 600000 --ticks 300` with ratings off, two runs each alternating with master, mean ms per tick and peak RSS within run-to-run noise of master's. Ratings on is gated where the search lands: #332c (greedy, 600k) and #332d (`--matching batched --drivers 150000`) bench with every driver rated 3, 4 or 5 stars once before tick 1 (a bench-only pre-rating, as `SPIKE_PREFILL` did; the PR picks the mechanism), two runs each against ratings off, at or below its cost within noise; #332f repeats both with `--ratings on`.

1. **Ratings vocabulary** (#332a): `src/shared/rating.ts` (`driverQuality`, `starsOf`, `ratingPenaltyOf`, `ratingWeight`), `rider.rated_driver` schema and subject. Tests: stars (no penalty within 60 ticks of wait, one star per 120 beyond, detour 50% = 1 star, rounding, clamps at 1 and 5), quality range and sameness per driver ID, penalty (unrated 0, 4.0 → 10, 1.0 → 40, rounding), schema rejects stars 0, 6 and 2.5, subject. No behavior change.
2. **Riders rate drivers** (#332b): riders keep request tick, pickup tick and direct distance; `ratings` start config; `rider.rated_driver` on completion. Tests: rider brain (rating on completion with literal stars for a fixed seed, none when off, none when cancelled or not riding, same stars whatever order trips complete in, determinism). Nothing turns it on yet.
3. **Dispatch weighs ratings in greedy** (#332c): dispatch takes `rider.rated_driver`; the index keeps sum, count and penalty by driver index from the first rating and searches by match cost. Tests: idle-drivers (match-cost search equals a linear scan over random fleets with random ratings, ties to the lowest ID, unrated drivers no penalty, no arrays before a rating, a rating for a driver outside the region kept), dispatch brain (a better-rated driver up to 10 cells farther wins, beyond that the nearer one, rating from another region's driver used after it crosses, a rating naming no fleet driver rejected as `input_rejected`); the bench gates (off and pre-rated).
4. **Batched with ratings** (#332d): match costs in `minCostMatchingByNearest` (sentinel with the penalty bound) and the dense path. Tests: matching (by-nearest equals the dense solver's total on random instances with penalties; with every driver matched, per-driver penalties leave the pair count and the total distance unchanged, asserted on count and total, not on the pairs), dispatch batched picks the better-rated pair; the bench gates (off and pre-rated).
5. **Rating invariants** (#332e): `invalid_rating`, `duplicate_rating`; spec invariants. Tests: invariant checker cases (before completion, wrong driver, wrong rider, unknown trip, twice).
6. **Switch ratings on** (#332f): `SimConfig.ratings`, `--ratings` (sim, bench), `RATINGS` (dev), `--compare-ratings`, summary and `bun run report` lines. Tests: args and config, summary, report query, system tests in process (invariants, determinism, 1% loss) and over NATS (invariants); the ratings-on bench gate. Docs: README table (numbers match this spike), spec, architecture.
7. **Show ratings** (#333a): UI panel lines, `RATINGS=on bun run demo`. Tests: view and panel pure seams; screenshot. Docs: README demo, `docs/ui.md`.
8. **Live check** (#333b): live greedy `1x1` 600k with ratings on, two runs, against milestone 31's; `docs/performance.md`; spec milestone 32 done.
