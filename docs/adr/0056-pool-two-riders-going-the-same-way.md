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

Spike on the unmerged branch [`327-exp-pooling`](https://github.com/kludw/uber-simulator/tree/327-exp-pooling) (`ec50370`): the rule below in process behind env knobs (`SPIKE_POOL=on SPIKE_POOL_JOIN=aboard SPIKE_POOL_ETA=120`, defaults share 0.5, detour 50%, fare × 0.75, ride so far in ticks since pickup), measured with `src/sim/pool-spike.ts` (one run, one JSON line; event-log SHA-256 included). The driver brain was rewritten to a list of stops for it, and with pooling off the event logs of six scenarios (spec greedy and batched; heavy greedy and batched; heavy `2x2` with surge on; heavy batched with shifts and picky drivers) hash identical to master's, as do the 10k numbers below against ADR 0055's surge-off reference. Each cell: pooling off → on. **Shared**: completed trips that had another trip on their driver; **Ride**: mean ticks from pickup to completion; **Detour**: shared trips' mean ride over their direct distance, minus 1; **Occupied**: share of driver-ticks with a rider aboard.

README seeds, 3,600 ticks, batch window 5 (spec: 10 req/min, 100 drivers; busy city: city, 20 req/min; heavy: city, 30 req/min, 50 drivers):

| Scenario, matching | Completed | Cancelled | Shared | Ticks to pickup | Ride | Detour | Occupied | Revenue |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| spec, greedy | 477 → 483 | 19 → 12 | 176 | 61.1 → 61.0 | 328.0 → 347.9 | 15.6% | 47.4% → 45.3% | $4,321 → $3,830 |
| spec, batched | 474 → 484 | 21 → 10 | 178 | 62.0 → 61.3 | 325.9 → 351.8 | 17.0% | 46.8% → 45.6% | $4,275 → $3,857 |
| spec city, greedy | 485 → 483 | 20 → 16 | 182 | 64.9 → 61.6 | 307.8 → 329.0 | 15.1% | 44.1% → 41.3% | $4,198 → $3,659 |
| spec city, batched | 480 → 483 | 21 → 15 | 181 | 63.8 → 59.8 | 305.0 → 327.0 | 15.4% | 43.8% → 41.6% | $4,128 → $3,650 |
| busy city, greedy | 558 → 693 | 488 → 334 | 346 | 107.1 → 90.3 | 292.9 → 332.6 | 16.8% | 48.1% → 56.8% | $4,664 → $5,061 |
| busy city, batched | 656 → 743 | 383 → 275 | 365 | 107.2 → 94.2 | 295.4 → 332.3 | 17.3% | 57.5% → 61.1% | $5,515 → $5,445 |
| heavy, greedy | 235 → 388 | 1,358 → 1,191 | 297 | 186.8 → 150.5 | 261.9 → 348.0 | 21.6% | 35.8% → 57.6% | $1,818 → $2,596 |
| heavy, batched | 421 → 504 | 1,160 → 1,059 | 314 | 124.2 → 125.6 | 308.8 → 350.2 | 19.2% | 76.2% → 81.5% | $3,653 → $3,623 |
| heavy 2x2, greedy | 277 → 375 | 1,316 → 1,200 | 234 | 184.7 → 153.6 | 282.0 → 327.4 | 15.1% | 45.1% → 56.5% | $2,255 → $2,609 |
| heavy 2x2, batched | 424 → 479 | 1,154 → 1,091 | 264 | 118.2 → 123.8 | 300.5 → 346.0 | 14.6% | 75.4% → 79.8% | $3,608 → $3,604 |

Heavy greedy on other seeds: seed 1 233 → 384 completed, seed 2 242 → 389; spec greedy seed 1: 485 → 489, cancelled 21 → 12. With surge on (heavy greedy): 229 → 355 completed, 991 → 861 cancelled, 400 → 387 declined, $2,480 → $3,121. Shifts and picky drivers (heavy greedy): 267 → 357. At 1% message loss (heavy greedy; heavy batched `2x2`): 389 and 485 completed, no invariant violation, 4 and 5 rejected inputs (master at 1% loss: 4). Two runs of one seed give one event log.

10k drivers (2 × 5,000, 1,500 req/min, 1,800 ticks, city):

| Scenario | Completed | Cancelled | Shared | Ticks to pickup | Ride | Detour | Occupied | Revenue |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| greedy | 32,764 → 34,165 | 2,931 → 615 | 16,939 | 68.2 → 57.1 | 290.2 → 315.3 | 17.2% | 60.4% → 55.9% | $272,062 → $246,660 |
| batched | 33,232 → 34,212 | 2,622 → 582 | 16,962 | 63.1 → 56.4 | 290.4 → 315.6 | 17.2% | 61.3% → 55.9% | $276,086 → $247,072 |
| greedy, surge on | 34,343 → 34,699 | 505 → 0 | 16,943 | 32.3 → 31.0 | 290.0 → 316.9 | 17.8% | 62.9% → 57.1% | $297,288 → $257,579 |

(Surge on at 10k: declined 2,003 → 999.)

**Detour bound check** (`overLimit` in `pool-spike.ts`): from the event log alone, each shared trip's ride ticks (`trip.picked_up` to `trip.completed`) against 1.5 × its direct distance + 2 ticks. The 2 ticks: dispatch decides a join on its view of the driver's cell, the previous tick's; by the time the offer reaches the driver it has taken one more step, possibly away (one step out, one back). Result: **0 over in every run above without message loss** (all README rows, seeds 1 and 2, surge, shifts + picky, the 10k rows, and the variants below); without the 2 ticks up to 3 at README sizes and 87-93 at 10k, worst 1.52×. At 1% loss 2 of 299 shared trips are over (1.52×, heavy greedy: a lost move leaves dispatch's view staler), 0 at heavy batched `2x2`. How the rule got here: the first version of this ADR counted the partner's ride so far as the Manhattan distance from its pickup to its driver, which undercounts after a chained pool (rule 3): 15 of 176 shared trips over at spec greedy (2.1×), 50 of 316 at heavy greedy (2.5×), 1,427 of 16,786 at 10k greedy (3.2×) ([review of #344](https://github.com/kludw/uber-simulator/pull/344#pullrequestreview-5481193830)). Summing the legs driven between stops and turns (joins, a second trip leaving) from dispatch's view left 0 at README sizes but 12 of 16,957 at 10k (1.52×), since the one-tick lag adds up over a chain of joins. Ticks since pickup has nothing to add up, and is what the rider experiences.

Variants (completed, heavy greedy / heavy batched unless noted):

- Join only before the first rider's pickup: 301 / 467 (detour 12% / 11%); 10k greedy 34,238 completed, 738 cancelled, 63.4 ticks to pickup.
- No join ETA cap: spec greedy, joins before pickup only, 430 completed, 71 cancelled (a pooled rider waits for a driver still far from the first pickup); heavy greedy, joins while aboard, 331.
- Join ETA cap 90: 400 (greedy); 180 (before pickup only): 296 against 301 at 120.
- Detour 30%: 382 / 491, detour 11% (worst 1.31×); spec 484 / 482. Detour 100% (before pickup only): 293 against 301.
- Join only within 0-60 ticks of the nearest idle driver's pickup distance, instead of a cap (before pickup only): spec 478-481, heavy (30) 274 against 301.
- Every rider pooled (share 1.0): heavy greedy 531 completed, 1,024 cancelled, detour 21.6%; spec greedy 485, 3 cancelled, revenue $3,272.

Cost, `bun run bench --ticks 300` (uniform, spec ratio, one run each unless noted):

- Pooling on against off, both on the spike: 100k mean 25.94 → 25.92 ms per tick, p95 33.13 → 32.92 ms; 600k mean 216.93 → 206.07 ms, p95 274.07 → 251.99 ms, peak RSS 2,543 → 2,609 MiB. Within noise.
- **The spike's off path is not free** (600k, two runs each, alternating): master 174.74 / 178.54 ms mean, peak RSS 2,292 / 2,336 MiB; spike, pooling off, 219.40 / 210.82 ms (+18-26%), 2,620 / 2,672 MiB (+14%). Spike dispatch with master's driver brain: 180.47 / 173.42 ms against master 186.60 / 180.71 (within noise), 2,553 / 2,559 MiB against 2,201 / 2,252 (+14-16%). So the time is the spike driver brain's stop and trip arrays per busy driver, rebuilt on every change; the memory is the spike dispatch's maps kept for every trip (trips per busy driver as arrays, pickup ticks and legs for every picked-up trip). The design below avoids both, and #328b and #328d gate on it (slicing).

## Decision

We will let a rider opt in to pooling and let dispatch give its trip to a driver already carrying, or heading to, another pooled rider when both rides stay within 1.5 × their direct distance and the driver reaches the new pickup within 2 minutes. A driver carries at most two trips. Off by default.

1. **Opt-in**: with pooling on, each spawned rider pools with probability 0.5 (the **pool share**), one draw per spawned rider from the child stream `pool:<tick>`, taken only with pooling on. Its `request_trip`, its `trip.requested` and every `offer` of its trip carry `pooled: true` (absent otherwise). Riders behave as today otherwise: same patience, same surge quote and decline.
2. **Who can share**: a queued pooled trip B may **join** a pooled trip A (its **partner**) of the same dispatch (so the same region) when A holds its driver alone (A offered, matched or picked up, no second trip on that driver), that driver is online in dispatch's view and not excluded for B, and:
   - **Detour limit**: each rider's ride, in ticks, at most 1.5 × its direct distance. For A: the ticks since its `trip.picked_up` (dispatch's last tick; 0 if not picked up yet) plus its remaining route from its driver's cell in dispatch's view; for B: its route from its pickup. Dispatch keeps a pickup tick for each picked-up pooled trip, nothing else.
   - **Join ETA**: the driver's cell in dispatch's view, to A's pickup if A is not picked up yet, then to B's pickup, at most 120 ticks (the least patience).
   - **Route**: A's pickup (if still ahead), B's pickup, then both dropoffs in the order with the shorter remaining route from B's pickup, ties to A's first. A driver already waiting at A's dropoff goes on to B's pickup and dropoff after it.
   Among partners, the least join ETA; ties to the partner earlier in dispatch's trip order (request order). No direction rule beyond the detour limit: a rider going the other way fails it. The limit holds within 2 ticks per join (dispatch's view is a tick old, above); messages lost can add a little more.
3. **Capacity**: two trips per driver, counting a pending offer: a driver with two trips is offered nothing more. Once one is dropped off, cancelled, expired or released, the other is a partner again (pools chain).
4. **Matching**: greedy: each tick, each queued trip in FIFO order; a pooled trip first joins its best partner, else takes the nearest idle driver as today. Batched (window ticks only): a join pass over the queued pooled trips in FIFO order, then batched matching of the rest as today, then a join pass for the pooled trips it left without a driver (partners include trips just offered). A pooled trip joins even when an idle driver is nearer: saving a driver is the point, and the join ETA bounds the wait. **No work when no trip is pooled**: dispatch keeps a count of its open (not ended) pooled trips and skips both join passes at zero; with pooling off the count stays 0, and a driver's busy mark works as today (only a pooled trip can be a driver's second).
5. **Driver lifecycle**: a driver keeps its trips' remaining **stops** in order (one trip: pickup, dropoff; a pool: pickup, pickup, dropoff, dropoff in the route's order). Its state follows its current stop: `en_route` / `at_pickup` for a pickup, `on_trip` / `at_dropoff` for a dropoff; idle when no stop is left. A busy driver accepts an offer iff the offer is pooled, the driver holds exactly one trip, that trip is pooled, and the offer's region is its trip's; no preference draw for a join. Arrivals, `trip.picked_up` and `trip.completed` are per stop; `trip.cancelled`, `trip.offer_expired` and `trip_status` `released` drop that trip's stops and the driver goes on with the rest. Each trip keeps today's states and transitions; dispatch's per-trip rules do not change.
6. **Recovery** (ADR 0041): a driver waiting at a stop confirms that stop's trip and stage every 10 ticks, as today; `picked_up` / `completed` move it to its next stop, `released` drops the trip's stops. Dispatch answers per trip, unchanged. A busy driver declining a join (a stale view) carries `idleAt: null`, and dispatch handles it as today: `removeDriver` keeps a busy driver's record but marks it offline, so it is no partner (rule 2) and gets no offer; when its last trip ends (`markFree`) dispatch forgets it, and learns it again from its next move ([ADR 0043](0043-learn-drivers-from-moves.md)).
7. **Fare**: a pooled trip's fare is `round((250 + 2 × distance) × surge × 0.75)` (the **pooled fare**, 25% off), fixed at request, whether or not anyone joins. Surge pricing counts pooled trips like any other; riders decide on the quote as today. With surge off messages still carry no fare; the summary counts a pooled trip at the pooled base fare.
8. **Invariants** (spec, checker): a driver has at most two active trips, and two only when both are pooled (`driver_has_two_active_trips` for a second trip when either is not pooled, `driver_over_capacity` for a third). "Each rider picked up before dropped off" is already checked per trip (legal transitions; completed trips were picked up). Arrivals stay checked against each trip's cells. The detour limit is not an event-log invariant (it depends on dispatch's view and on message loss); a system test checks it (#328f).
9. **Switch and outputs**: `--pooling on|off` for `bun run sim` and `bun run bench`, `POOLING` for `bun run dev` (riders only: dispatch and drivers act on `pooled` fields, so they need no switch), `SimConfig.pooling`; `bun run sim -- --compare-pooling` runs pooling off and on side by side. With pooling on the summary also prints trips pooled, trips shared, mean ticks from pickup to completion and revenue. Off: no draw, no field, every output and event log byte-identical.
10. **Persistence**: no new ClickHouse column or migration: `pooled` lives in the payload, as fares do (ADR 0054). `bun run report` adds trips pooled when any; its revenue sums event fares as today. Replay republishes payloads unchanged.
11. **UI**: the view keeps each driver's trips: a driver is idle only when its last trip ends, its state follows its latest trip event otherwise. Dots mode draws a ring around a driver carrying two riders; both trips' lines show. The panel adds trips pooled and trips shared once any trip is pooled. Heatmap unchanged.

Out of scope, deliberately: more than two riders, joins across regions, re-ordering stops beyond the dropoff choice, a rider's own detour tolerance, a discount only when shared, pooled patience or prices, walking to a meeting point, driver pay, cancelling after pickup, a live limit target (#329 spot-checks only).

## Rationale

- **Joins, not pairs of waiting trips**: at the README's spec load a trip is matched within a tick of its request, so two waiting pooled trips rarely meet; joining a driver already on its way catches a pooled rider anywhere along a partner's trip. Allowing joins while the first rider rides, not only before its pickup, is the larger effect (heavy 388 / 504 against 301 / 467 completed) at a larger detour (19-22% against 11-12%), still within the limit.
- **The join ETA is what keeps spec load whole**: without it a pooled rider joins a driver still far from its partner's pickup and gives up (spec greedy 430 completed, 71 cancelled); 120 ticks, the least patience, removes that (483 / 12) and loses nothing under overload (90 is within noise). A cap is one number; comparing with the nearest idle driver was not better and needs a second search.
- **50% detour, a hard limit**: the plainest rule ("never more than half again your direct ride"), and it holds: 0 shared trips over it, within 2 ticks, in every run without message loss (bound check above). Ride so far counts ticks since pickup, what the rider lives, so a chain of pools can't hide a detour. 30% gives 2-3% fewer completions under heavy load for about half the detour. Direction falls out of the limit.
- **Two riders**: the issue's minimum and a fixed four-stop route; share 1.0 shows more riders per car would help under overload, a later decision.
- **25% off, fixed at request**: one rule like surge's (fare fixed at request, ADR 0054). Revenue falls where supply is ample (spec −10% to −13%, 10k −9% to −13%) and rises where trips were lost to overload (heavy greedy +43%, busy city greedy +9%): the trade-off a reader can see.
- **Dispatch and drivers need no switch**: pooled trips exist only when riders opt in, so with pooling off nothing changes by construction, and dispatch and drivers can't disagree with riders about the setting.
- **Effect**: at spec load completed trips stay within noise (−0.4% to +2.1%) with fewer cancellations; a busy city completes 13-24% more, heavy load 35-65% more greedy and 13-20% batched; at 10k 1-4% more, with cancellations down 78-100% and waits down 4-16%, at a 9% longer mean ride (17-18% for shared trips). Drivers carry riders for fewer driver-ticks per completed trip (occupied share down at spec load and 10k).

## Alternatives considered

- **Pair two waiting pooled trips before matching** (offer both to one idle driver): rare at spec load, and batched matching already uses every idle driver it can; the join rule covers it (a trip offered this tick is a partner). Rejected as the only rule.
- **Joins only before the first pickup**: smaller change in the driver, about half the effect under heavy load (+66 / +46 completed against +153 / +83). Rejected.
- **Ride so far as the distance from the partner's pickup**, or **as legs summed between stops and turns**: the first breaks the limit after chained pools, the second still by a tick per turn at 10k (bound check above), and needs a checkpoint at every change of a driver's plan. Rejected for ticks since pickup.
- **Bound only the remaining route** from the driver's cell: simpler, but then "1.5×" no longer describes a rider's ride. Rejected.
- **Prefer an idle driver when near** (join only within N ticks of the nearest idle driver's distance): measured no better than the ETA cap, a second search. Rejected.
- **Capacity 3+ or any number**: stop orders multiply; not measured. Out of scope.
- **Discount only when shared**: the fare would change after request, against ADR 0054's fixed fare, and a rider's price would depend on others. Rejected.
- **Re-plan every stop order on each join** (insertion heuristics): the general vehicle-routing problem; two riders have one choice to make. Rejected.
- **A pooling flag in dispatch and drivers**: another config they must agree on with riders; the `pooled` field carries it. Rejected.
- **A `pool` message or entity owning both trips**: a new aggregate and lifecycle; per-trip lifecycles already hold, and the driver's stops are the only place the pair exists. Rejected.

## Consequences

- **Messages**: optional `pooled: true` on `request_trip`, `trip.requested`, `offer`; no new message or subject. Dispatch keeps, per driver holding two trips, its second trip, and per picked-up pooled trip its pickup tick; a driver is busy until its last trip ends.
- **Driver brain**: busy drivers keep stops instead of one trip's fields; the biggest change, done first as a refactor with no behavior change (event logs identical, as the spike showed) and no per-tick cost (the spike's shape cost 18-26% at 600k, above).
- **Determinism**: rider opt-in from `pool:<tick>`; dispatch and drivers draw nothing new. Over NATS a join decided on a stale view may reach a driver whose first trip ended (it accepts as idle) or that holds two (it declines, rule 6), and the detour limit may slip by more than 2 ticks.
- **Regions**: both trips of a pool belong to one dispatch; dropoffs may be anywhere, as today.
- **Performance**: the join pass loops over open partners for each queued pooled trip, only while a pooled trip is open; with pooling on, per-tick cost was within noise of pooling off at 100k and 600k in the spike. #329 re-runs the live greedy `1x1` spot-check with pooling on.
- **Docs**: spec (trip lifecycle, invariants, milestone 31), README `--compare-pooling` table, architecture (driver stops, dispatch joins), domain skill (Pooling section, driver states), UI doc.
- **Risks**: longer rides for shared riders (up to 1.5×, 17-22% on average) are invisible in "ticks to pickup"; the summary's ride ticks shows them. Revenue falls at spec load, which reads as "pooling loses money"; the docs show both sides.

Domain terms (domain skill, in this change): **Pooling**, **Pooled trip**, **Pool share**, **Join**, **Partner**, **Capacity**, **Detour limit**, **Join ETA**, **Stop** (driver states follow the current stop), **Pooled fare**, **Shared trip**.

Implementation slicing (each PR keeps pooling-off outputs and event logs byte-identical to master on the README seeds; each names its tests). #328b and #328d also gate on cost: `bun run bench --drivers 600000 --ticks 300` with pooling off, two runs each alternating with master, mean ms per tick and peak RSS within run-to-run noise of master's.

1. **Pooling vocabulary** (#328a): `src/shared/pool.ts` (detour check from ride so far and the remaining route, route order, join ETA), pooled fare in `fareOf`, optional `pooled` on the three message schemas. Tests: pool unit tests (limit at exactly 1.5×, both orders, ties to A first, rider aboard with ticks ridden, driver at the dropoff), fare rounding, schemas accept and reject `pooled`. No behavior change.
2. **Drivers keep stops** (#328b): refactor only, no behavior change. The type is pinned so illegal states stay unrepresentable and nothing is rebuilt per tick: the four busy states keep their names and fields; each adds `trips: [HeldTrip] | [HeldTrip, HeldTrip]` (`HeldTrip = { tripId, pickup, dropoff, pooled }`) and `next: readonly Stop[]` (stops after the current one, at most three), while the current stop stays the state's own fields (`tripId` and `pickup` or `dropoff`), never `stops[0]`; `Stop = { kind: "pickup" | "dropoff"; tripId; cell }`. For one trip, `next` is its dropoff while heading to or waiting at the pickup, empty after; built once per change, not per tick. Tests: existing driver brain tests unchanged and passing; event-log equality on README seeds against master; the bench gate.
3. **Drivers take a second rider** (#328c): accept pooled joins, stop order, drop one trip's stops on cancel / expiry / release, confirms per stop. Tests: driver brain (join accepted / declined per rule, no preference draw, order from both positions, cancel of either, `trip_status` per stop, idle after last stop, determinism).
4. **Dispatch pools trips** (#328d): `pooled` on trips, a count of open pooled trips, a second-trip slot per busy driver (not a list per driver), pickup ticks for picked-up pooled trips only, join passes in greedy and batched, pooled fare on `trip.requested`. Tests: dispatch brain (detour limit with ride so far in ticks, a chained pool's partner rejected once its ride so far uses up the limit, join ETA cap, least ETA and ties, excluded driver, partner's driver held offline after a decline excluded, capacity two, chaining after a dropoff, driver freed only after both trips, batched before and after passes, surge with a pooled fare, no join pass without open pooled trips); the bench gate.
5. **Capacity invariant** (#328e): checker reads `pooled` from `trip.requested`; two pooled active trips allowed, `driver_over_capacity`; spec invariants. Tests: invariant checker cases.
6. **Switch pooling on** (#328f): riders opt in (`pool:<tick>`, share 0.5), `SimConfig.pooling`, `--pooling` (sim, bench), `POOLING` (dev), `--compare-pooling`, summary lines, `bun run report` trips pooled. Tests: rider brain (opt-in share, no draw when off, surge decline unchanged), args and config, summary, report query, system tests in process (invariants, determinism, 1% loss, and **the detour bound: from the event log of an in-process run without loss, every shared trip's ride ticks ≤ 1.5 × direct distance + 2**) and over NATS (invariants). Docs: README table (numbers match this spike within the tie and rounding note below), spec, architecture.
7. **Show pooling** (#329a): UI view per-driver trips, ring for two riders, panel lines, `POOLING=on bun run demo`. Tests: view and render pure seams; screenshot. Docs: README demo, `docs/ui.md`.
8. **Live check** (#329b): live greedy `1x1` 600k with pooling on, two runs, against milestone 30's; `docs/performance.md`; spec milestone 31 done.

The spike's partner ties keep its own list order, its fare rounds twice (fare, then × 0.75), and it keeps busy-driver trips and pickup ticks for every trip; the rules above may move a README number by a trip or a cent, which #328f's table records.
