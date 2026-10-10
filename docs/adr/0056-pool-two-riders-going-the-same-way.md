# 0056. Pool two riders going the same way

- Status: Accepted
- Date: 2026-10-11

## Context

Milestone 31 ([#326](https://github.com/kludw/uber-simulator/issues/326)) adds ride pooling: riders going roughly the same way share one driver. Like surge ([ADR 0054](0054-price-trips-with-zone-surge.md), [0055](0055-idle-drivers-chase-surge.md)) it is a portfolio feature: rules that fit in a few sentences, off by default, outputs byte-identical when off.

Forces:

- A trip is one rider's (domain skill); dispatch owns every trip transition and offers a trip to one driver at a time ([ADR 0018](0018-dispatch-matching-via-offers.md)); a driver holds one trip, and its states (`en_route` → `at_pickup` → `on_trip` → `at_dropoff`) are that trip's. The invariant checker reports a driver with two active trips (`driver_has_two_active_trips`).
- Matching is greedy or batched ([ADR 0030](0030-batched-matching.md), [0051](0051-search-untouched-drivers-in-batched-matching.md)), within one region's dispatch ([ADR 0050](0050-split-dispatch-by-region.md)).
- Waiting drivers confirm their trip with dispatch per stage ([ADR 0041](0041-confirm-trip-while-waiting.md)); messages can be lost.
- Fares are fixed at request, `(250 + 2 × distance) × surge` cents (ADR 0054).
- Brains are pure and seeded; a new random draw needs its own child stream so nothing else shifts (simulation skill).
- Riders cancel after 120-300 ticks of patience; at the README's spec load an idle driver is usually 30-60 cells from a pickup.

Spike on the unmerged branch [`327-exp-pooling`](https://github.com/kludw/uber-simulator/tree/327-exp-pooling) (`71d5948`): the rule below in process behind env knobs (`SPIKE_POOL=on SPIKE_POOL_JOIN=aboard SPIKE_POOL_ETA=120`, defaults share 0.5, detour 50%, fare × 0.75), measured with `src/sim/pool-spike.ts` (one run, one JSON line; event-log SHA-256 included). The driver brain was rewritten to a list of stops for it, and with pooling off the event logs of six scenarios (spec greedy and batched; heavy greedy and batched; heavy `2x2` with surge on; heavy batched with shifts and picky drivers) hash identical to master's, as do the 10k numbers below against ADR 0055's surge-off reference. Each cell: pooling off → on. **Shared**: completed trips that had another trip on their driver; **Ride**: mean ticks from pickup to completion; **Detour**: shared trips' mean ride over their direct distance, minus 1; **Occupied**: share of driver-ticks with a rider aboard.

README seeds, 3,600 ticks, batch window 5 (spec: 10 req/min, 100 drivers; busy city: city, 20 req/min; heavy: city, 30 req/min, 50 drivers):

| Scenario, matching | Completed | Cancelled | Shared | Ticks to pickup | Ride | Detour | Occupied | Revenue |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| spec, greedy | 477 → 480 | 19 → 13 | 176 | 61.1 → 63.2 | 328.0 → 355.2 | 19.4% | 47.4% → 45.6% | $4,321 → $3,806 |
| spec, batched | 474 → 478 | 21 → 15 | 171 | 62.0 → 63.5 | 325.9 → 357.5 | 20.7% | 46.8% → 45.3% | $4,275 → $3,801 |
| spec city, greedy | 485 → 484 | 20 → 16 | 175 | 64.9 → 61.9 | 307.8 → 330.5 | 15.0% | 44.1% → 41.6% | $4,198 → $3,683 |
| spec city, batched | 480 → 483 | 21 → 18 | 188 | 63.8 → 61.9 | 305.0 → 333.8 | 16.4% | 43.8% → 41.8% | $4,128 → $3,676 |
| busy city, greedy | 558 → 710 | 488 → 325 | 354 | 107.1 → 93.6 | 292.9 → 335.0 | 19.2% | 48.1% → 57.9% | $4,664 → $5,131 |
| busy city, batched | 656 → 750 | 383 → 269 | 370 | 107.2 → 97.5 | 295.4 → 334.7 | 18.3% | 57.5% → 62.1% | $5,515 → $5,478 |
| heavy, greedy | 235 → 401 | 1,358 → 1,168 | 316 | 186.8 → 147.0 | 261.9 → 363.7 | 23.8% | 35.8% → 62.6% | $1,818 → $2,659 |
| heavy, batched | 421 → 506 | 1,160 → 1,054 | 344 | 124.2 → 126.9 | 308.8 → 361.4 | 23.3% | 76.2% → 83.5% | $3,653 → $3,530 |
| heavy 2x2, greedy | 277 → 376 | 1,316 → 1,207 | 240 | 184.7 → 158.6 | 282.0 → 342.5 | 18.2% | 45.1% → 58.7% | $2,255 → $2,646 |
| heavy 2x2, batched | 424 → 490 | 1,154 → 1,081 | 273 | 118.2 → 124.3 | 300.5 → 345.0 | 16.9% | 75.4% → 80.5% | $3,608 → $3,636 |

Heavy greedy on other seeds: seed 1 233 → 411 completed, seed 2 242 → 408; spec greedy seed 1: 485 → 494, cancelled 21 → 6. With surge on (heavy greedy): 229 → 369 completed, 991 → 843 cancelled, 400 → 387 declined, $2,480 → $3,171. Shifts and picky drivers (heavy greedy): 267 → 349. At 1% message loss (heavy greedy; heavy batched `2x2`): 402 and 484 completed, no invariant violation, 2 and 5 rejected inputs (master at 1% loss: 4). Two runs of one seed give one event log.

10k drivers (2 × 5,000, 1,500 req/min, 1,800 ticks, city):

| Scenario | Completed | Cancelled | Shared | Ticks to pickup | Ride | Detour | Occupied | Revenue |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| greedy | 32,764 → 34,026 | 2,931 → 612 | 16,786 | 68.2 → 56.6 | 290.2 → 317.1 | 18.7% | 60.4% → 56.2% | $272,062 → $245,225 |
| batched | 33,232 → 34,048 | 2,622 → 596 | 16,764 | 63.1 → 56.0 | 290.4 → 316.7 | 18.5% | 61.3% → 56.2% | $276,086 → $245,501 |
| greedy, surge on | 34,343 → 34,728 | 505 → 36 | 16,897 | 32.3 → 30.5 | 290.0 → 319.0 | 19.1% | 62.9% → 57.4% | $297,288 → $255,883 |

Variants (completed, heavy greedy / heavy batched unless noted):

- Join only before the first rider's pickup: 301 / 467 (detour 12% / 11%); 10k greedy 34,238 completed, 738 cancelled, 63.4 ticks to pickup.
- No join ETA cap: spec greedy 432 completed, 70 cancelled (before-pickup joins: a pooled rider waits for a driver still far from the first pickup); heavy greedy, joins while aboard, 355.
- Join ETA cap 90: 405 (greedy); 180 (before pickup only): 296 against 301 at 120.
- Detour 30%: 386 / 486, detour 13% / 13%; spec unchanged (479 / 484). Detour 100% (before pickup only): 293 against 301.
- Join only within 0-60 ticks of the nearest idle driver's pickup distance, instead of a cap: spec 478-481, heavy (before pickup, 30) 274 against 301.
- Every rider pooled (share 1.0): heavy greedy 550 completed, 999 cancelled, detour 25.7%; spec greedy 482, 4 cancelled, revenue $3,227.

Cost, `bun run bench --drivers 100000 --ticks 300` (uniform, spec ratio, pooling as in the table): mean 25.94 → 25.92 ms per tick, p95 33.13 → 32.92 ms, peak RSS 547.8 → 537.6 MiB; at 600k mean 216.93 → 206.07 ms, p95 274.07 → 251.99 ms, peak RSS 2,543 → 2,609 MiB (+2.6%). One run each: within run-to-run noise.

## Decision

We will let a rider opt in to pooling and let dispatch give its trip to a driver already carrying, or heading to, another pooled rider when both rides stay within 1.5 × their direct distance and the driver reaches the new pickup within 2 minutes. A driver carries at most two trips. Off by default.

1. **Opt-in**: with pooling on, each spawned rider pools with probability 0.5 (the **pool share**), one draw per spawned rider from the child stream `pool:<tick>`, taken only with pooling on. Its `request_trip`, its `trip.requested` and every `offer` of its trip carry `pooled: true` (absent otherwise). Riders behave as today otherwise: same patience, same surge quote and decline.
2. **Who can share**: a queued pooled trip B may **join** a pooled trip A (its **partner**) of the same dispatch (so the same region) when A holds its driver alone (A offered, matched or picked up, no second trip on that driver) and that driver is not excluded for B, and:
   - **Detour limit**: along the shared route each rider rides at most 1.5 × its direct distance (A counted from its pickup, including what it already rode: its driver's distance from A's pickup).
   - **Join ETA**: the driver's cell in dispatch's view, to A's pickup if A is not picked up yet, then to B's pickup, at most 120 ticks (the least patience).
   - **Route**: A's pickup (if still ahead), B's pickup, then both dropoffs in the order with the shorter remaining route from B's pickup, ties to A's first. A driver already waiting at A's dropoff goes on to B's pickup and dropoff after it.
   Among partners, the least join ETA; ties to the partner earlier in dispatch's trip order (request order). No direction rule beyond the detour limit: a rider going the other way fails it.
3. **Capacity**: two trips per driver, counting a pending offer: a driver with two trips is offered nothing more. Once one is dropped off, cancelled, expired or released, the other is a partner again (pools chain).
4. **Matching**: greedy: each tick, each queued trip in FIFO order; a pooled trip first joins its best partner, else takes the nearest idle driver as today. Batched (window ticks only): a join pass over the queued pooled trips in FIFO order, then batched matching of the rest as today, then a join pass for the pooled trips it left without a driver (partners include trips just offered). A pooled trip joins even when an idle driver is nearer: saving a driver is the point, and the join ETA bounds the wait. No work when no trip is pooled.
5. **Driver lifecycle**: a driver keeps its trips' remaining **stops** in order (one trip: pickup, dropoff; a pool: pickup, pickup, dropoff, dropoff in the route's order). Its state follows its current stop: `en_route` / `at_pickup` for a pickup, `on_trip` / `at_dropoff` for a dropoff; idle when no stop is left. A busy driver accepts an offer iff the offer is pooled, the driver holds exactly one trip, that trip is pooled, and the offer's region is its trip's; no preference draw for a join. Arrivals, `trip.picked_up` and `trip.completed` are per stop; `trip.cancelled`, `trip.offer_expired` and `trip_status` `released` drop that trip's stops and the driver goes on with the rest. Each trip keeps today's states and transitions; dispatch's per-trip rules do not change.
6. **Recovery** (ADR 0041): a driver waiting at a stop confirms that stop's trip and stage every 10 ticks, as today; `picked_up` / `completed` move it to its next stop, `released` drops the trip's stops. Dispatch answers per trip, unchanged. A busy driver declining a join carries `idleAt: null` and dispatch handles it as today (it may forget the driver until its next move, ADR 0043).
7. **Fare**: a pooled trip's fare is `round((250 + 2 × distance) × surge × 0.75)` (the **pooled fare**, 25% off), fixed at request, whether or not anyone joins. Surge pricing counts pooled trips like any other; riders decide on the quote as today. With surge off messages still carry no fare; the summary counts a pooled trip at the pooled base fare.
8. **Invariants** (spec, checker): a driver has at most two active trips, and two only when both are pooled (`driver_has_two_active_trips` for a second trip when either is not pooled, `driver_over_capacity` for a third). "Each rider picked up before dropped off" is already checked per trip (legal transitions; completed trips were picked up). Arrivals stay checked against each trip's cells.
9. **Switch and outputs**: `--pooling on|off` for `bun run sim` and `bun run bench`, `POOLING` for `bun run dev` (riders only: dispatch and drivers act on `pooled` fields, so they need no switch), `SimConfig.pooling`; `bun run sim -- --compare-pooling` runs pooling off and on side by side. With pooling on the summary also prints trips pooled, trips shared, mean ticks from pickup to completion and revenue. Off: no draw, no field, every output and event log byte-identical.
10. **Persistence**: no new ClickHouse column or migration: `pooled` lives in the payload, as fares do (ADR 0054). `bun run report` adds trips pooled when any; its revenue sums event fares as today. Replay republishes payloads unchanged.
11. **UI**: the view keeps each driver's trips: a driver is idle only when its last trip ends, its state follows its latest trip event otherwise. Dots mode draws a ring around a driver carrying two riders; both trips' lines show. The panel adds trips pooled and trips shared once any trip is pooled. Heatmap unchanged.

Out of scope, deliberately: more than two riders, joins across regions, re-ordering stops beyond the dropoff choice, a rider's own detour tolerance, a discount only when shared, pooled patience or prices, walking to a meeting point, driver pay, cancelling after pickup, a live limit target (#329 spot-checks only).

## Rationale

- **Joins, not pairs of waiting trips**: at the README's spec load a trip is matched within a tick of its request, so two waiting pooled trips rarely meet; joining a driver already on its way catches a pooled rider anywhere along a partner's trip. Allowing joins while the first rider rides, not only before its pickup, is the larger effect (heavy 401 / 506 against 301 / 467 completed) at about twice the detour (24% against 12%), still under the limit.
- **The join ETA is what keeps spec load whole**: without it a pooled rider joins a driver still far from its partner's pickup and gives up (spec greedy 432 completed, 70 cancelled); 120 ticks, the least patience, removes that (480 / 13) and loses nothing under overload (90 is within noise). A cap is one number; comparing with the nearest idle driver was not better and needs a second search.
- **50% detour**: the plainest limit ("never more than half again your direct ride"); 30% halves the detour for 4% fewer completions under heavy load. Direction falls out of it.
- **Two riders**: the issue's minimum and a fixed four-stop route; share 1.0 shows more riders per car would help under overload, a later decision.
- **25% off, fixed at request**: one rule like surge's (fare fixed at request, ADR 0054). Revenue falls where supply is ample (spec −12%, 10k −10%) and rises where trips were lost to overload (heavy greedy +46%, busy city greedy +10%): the trade-off a reader can see.
- **Dispatch and drivers need no switch**: pooled trips exist only when riders opt in, so with pooling off nothing changes by construction, and dispatch and drivers can't disagree with riders about the setting.
- **Effect**: at spec load completed trips stay within noise (−0.2% to +1.9%) with fewer cancellations; a busy city completes 14-27% more, heavy load 36-71% more greedy and 16-20% batched; at 10k 1-4% more, with cancellations down 77-93% and waits down 6-17%, at a 9-10% longer mean ride (19% for shared trips). Drivers carry riders for fewer driver-ticks per completed trip (occupied share down at spec load and 10k).

## Alternatives considered

- **Pair two waiting pooled trips before matching** (offer both to one idle driver): rare at spec load, and batched matching already uses every idle driver it can; the join rule covers it (a trip offered this tick is a partner). Rejected as the only rule.
- **Joins only before the first pickup**: smaller change in the driver, half the effect under overload. Rejected.
- **Prefer an idle driver when near** (join only within N ticks of the nearest idle driver's distance): measured no better than the ETA cap, a second search. Rejected.
- **Capacity 3+ or any number**: stop orders multiply; not measured. Out of scope.
- **Discount only when shared**: the fare would change after request, against ADR 0054's fixed fare, and a rider's price would depend on others. Rejected.
- **Re-plan every stop order on each join** (insertion heuristics): the general vehicle-routing problem; two riders have one choice to make. Rejected.
- **A pooling flag in dispatch and drivers**: another config they must agree on with riders; the `pooled` field carries it. Rejected.
- **A `pool` message or entity owning both trips**: a new aggregate and lifecycle; per-trip lifecycles already hold, and the driver's stops are the only place the pair exists. Rejected.

## Consequences

- **Messages**: optional `pooled: true` on `request_trip`, `trip.requested`, `offer`; no new message or subject. Dispatch keeps, per busy driver, the trips holding it; a driver is busy until its last trip ends.
- **Driver brain**: busy drivers keep stops instead of one trip's fields; the biggest change, done first as a refactor with no behavior change (event logs identical, as the spike showed).
- **Determinism**: rider opt-in from `pool:<tick>`; dispatch and drivers draw nothing new. Over NATS a join decided on a stale view may reach a driver whose first trip ended (it accepts as idle) or that holds two (it declines, as above).
- **Regions**: both trips of a pool belong to one dispatch; dropoffs may be anywhere, as today.
- **Performance**: the join pass loops over open partners for each queued pooled trip; per-tick cost at 100k was within noise in process. #329 re-runs the live greedy `1x1` spot-check with pooling on.
- **Docs**: spec (trip lifecycle, invariants, milestone 31), README `--compare-pooling` table, architecture (driver stops, dispatch joins), domain skill (Pooling section, driver states), UI doc.
- **Risks**: longer rides for shared riders (up to 1.5×, 19% on average) are invisible in "ticks to pickup"; the summary's ride ticks shows them. Revenue falls at spec load, which reads as "pooling loses money"; the docs show both sides.

Domain terms (domain skill, in this change): **Pooling**, **Pooled trip**, **Pool share**, **Join**, **Partner**, **Capacity**, **Detour limit**, **Join ETA**, **Stop** (driver states follow the current stop), **Pooled fare**, **Shared trip**.

Implementation slicing (each PR keeps pooling-off outputs and event logs byte-identical to master on the README seeds; each names its tests):

1. **Pooling vocabulary** (#328a): `src/shared/pool.ts` (detour check, route order, join ETA), pooled fare in `fareOf`, optional `pooled` on the three message schemas. Tests: pool unit tests (limit at exactly 1.5×, both orders, ties to A first, rider aboard, at the dropoff), fare rounding, schemas accept and reject `pooled`. No behavior change.
2. **Drivers keep stops** (#328b): driver brain busy states keep an ordered stop list; refactor only. Tests: existing driver brain tests unchanged and passing; event-log equality on README seeds against master (a test or the PR's check).
3. **Drivers take a second rider** (#328c): accept pooled joins, stop order, drop one trip's stops on cancel / expiry / release, confirms per stop. Tests: driver brain (join accepted / declined per rule, no preference draw, order from both positions, cancel of either, `trip_status` per stop, idle after last stop, determinism).
4. **Dispatch pools trips** (#328d): `pooled` on trips, trips per busy driver, join pass in greedy and batched, pooled fare on `trip.requested`. Tests: dispatch brain (detour limit, join ETA cap, least ETA and ties, excluded driver, capacity two, chaining after a dropoff, driver freed only after both trips, batched before and after passes, surge with a pooled fare, no join without pooled trips).
5. **Capacity invariant** (#328e): checker reads `pooled` from `trip.requested`; two pooled active trips allowed, `driver_over_capacity`; spec invariants. Tests: invariant checker cases.
6. **Switch pooling on** (#328f): riders opt in (`pool:<tick>`, share 0.5), `SimConfig.pooling`, `--pooling` (sim, bench), `POOLING` (dev), `--compare-pooling`, summary lines, `bun run report` trips pooled. Tests: rider brain (opt-in share, no draw when off, surge decline unchanged), args and config, summary, report query, system tests in process (invariants, determinism, 1% loss) and over NATS. Docs: README table (numbers match this spike within the tie and rounding note below), spec, architecture.
7. **Show pooling** (#329a): UI view per-driver trips, ring for two riders, panel lines, `POOLING=on bun run demo`. Tests: view and render pure seams; screenshot. Docs: README demo, `docs/ui.md`.
8. **Live check** (#329b): live greedy `1x1` 600k with pooling on, two runs, against milestone 30's; `docs/performance.md`; spec milestone 31 done.

The spike's partner ties keep its own list order and its fare rounds twice (fare, then × 0.75); the rules above may move a README number by a trip or a cent, which #328f's table records.
