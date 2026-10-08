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

Spike on the unmerged branch `317-exp-chase` (`0a2d6b3`): the rule below in process behind env knobs (`SPIKE_CHASE=on SPIKE_RETARGET=tick SPIKE_REACH=4`), measured with `bun run sim -- --compare-surge`, seed 42. With chasing off every column is identical to master (README table), and the surge-off column is identical with chasing on (no draw without prices). Each cell: surge on without chasing → with chasing.

README seeds, 3,600 ticks, batch window 5 (spec: 10 req/min, 100 drivers; busy city: city, 20 req/min; heavy: city, 30 req/min, 50 drivers):

| Scenario, matching | Completed | Cancelled | Declined | Mean ticks to pickup | Revenue |
| --- | --- | --- | --- | --- | --- |
| spec, greedy | 477 → 477 | 19 → 19 | 0 → 0 | 61.1 → 61.1 | $4,321 → $4,321 |
| spec, batched | 474 → 476 | 21 → 20 | 0 → 0 | 62.0 → 62.9 | $4,275 → $4,299 |
| spec city, greedy | 485 → 485 | 20 → 20 | 0 → 0 | 64.9 → 64.9 | $4,198 → $4,198 |
| spec city, batched | 480 → 479 | 21 → 28 | 0 → 0 | 63.8 → 60.3 | $4,138 → $4,138 |
| busy city, greedy | 551 → 562 | 480 → 470 | 25 → 25 | 111.4 → 109.4 | $4,695 → $4,779 |
| busy city, batched | 636 → 640 | 350 → 349 | 63 → 56 | 111.7 → 111.2 | $5,691 → $5,632 |
| heavy, greedy | 216 → 212 | 1,016 → 1,018 | 392 → 390 | 175.7 → 174.9 | $2,414 → $2,242 |
| heavy, batched | 426 → 418 | 742 → 752 | 440 → 444 | 120.9 → 125.5 | $4,226 → $4,173 |
| heavy 2x2, greedy | 286 → 284 | 925 → 925 | 408 → 406 | 170.2 → 172.2 | $2,837 → $2,846 |
| heavy 2x2, batched | 416 → 419 | 751 → 743 | 440 → 443 | 119.2 → 122.5 | $4,089 → $4,168 |

Heavy load on seeds 1-3 moves both ways (completed greedy 211 → 219, 218 → 213, 206 → 218; batched 393 → 404, 420 → 414, 412 → 394): at 100 drivers chasing is noise, because an idle driver is offered a trip within a tick or two wherever it is. The effect shows at 10k drivers (2 × 5,000, 1,500 req/min, 1,800 ticks, city unless noted):

| Scenario | Completed | Cancelled | Declined | Mean ticks to pickup | Revenue |
| --- | --- | --- | --- | --- | --- |
| greedy | 30,489 → 34,346 | 868 → 454 | 5,803 → 2,002 | 48.0 → 31.7 | $289,878 → $298,313 |
| greedy, seed 7 | 30,756 → 34,100 | 868 → 582 | 5,625 → 2,199 | 49.9 → 32.7 | $289,807 → $296,226 |
| batched | 28,254 → 33,883 | 282 → 24 | 9,848 → 3,432 | 33.8 → 21.7 | $299,287 → $305,450 |
| greedy `2x2` | 30,269 → 34,139 | 1,185 → 639 | 6,076 → 2,367 | 46.5 → 28.9 | $287,850 → $296,645 |
| greedy, shifts | 29,648 → 32,570 | 1,203 → 942 | 6,428 → 3,832 | 55.5 → 40.6 | $286,739 → $290,908 |
| greedy, picky | 25,964 → 33,961 | 1,562 → 12 | 11,348 → 3,267 | 36.0 → 21.6 | $276,945 → $306,437 |
| greedy, uniform | 35,778 → 35,872 | 167 → 106 | 237 → 193 | 23.7 → 21.4 | $314,524 → $315,266 |

Surge off at 10k city greedy for reference: 32,764 completed, 2,931 cancelled, 68.2 ticks to pickup, $272,062. No run had an invariant violation; two runs with chasing on one seed gave identical output.

Variants (10k city greedy, completed / declined / ticks to pickup): retarget only when a driver picks a new target anyway, reach 1 / 2 / 4 zones: 30,566 / 5,762 / 47.7; 30,876 / 5,579 / 44.2; 32,165 / 4,257 / 41.1. Also on new prices, reach 1 / 2 / 3 / 4 / 5 / 6 / 20: 30,818 / 5,553 / 45.7; 32,542 / 3,818 / 39.0; 33,561 / 2,702 / 33.9; 34,346 / 2,002 / 31.7; 34,253 / 2,098 / 31.9; 33,729 / 2,475 / 33.1; 33,827 / 2,402 / 35.8. Only a seeded share reacting, with probability surge − 1: 34,056 / 2,394 / 32.6; half: 33,669 / 2,685 / 36.0. Retargeting on each `zones.priced` message instead of the next tick: 34,224 / 2,161 / 31.8.

Cost, `bun run bench --drivers 200000 --ticks 300 --surge on` (uniform, spec ratio; 412k retargets in the run): mean 44.1-47.2 → 46.1-46.5 ms per tick, p95 49.6-53.2 → 52.8-53.0 ms (two runs each, noise); one run's heap at the end 309 → 413 MiB. At 600k (one run each, 1.16M retargets): mean 180.5 → 183.9 ms, p95 194.8 → 201.7 ms (+2%, +4%), heap at the end 897 → 1,283 MiB (15.8M → 23.9M objects), peak RSS 2,321 → 2,460 MiB. The heap growth is not explained yet; a likely cause is more trips kept by dispatch and riders as fewer riders decline, not chasing state (a shard adds one table and the prices).

## Decision

We will let each driver shard keep the latest prices and send every idle driver that picks a target to the **nearest surge area within 4 zones** of its own zone, and re-pick for the drivers not already heading into one each time new prices arrive. Drivers with no surge area in reach wander as today.

1. **Price view**: driver shards take `zones.priced` (one more input type in the shard's compile-time list, ADR 0042; one subscription to `sim.events.zones.priced` per shard process) and keep the last message per region, by zone, as riders do. No new message, no config: with surge off nothing is published, so a shard has no prices and nothing changes.
2. **Chase target**: from the driver's zone, the surge area at the least **zone distance** (Manhattan distance between zones in zone columns and rows; 1 zone = 50 cells) up to the **chase reach** of 4 zones (200 cells, 2 km), ties to the higher surge, then the lower region, then the lower zone. The target is a uniform cell of that area (`zonePartBounds`), two draws from the shard's stream, as a wander target is. None in reach: a random wander target as today.
3. **When**: (a) whenever an idle driver picks a target anyway (on going online, when its trip ends or is released, on arrival), it takes a chase target if there is one; (b) on the first tick after the shard received a `zones.priced`, every idle driver whose target is not in a surge area under the current prices takes a chase target if there is one, else keeps its target. A driver arriving in a still-surging area picks its next cell in the same area (zone distance 0), so it circles there until matched or the area stops surging.
4. **Everyone reacts**: every idle driver, no seeded share, no extra draw. Busy and offline drivers never chase; a driver going offline drops its target as today.
5. **Computation**: on that tick the shard builds, once, a **chase table** from zone to the nearest surge area in reach (zones × surge areas, at most 100 × a few hundred), so each idle driver costs one lookup by its zone. Built only when prices changed; empty with surge off.
6. **Always on with surge**: no `--chase` option. The without-chasing baseline is ADR 0054's table (and the README's until #318 replaces it); a knob would be one more value every process must agree on, for a comparison the ADRs already record.

## Rationale

- **One sentence**: "an idle driver heads to the nearest surging zone within 2 km; prices change, it looks again". The reach, the only number, is the measured best (3-5 zones within noise of each other; 1-2 too short to find surge, 6+ pulls drivers past nearer demand).
- **Re-picking on new prices doubles the effect** (declines −65% instead of −27% at 10k): a wander target is about 333 cells away on average, so a driver otherwise ignores surge for minutes. Re-picking only drivers not already heading into a surge area keeps commitment: nobody turns back while its area still surges.
- **Nearest, not weighted**: deterministic given prices, no extra draw, and the surge only breaks ties. A weighted random choice (surge × closeness) was not measured; it would add a draw per pick and a formula to explain.
- **All idle drivers**: a seeded share was within noise (probability surge − 1) or worse (half), and costs a draw and a parameter. Herding does not show: when an area fills with idle drivers its surge drops at the next pricing, and drivers already there stay near demand.
- **The shard decides**: drivers own their movement (ADR 0017); the price map is already published for riders and the UI. No dispatch change, no command, no new subject.
- **Surge off untouched by construction**: no `zones.priced`, no table, no draw. Surge on with nothing surging in reach draws nothing new either (spec greedy outputs identical with chasing).
- **Where it matters**: at the README's 100 drivers outcomes stay within seed noise (idle drivers are matched within a tick or two wherever they are); at 10k with city demand, surge on with chasing completes more trips than surge off (+2% to +7%), and against surge on alone cuts declines by 40-71%, mean ticks to pickup by 27-40%, and raises revenue 1.5-3% (picky 11%). With uniform demand it changes little, as surge is rare there.

## Alternatives considered

- **Re-pick only when a driver picks a target anyway** (arrival, trip end, going online): smallest change, but half the effect (above). Rejected.
- **Re-pick on each `zones.priced` message**: same outcome in process (34,224 vs 34,346 completed), but loops over all the shard's drivers once per region message (25 times per pricing at `5x5`) outside the tick loop. Rejected for the next-tick pass, folded into the loop that already visits every driver.
- **A seeded share of idle drivers reacts**, or probability by surge: no better, one more draw and number. Rejected.
- **Weighted random area** by surge and distance: more draws and words, not measured. Rejected.
- **Unlimited reach** (whole city): drivers cross the city past nearer demand; measured worse (35.8 vs 31.7 ticks to pickup). Rejected.
- **Dispatch steers idle drivers** (a reposition command per driver): dispatch would decide drivers' moves, a new command per driver per pricing (hundreds of thousands at 600k), and losable legs (ADR 0041). Rejected.
- **Drivers also flee areas with many idle drivers**: needs idle counts per zone in shards (dispatch has them, shards don't; publishing them is a new message). Rejected for now.
- **Surge share in driver pay**: drivers have no earnings model. Out of scope.
- **A `--chase` option**: see Decision 6. Rejected.

## Consequences

- **Messages and subscriptions**: no new message or subject. Each shard process adds one subscription, `sim.events.zones.priced`, receiving one message per region every 30 ticks (at most 100 entries each). Over NATS at 600k (2 shards, `1x1`): 2 more deliveries per 30 ticks, against up to 120 `drivers.moved` per tick.
- **Determinism**: the brain stays pure; chase targets come from the shard's stream, drawn only when a chase target is picked. In process the order of prices and ticks is fixed, so a seed gives one log. Over NATS which tick a shard first sees new prices varies, like riders' quotes (ADR 0054). Surge off: identical outputs and logs.
- **Regions**: a driver chases any region's surge area, including across a border; its moves go to its old region until it crosses, and the new region learns it from its crossing move (ADR 0050). An idle driver still declines an offer from a region other than its cell's, so a chaser crossing a border is offered trips only by its new region. Prices keyed by (region, zone) as riders key them.
- **Shifts and preferences**: offline drivers don't chase; a driver going online picks a chase target if one is in reach; shift draws are unchanged (own streams). Picky drivers chase like others and then decline fewer far offers (10k picky: declines −71%).
- **Message loss (ADR 0041)**: a lost `zones.priced` leaves a shard on that region's previous prices until the next one (≤ 30 ticks): its drivers may head to an area that stopped surging, or miss a new one. Harmless; no recovery needed.
- **Performance**: one table build per shard per pricing (about 10⁴ steps), one lookup per idle driver on that tick and whenever a driver picks a target. Shards are the largest CPU user at 600k (2 × 300k drivers per tick), so #318 re-runs the live greedy `1x1` 600k spot-check with surge on and explains the heap growth in the bench runs (+43% at 600k) before calling it fine.
- **Risks**: drivers concentrate downtown, so outer zones may see longer pickups (not seen: cancellations fall in every 10k scenario). The README's sizes show no effect, which reads as "chasing does nothing"; the docs say why and show the 10k numbers next to them.

Domain terms (domain skill, added with the code): **Chase** (an idle driver heading for a surge area instead of a random cell), **Chase target** (a uniform cell of the nearest surge area within reach; replaces the wander target while chasing), **Chase reach** (4 zones, by **zone distance**: Manhattan distance between zones in zone columns and rows); **Wander target** amended: random cell when no surge area is in reach.

Implementation slicing (each keeps surge-off outputs and event logs byte-identical on the README seeds):

1. **Chase in driver shards** (#318a): `zones.priced` in `DriverShardInput` and the shard's input list; prices per region; chase table per change; chase targets on pick and on the tick after new prices. Seams: driver brain (no prices: wander unchanged and no extra draw; nearest area, ties, reach; area cut by a region border; re-pick on new prices only for drivers not heading into a surge area; arrival inside a surging area), system tests with surge on (invariants, determinism, message loss) in process and over NATS. Docs: README `--compare-surge` table and a 10k row, spec, architecture (driver brain, shard inputs), domain skill. Surge-on numbers match this spike.
2. **Live check** (#318b): live greedy `1x1` 600k with surge on, two runs, against M28's spot-check; the heap check; `docs/performance.md`; spec milestone 30 done. No UI change: dots already move into tinted areas.
