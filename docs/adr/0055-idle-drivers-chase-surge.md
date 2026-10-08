# 0055. Idle drivers chase the nearest surge area

- Status: Accepted
- Date: 2026-10-08

## Context

Milestone 30 ([#316](https://github.com/kludw/uber-simulator/issues/316)) closes the loop [ADR 0054](0054-price-trips-with-zone-surge.md) left open (its item 7, "drivers don't react"): with surge on, idle drivers should drift toward surging zones instead of wandering at random. Like surge itself it is a portfolio feature: the rule must fit in a sentence or two, not model driver economics.

Forces:

- Idle drivers today head for a **wander target**, a uniform random cell drawn from the shard's stream, and pick a new one on arrival, on going online, and when a trip ends (`src/driver/brain.ts`, `wander`).
- Dispatch publishes `zones.priced` every 30 ticks per region on the one unregioned subject `sim.events.zones.priced`: the region's zones above 1.0 (ADR 0054). A zone cut by a region border is priced per part; its part in the region that priced it is a **surge area**. Riders already keep the last message per region.
- Brains are pure and seeded (simulation skill). With surge off every output and event log must stay byte-identical: no new draws, no new messages.
- Driver shards are the largest CPU user at the live limit (greedy `1x1` 600k is 2 shards of 300k drivers, [performance.md](../performance.md)); every shard tick already loops over all its drivers.
- Messages can be lost to one subscriber (ADR 0041). Each service's inputs are a compile-time complete list (ADR 0042).
- Surge exists where unmatched trips outnumber idle drivers. At the README's sizes (100 drivers) that means almost no idle driver anywhere; at 10k drivers with city demand, idle drivers sit in quiet zones while downtown surges.

Spike on the unmerged branch `317-exp-chase` (`60ce69f`): the rule below in process behind env knobs (`SPIKE_CHASE=on SPIKE_RETARGET=tick SPIKE_REACH=4`), chase targets drawn from a `chase:<tick>` child stream, measured with `bun run sim -- --compare-surge`, seed 42. With chasing off every column is identical to master (README table), and the surge-off column is identical with chasing on (no draw without prices). Each cell: surge on without chasing → with chasing.

README seeds, 3,600 ticks, batch window 5 (spec: 10 req/min, 100 drivers; busy city: city, 20 req/min; heavy: city, 30 req/min, 50 drivers):

| Scenario, matching | Completed | Cancelled | Declined | Mean ticks to pickup | Revenue |
| --- | --- | --- | --- | --- | --- |
| spec, greedy | 477 → 477 | 19 → 19 | 0 → 0 | 61.1 → 61.1 | $4,321 → $4,321 |
| spec, batched | 474 → 476 | 21 → 21 | 0 → 0 | 62.0 → 60.6 | $4,275 → $4,283 |
| spec city, greedy | 485 → 485 | 20 → 20 | 0 → 0 | 64.9 → 64.9 | $4,198 → $4,198 |
| spec city, batched | 480 → 479 | 21 → 26 | 0 → 0 | 63.8 → 63.1 | $4,138 → $4,130 |
| busy city, greedy | 551 → 557 | 480 → 474 | 25 → 21 | 111.4 → 108.8 | $4,695 → $4,676 |
| busy city, batched | 636 → 632 | 350 → 360 | 63 → 60 | 111.7 → 109.0 | $5,691 → $5,574 |
| heavy, greedy | 216 → 229 | 1,016 → 991 | 392 → 400 | 175.7 → 174.5 | $2,414 → $2,480 |
| heavy, batched | 426 → 420 | 742 → 758 | 440 → 436 | 120.9 → 120.1 | $4,226 → $4,175 |
| heavy 2x2, greedy | 286 → 283 | 925 → 920 | 408 → 413 | 170.2 → 171.2 | $2,837 → $2,884 |
| heavy 2x2, batched | 416 → 436 | 751 → 737 | 440 → 434 | 119.2 → 124.8 | $4,089 → $4,244 |

Heavy load on seeds 1-3 moves both ways (completed greedy 211 → 225, 218 → 220, 206 → 213; batched 393 → 395, 420 → 424, 412 → 402): at 100 drivers chasing is noise, because an idle driver is offered a trip within a tick or two wherever it is. The effect shows at 10k drivers (2 × 5,000, 1,500 req/min, 1,800 ticks, city unless noted):

| Scenario | Completed | Cancelled | Declined | Mean ticks to pickup | Revenue |
| --- | --- | --- | --- | --- | --- |
| greedy | 30,489 → 34,343 | 868 → 505 | 5,803 → 2,003 | 48.0 → 32.3 | $289,878 → $297,288 |
| greedy, seed 7 | 30,756 → 33,755 | 868 → 656 | 5,625 → 2,567 | 49.9 → 35.4 | $289,807 → $295,219 |
| batched | 28,254 → 33,716 | 282 → 0 | 9,848 → 3,611 | 33.8 → 22.3 | $299,287 → $306,634 |
| greedy `2x2` | 30,269 → 34,399 | 1,185 → 482 | 6,076 → 2,048 | 46.5 → 28.6 | $287,850 → $297,875 |
| greedy, shifts | 29,648 → 32,565 | 1,203 → 952 | 6,428 → 3,882 | 55.5 → 40.0 | $286,739 → $289,899 |
| greedy, picky | 25,964 → 33,612 | 1,562 → 9 | 11,348 → 3,734 | 36.0 → 21.6 | $276,945 → $305,492 |
| greedy, uniform | 35,778 → 35,886 | 167 → 96 | 237 → 201 | 23.7 → 20.7 | $314,524 → $315,392 |

Surge off at 10k city greedy for reference: 32,764 completed, 2,931 cancelled, 68.2 ticks to pickup, $272,062. No run had an invariant violation; two runs with chasing on one seed gave identical output.

Variants (10k city greedy, completed / declined / ticks to pickup): re-pick only when a driver picks a target anyway, reach 1 / 2 / 4 zones: 30,538 / 5,814 / 47.2; 30,823 / 5,617 / 44.0; 32,330 / 4,078 / 41.2. Also on new prices, reach 1 / 2 / 3 / 4 / 5 / 6 / 20: 30,833 / 5,580 / 45.0; 32,510 / 3,837 / 39.8; 33,723 / 2,653 / 34.2; 34,343 / 2,003 / 32.3; 34,138 / 2,179 / 32.9; 33,842 / 2,280 / 33.8; 33,807 / 2,375 / 35.6. Only a seeded share reacting, with probability surge − 1: 34,305 / 2,113 / 32.9; half: 33,660 / 2,693 / 35.3. Re-picking on each `zones.priced` message instead of the next tick: 34,275 / 2,149 / 32.0.

Cost, `bun run bench --drivers 600000 --ticks 300 --surge on` (uniform, spec ratio, 2 shards; one run each): mean 173.5 → 171.5 ms per tick, p95 188.0 → 185.0 ms, peak RSS 2,317 → 2,553 MiB (+10%). An earlier spike version (chase draws on the shard's stream, 1.16M re-picks in the run) measured 180.5 → 183.9 ms mean, 194.8 → 201.7 ms p95, peak RSS 2,321 → 2,460 MiB: per-tick cost within run-to-run noise. `bun run bench`'s "heap at end" is the heap size without a collection (garbage included), so it is not a retention measure: an earlier draft of this ADR read its +43% at 600k as growth, and a review run forcing a collection first (`Bun.gc(true)`) found no retained growth.

## Decision

We will let each driver shard keep the latest prices and send every idle driver that picks a target to the **nearest surge area within 4 zones** of its own zone, and re-pick for the drivers not already heading into one each time new prices arrive. Drivers with no surge area in reach wander as today.

1. **Price view**: driver shards take `zones.priced` (one more input type in the shard's compile-time list, ADR 0042; one subscription to `sim.events.zones.priced` per shard process) and keep the last message per region, by zone, as riders do. Receiving any `zones.priced`, even one equal to the last, sets the shard state's `pricesChanged` flag. No new message, no config: with surge off nothing is published, so a shard has no prices and nothing changes.
2. **Chase target**: from the driver's zone, the surge area at the least **zone distance** (Manhattan distance between zones in zone columns and rows; 1 zone = 50 cells) up to the **chase reach** of 4 zones (200 cells, 2 km), ties to the higher surge, then the lower region, then the lower zone. The target is a uniform cell of that area (`zonePartBounds`), two draws from the child stream `chase:<tick>` (taken once per tick, only when a driver chases), so the shard's own stream, and with it every wander and placement draw, is not shifted by chasing. None in reach: a random wander target from the shard's stream as today.
3. **When**: (a) whenever an idle driver picks a target anyway (on going online, when its trip ends or is released, on arrival), it takes a chase target if there is one; (b) on the first tick with `pricesChanged` set (then cleared), every idle driver whose target is not in a surge area under the current prices takes a chase target if there is one, else keeps its target. A driver arriving in a still-surging area picks its next cell in the same area (zone distance 0), so it circles there until matched or the area stops surging.
4. **Everyone reacts**: every idle driver, no seeded share. Busy and offline drivers never chase; a driver going offline drops its target as today.
5. **Computation**: on that tick the shard builds, once, a **chase table** from zone to the nearest surge area in reach (zones × surge areas, at most 100 × a few hundred), so picking a chase target costs one lookup by the driver's zone plus `zonePartBounds` and two draws, and the re-pick pass adds, per idle driver, a `surgeAt` check of its current target (`regionOf`, `zoneOf`, two map lookups). Built only when prices changed; empty with surge off.
6. **Always on with surge**: no `--chase` option. Chasing is how surge is meant to work once drivers react, and one less knob keeps runs and docs simpler. The trade-off: surge on without chasing stays comparable only on paper, against ADR 0054's table and this spike; after #318a no command reproduces it, and the README's surge-on column and its "same numbers as ADR 0054" sentence change there.

## Rationale

- **One sentence**: "an idle driver heads to the nearest surging zone within 2 km; prices change, it looks again". The reach, the only number, is the measured best (3-5 zones close to each other; 1-2 too short to find surge, 6+ pulls drivers past nearer demand).
- **Re-picking on new prices doubles the effect** (declines −65% instead of −30% at 10k): a wander target is about 333 cells away on average, so a driver otherwise ignores surge for minutes. Re-picking only drivers not already heading into a surge area keeps commitment: nobody turns back while its area still surges.
- **Nearest, not weighted**: deterministic given prices, and the surge only breaks ties. A weighted random choice (surge × closeness) was not measured; it would add a formula to explain.
- **All idle drivers**: a seeded share was within noise (probability surge − 1) or worse (half), and costs a draw and a parameter. Herding does not show: when an area fills with idle drivers its surge drops at the next pricing, and drivers already there stay near demand.
- **The shard decides**: drivers own their movement (ADR 0017); the price map is already published for riders and the UI. No dispatch change, no command, no new subject.
- **Surge off untouched by construction**: no `zones.priced`, no table, no draw. Chase draws come from their own stream, so even with surge on a chase never shifts another driver's wander draws.
- **Where it matters**: at the README's 100 drivers outcomes stay within seed noise (idle drivers are matched within a tick or two wherever they are); at 10k with city demand, surge on with chasing completes more trips than surge off (+1.5% to +8%; picky +25%), and against surge on alone cuts declines by 40-67%, mean ticks to pickup by 28-40%, and raises revenue 1-3.5% (picky 10%). With uniform demand it changes little, as surge is rare there.

## Alternatives considered

- **Re-pick only when a driver picks a target anyway** (arrival, trip end, going online): smallest change, but half the effect (above). Rejected.
- **Re-pick on each `zones.priced` message**: same outcome in process (34,275 vs 34,343 completed), but loops over all the shard's drivers once per region message (25 times per pricing at `5x5`) outside the tick loop. Rejected for the next-tick pass, folded into the loop that already visits every driver.
- **Chase draws on the shard's stream**: no extra child, but every chase shifts all later wander draws of the shard, so surge on with and without chasing diverge everywhere, not only where drivers chased. Rejected for `chase:<tick>`.
- **A seeded share of idle drivers reacts**, or probability by surge: no better, one more draw and number. Rejected.
- **Weighted random area** by surge and distance: more words, not measured. Rejected.
- **Unlimited reach** (whole city): drivers cross the city past nearer demand; measured worse (35.6 vs 32.3 ticks to pickup). Rejected.
- **Dispatch steers idle drivers** (a reposition command per driver): dispatch would decide drivers' moves, a new command per driver per pricing (hundreds of thousands at 600k), and losable legs (ADR 0041). Rejected.
- **Drivers also flee areas with many idle drivers**: needs idle counts per zone in shards (dispatch has them, shards don't; publishing them is a new message). Rejected for now.
- **Surge share in driver pay**: drivers have no earnings model. Out of scope.
- **A `--chase` option**: see Decision 6. Rejected.

## Consequences

- **Messages and subscriptions**: no new message or subject. Each shard process adds one subscription, `sim.events.zones.priced`, receiving one message per region every 30 ticks (at most 100 entries each). Over NATS at 600k (2 shards, `1x1`): 2 more deliveries per 30 ticks, against up to 120 `drivers.moved` per tick.
- **Determinism**: the brain stays pure; chase targets come from `chase:<tick>`, drawn only when a chase target is picked, in driver ID order within the tick. In process the order of prices and ticks is fixed, so a seed gives one log. Over NATS which tick a shard first sees new prices varies, like riders' quotes (ADR 0054). Surge off: identical outputs and logs.
- **Regions**: a driver chases any region's surge area, including across a border; its moves go to its old region until it crosses, and the new region learns it from its crossing move (ADR 0050). An idle driver still declines an offer from a region other than its cell's, so a chaser crossing a border is offered trips only by its new region. Prices keyed by (region, zone) as riders key them.
- **Shifts and preferences**: offline drivers don't chase; a driver going online picks a chase target if one is in reach; shift and preference draws are unchanged (own streams). Picky drivers chase like others and then decline fewer far offers (10k picky: declines −67%).
- **Message loss (ADR 0041)**: a lost `zones.priced` leaves a shard on that region's previous prices until the next one (≤ 30 ticks): its drivers may head to an area that stopped surging, or miss a new one. Harmless; no recovery needed.
- **Performance**: one table build per shard per pricing (about 10⁴ steps); per idle driver on the re-pick tick a `surgeAt` check and, when it chases, a table lookup, `zonePartBounds` and two draws; the same lookup whenever a driver picks a target. Per-tick cost at 600k in process was within noise; peak RSS rose 6-10% in the two runs. #318b re-runs the live greedy `1x1` 600k spot-check with surge on and reports peak RSS (or heap after a forced collection), not `heap at end`.
- **Risks**: drivers concentrate downtown, so outer zones may see longer pickups (not seen: cancellations fall in every 10k scenario). The README's sizes show no effect, which reads as "chasing does nothing"; the docs say why and show the 10k numbers next to them.

Domain terms (domain skill, added with the code): **Chase** (an idle driver heading for a surge area instead of a random cell), **Chase target** (a uniform cell of the nearest surge area within reach, drawn from `chase:<tick>`; replaces the wander target while chasing), **Chase reach** (4 zones, by **zone distance**: Manhattan distance between zones in zone columns and rows); **Wander target** amended: random cell when no surge area is in reach.

Implementation slicing (each keeps surge-off outputs and event logs byte-identical on the README seeds):

1. **Chase in driver shards** (#318a): `zones.priced` in `DriverShardInput` and the shard's input list; prices per region and `pricesChanged`; chase table per change; chase targets on pick and on the tick after new prices, from `chase:<tick>`. Seams: driver brain (no prices: wander unchanged and no extra draw; nearest area, ties, reach; area cut by a region border; re-pick on new prices only for drivers not heading into a surge area; arrival inside a surging area; wander draws unshifted by a chase), system tests with surge on (invariants, determinism, message loss) in process and over NATS. Docs: README `--compare-surge` table (surge-on column and its ADR 0054 sentence) and a 10k row, spec, architecture (driver brain, shard inputs), domain skill. Surge-on numbers match this spike.
2. **Live check** (#318b): live greedy `1x1` 600k with surge on, two runs, against M28's spot-check, reporting peak RSS (or heap after a forced collection); `docs/performance.md`; spec milestone 30 done. No UI change: dots already move into tinted areas.
