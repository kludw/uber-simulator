# 0059. Drive on a network of rivers and bridges laid on the grid

- Status: Accepted
- Date: 2026-10-11

## Context

Milestone 33 ([#334](https://github.com/kludw/uber-simulator/issues/334)) replaces Manhattan distance on the open grid with travel over roads: distances become shortest paths, drivers move along roads, and the nearest-driver index, batched matching, surge zones and the UI follow. Like surge, pooling and ratings ([ADR 0054](0054-price-trips-with-zone-surge.md), [0056](0056-pool-two-riders-going-the-same-way.md), [0057](0057-weigh-driver-ratings-into-matching.md)) it is a portfolio feature: off by default, outputs byte-identical when off.

Forces:

- Everything is built on cells ([ADR 0008](0008-deterministic-tick-based-simulation.md), [0016](0016-initial-domain-model.md)): 500 × 500 cells of 10 m, one 4-neighbor move per tick, larger remaining axis first, ETA = distance. Regions ([0050](0050-split-dispatch-by-region.md)), surge zones (0054), hotspots, heatmap tiles ([0053](0053-scale-the-ui-in-the-browser.md)) and `drivers.moved` ([0047](0047-driver-moves-as-parallel-arrays.md), [0052](0052-driver-indexes-in-moves.md)) are all cells.
- Shortest paths aren't free, and every hot path measures distance: greedy's ring search over the idle driver index ([0036](0036-scale-to-50k.md), [0048](0048-keep-idle-drivers-across-ticks.md)), ADR [0051](0051-search-untouched-drivers-in-batched-matching.md)'s exact batched solver, every driver's step every tick, pooling's join ETA, detour and join reach ([0058](0058-join-a-pool-only-when-it-beats-the-nearest-idle-driver.md)), ratings' match cost (0057). The live limit is greedy `1x1` 600k at real time (settle p95 ≤ 610 ms); in process that is about 200 ms per tick.
- The ring search and ADR 0051's solver are exact because they can bound the distance of whole areas from below. A road distance that is never less than Manhattan distance keeps that bound valid.
- Brains are pure and seeded; every process (each dispatch region, each driver shard, riders, the invariant checker, the UI) must agree on the network without a new message.
- No new dependency or download without a reason (CLAUDE.md).

Spike on the unmerged branch [`335-exp-roads`](https://github.com/kludw/uber-simulator/tree/335-exp-roads) (`d144516`): the network below in `src/shared/roads.ts` behind `SPIKE_ROADS=river|canals`, wired through `src/shared/grid.ts`'s `distance`, `stepToward` and `randomCell` (a module switch, so every caller is on roads), measured with `src/sim/roads-spike.ts` (one run, one JSON line, event-log SHA-256 and invariant violations included). `src/shared/roads.test.ts` checks road distance against BFS over drivable cells for both presets (from cells and bridges, both directions) and that a driver keeping its waypoint arrives in exactly the road distance. With roads off, the event logs of eleven README scenarios (spec and city loads, greedy and batched, `2x2`, surge, pooling, ratings, shifts with picky drivers) and four 10k scenarios hash identical to master's (`110326c`).

The presets (each from a fixed seed, see rule 2):

| Preset | Rivers | Bridges | Districts | Road cells | Mean road / Manhattan distance, random pairs | Pairs detoured | Worst extra |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `river` | 1 (row 263) | 4 | 2 | 99.8% | 340.8 / 333.6 (+2.2%) | 12.8% | 188 cells |
| `canals` | 3 rows (138, 248, 361), 3 columns (105, 264, 367) | 48 (2 per district side) | 16 | 98.8% | 346.5 / 334.2 (+3.7%) | 36.1% | 160 cells |

README seeds, seed 42, 3,600 ticks, batch window 5 (spec: 10 req/min, 100 drivers; busy city: city, 20 req/min; heavy: city, 30 req/min, 50 drivers). Each cell: off → `river` / `canals`. **Ride**: mean ticks from pickup to completion. 0 invariant violations in every run (the spike's checker adds off-road cells to `driver_left_grid` and checks steps by road distance):

| Scenario, matching | Completed | Cancelled | Ticks to pickup | Ride |
| --- | --- | --- | --- | --- |
| spec, greedy | 477 → 471 / 479 | 19 → 24 / 18 | 61.1 → 63.6 / 62.2 | 328.0 → 330.4 / 342.1 |
| spec, batched | 474 → 472 / 468 | 21 → 21 / 26 | 62.0 → 63.3 / 65.1 | 325.9 → 330.4 / 341.0 |
| busy city, greedy | 558 → 518 / 525 | 488 → 536 / 524 | 107.1 → 114.7 / 115.1 | 292.9 → 308.7 / 302.0 |
| busy city, batched | 656 → 650 / 626 | 383 → 385 / 401 | 107.2 → 113.3 / 114.8 | 295.4 → 305.1 / 304.6 |
| heavy, greedy | 235 → 205 / 212 | 1,358 → 1,389 / 1,382 | 186.8 → 186.2 / 186.6 | 261.9 → 291.1 / 268.8 |
| heavy, batched | 421 → 411 / 393 | 1,160 → 1,166 / 1,181 | 124.2 → 124.1 / 122.2 | 308.8 → 318.6 / 330.8 |
| heavy 2x2, greedy | 277 → 259 / 263 | 1,316 → 1,332 / 1,327 | 184.7 → 185.1 / 180.4 | 282.0 → 293.7 / 297.3 |
| heavy, surge on, greedy | 229 → 199 / 201 | 991 → 1,034 / 1,023 | 174.5 → 181.0 / 178.8 | 269.1 → 275.1 / 280.8 |
| heavy, pooling on, greedy | 382 → 353 / 344 | 1,200 → 1,220 / 1,234 | 150.0 → 147.5 / 149.6 | 339.5 → 351.8 / 358.4 |
| spec, ratings on, greedy | 474 → 470 / 473 | 20 → 24 / 20 | 61.9 → 62.6 / 66.6 | 323.8 → 330.5 / 337.9 |
| heavy, shifts, picky, batched | 275 → 255 / 260 | 1,320 → 1,335 / 1,333 | 76.6 → 76.8 / 76.7 | 300.5 → 309.6 / 303.4 |

(Heavy with surge on: declined 400 → 391 / 394.) 10k drivers (2 × 5,000, 1,500 req/min, 1,800 ticks, city), off → `river` / `canals`:

| Scenario | Completed | Cancelled | Ticks to pickup | Ride |
| --- | --- | --- | --- | --- |
| greedy | 32,764 → 32,021 / 30,978 | 2,931 → 3,538 / 4,642 | 68.2 → 70.6 / 72.1 | 290.2 → 300.6 / 303.7 |
| batched | 33,232 → 32,510 / 31,546 | 2,622 → 3,115 / 4,170 | 63.1 → 64.7 / 65.2 | 290.4 → 300.8 / 304.0 |
| greedy, surge on | 34,343 → 32,584 / 32,855 | 505 → 883 / 891 | 32.3 → 36.2 / 34.6 | 290.0 → 300.0 / 304.1 |
| greedy, pooling on | 34,527 → 33,874 / 33,486 | 572 → 841 / 1,083 | 48.8 → 55.0 / 54.6 | 307.4 → 320.8 / 324.7 |

(Surge on at 10k: declined 2,003 → 3,443 / 3,097.) Roads cost what they should: rides 3-11% longer, a few percent fewer trips completed, more cancellations. The bigger effect is where drivers are: shortest paths funnel through bridges, so drivers gather near rivers and in central districts. At 600k with `canals` after 200 ticks, the 16 districts hold 7,454 (a corner) to 98,405 (a central one) drivers, and there are 4.09 drivers per cell within 5 cells of a river against 0.52 at 55 cells or more (2.4 everywhere with roads off). Corner districts run short of idle drivers, so some pickups' nearest idle driver is across a river.

Cost, `bun run bench --drivers 600000 --ticks 300` (uniform, spec ratio, greedy, `1x1`), two rounds alternating master, spike off, `canals`, `river` on one machine (Apple M1 Pro):

| Run | Master | Off | `canals` | `river` |
| --- | --- | --- | --- | --- |
| mean ms per tick | BENCH600_MASTER | BENCH600_OFF | BENCH600_CANALS | BENCH600_RIVER |
| p95 ms | BENCH600_MASTER_P95 | BENCH600_OFF_P95 | BENCH600_CANALS_P95 | BENCH600_RIVER_P95 |
| peak RSS MiB | BENCH600_MASTER_RSS | BENCH600_OFF_RSS | BENCH600_CANALS_RSS | BENCH600_RIVER_RSS |

`--drivers 150000 --matching batched` (ADR 0051's limit), same alternation:

| Run | Master | Off | `canals` | `river` |
| --- | --- | --- | --- | --- |
| mean ms per tick | BENCH150_MASTER | BENCH150_OFF | BENCH150_CANALS | BENCH150_RIVER |
| p95 ms | BENCH150_MASTER_P95 | BENCH150_OFF_P95 | BENCH150_CANALS_P95 | BENCH150_RIVER_P95 |

How the search got there (`canals`, 600k greedy; each step keeps every event log identical): road distance everywhere through the old code (cell equality by road distance too): 1,522 ms mean. Equality by cell, no per-step allocations: 376 ms (100 ticks). Waypoint kept per driver (rule 4) instead of choosing the exit every step: 294 ms (100 ticks). Over 300 ticks that grew to 420 ms (p95 593): as corner districts run short of idle drivers, a search whose nearest idle driver is across a river kept widening rings by Manhattan distance, up to 37,000 candidates and 1.6M road distances per tick. A road lower bound per bucket (rule 5) brings it to the numbers above: 4.6-5.9M road distances per 25 ticks, at most 6,600 per search. Batched: skipping a solver column whose Manhattan reduced cost already can't improve, and taking dense costs from a per-driver exit-cost row, made 10k batched `canals` 12.7 s of wall time against 26-28 s (off: 8.3 s).

## Decision

We will lay a synthetic road network on the existing grid: full-length **rivers** of blocked cells crossed only at **bridges**, cutting the grid into rectangular **districts**. Road distance is exact and never less than Manhattan distance, computed in a few array reads from a small precomputed table; drivers drive shortest paths; every exact search stays exact. Off by default; with roads off nothing changes.

1. **Network**: a river is a whole row or column of cells no one may enter or stop on, except its bridges. A bridge is a river cell crossed straight across, from one **landing** (the road cell before it) to the other, in 2 moves; bridges are at least 2 cells apart and clear of other rivers, so they are entered only from their landings. Rivers cut the grid into districts, open rectangles. A **road cell** is a cell of a district (not a river, not a bridge): every pickup, dropoff, driver start, wander and chase target is one. Drivers may stand on a bridge only mid-crossing.
2. **Presets, not generated per run**: `--roads off|river|canals` (default `off`). `river`: one horizontal river near the middle, 4 bridges. `canals`: 3 horizontal and 3 vertical rivers near the quarter lines, 16 districts, 2 bridges on each district side between two rivers (48). River lines are jittered by up to 20 cells and each bridge drawn within its share of its stretch, from a fixed seed per preset (`roads:<name>`), never the run's seed, as a pure function of (name, grid). Every process builds the same network from the name alone (`ROADS` for `bun run dev` and `bun run ui`, as `REGIONS` is); every seed of a run gets the same city, so runs compare.
3. **Road distance** (`src/shared/roads.ts`): within a district, Manhattan. Between districts: the least, over the start district's landings p, of Manhattan to p + 2 across p's bridge + the precomputed landing-to-landing distance to an entry landing q of the target district + Manhattan from q. Landing-to-landing distances are computed once per network (Floyd-Warshall over 2 landings per bridge: 96 × 96 for `canals`); a query costs landings of one district × landings of the other (at most 8 × 8 for `canals`), and a district pair costs nothing when equal. Exact (BFS-checked) and symmetric. Every distance the simulation uses becomes road distance: pickup distance and ETA, match cost (0057), join ETA, detour limit and join reach (0058), picky drivers' max pickup distance (0035), fares and riders' direct distance (0054, 0056, 0057), the invariant checker's one-move-per-tick check. Geometry stays geometry, unchanged: regions, surge zones and their pricing, zone distance and chase reach (0055: a surge area within 4 zones may be farther by road; accepted, chase reach is a heuristic), hotspot radius (Manhattan, its off-road cells redrawn), heatmap tiles.
4. **Moving**: within a district today's rule (larger remaining axis first; a rectangle keeps every step inside). Toward another district: the driver keeps a **waypoint**, the exit landing on a shortest path (least Manhattan to it + its exit cost, ties to the lowest landing), chosen when its target changes or it enters a district, and steps toward it by today's rule; at the waypoint it steps onto the bridge, and across. Each step lowers the remaining road distance by exactly 1, so a driver arrives in road distance ticks (ETA exact, as today). The shard keeps waypoints by driver index in its state (one `Int32Array`, ADR 0033: owned containers), not in messages.
5. **Nearest-driver index stays exact** (0036, 0048, 0057): the ring search keeps its Manhattan ring bound (a valid lower bound) and adds a per-bucket road lower bound: for a bucket in the pickup's district, Manhattan; else the least, over the bucket's district's landings, of the gap from the bucket to the landing + the landing's exit cost toward the pickup; bridges inside a bucket exactly. A bucket whose bound exceeds the best found is skipped before its drivers are read. A pickup's exit costs (one per landing) are computed once per search, and held per trip for a batch. No approximation: the driver found is the one of least road distance (match cost), ties to the lowest ID. `bestPartner` (0058) keeps its bound the same way (join ETA ≥ road distance to the pickup ≥ Manhattan).
6. **Batched matching stays exact** (0030, 0051): the sentinel uses the network's bound on road distance instead of width + height − 2; untouched candidates come from the index (rule 5); a touched column whose reduced cost by Manhattan distance can't improve its key is skipped before the road distance; the dense path takes costs from each driver's exit-cost row.
7. **Messages and persistence**: no new message or field; cells on messages are road cells (or a bridge mid-crossing in `drivers.moved`). No ClickHouse change: the network is configuration, like the region layout; `bun run report` is unchanged. Replay republishes events unchanged; the viewer sets the UI's `ROADS` (as `REGIONS`) to draw the network.
8. **Invariants** (spec, checker, which takes the network): `driver_off_road`, a driver reported on a river cell that is not a bridge; `trip_off_road`, a `trip.requested` whose pickup or dropoff is not a road cell; a move is at most one cell by road distance (`driver_moved_too_fast` catches a step across a river).
9. **Switch and outputs**: `--roads off|river|canals` for `bun run sim`, `bun run bench` and `bun run loadtest`, `ROADS` for `bun run dev` (every process), `SimConfig.roads`. `bun run sim -- --compare-roads`: the configured run with roads off and with its `--roads` network (`canals` when off), side by side; with roads on the summary also prints mean ticks from pickup to completion (as pooling does). Off: no network built, no redraw, no waypoint array, today's code on every hot path; every output and event log byte-identical.
10. **UI**: rivers drawn as water-colored lines one cell wide with bridges as gaps, under drivers, in both draw modes, from `bun run ui`'s `ROADS`. Trip lines stay straight pickup-to-dropoff (dots mode). No panel change.
11. **Performance**: with roads off, every hot path runs today's code (bench above). With roads on, the slicing gates each hot path; the realistic live limit is measured, not promised: at about +15% (`canals`) and +7% (`river`) per tick in process at 600k, greedy `1x1` 600k is marginal live with roads on, so the live check measures 600k and 500k.

Out of scope, deliberately: imported maps (OpenStreetMap or any file), one-way streets, road speeds, arterials and congestion, turn costs, rivers that end or bend, obstacles inside districts (parks), routes drawn in the UI, networks generated per run seed, the network stored with a run.

## Rationale

- **Rectangles keep Manhattan inside**: with full-length rivers every district is an open rectangle, so road distance within one is exactly today's distance and today's step rule stays on a shortest path. Only crossings need a table, and it has one row per landing (96 for `canals`), not one per cell. That is why distance stays a few array reads, ETA stays exact, and off can be literally today's code.
- **Never less than Manhattan**: every exact search we have (ring search, ADR 0051's untouched candidate, the partner search) bounds areas by Manhattan distance. Road distance ≥ Manhattan keeps all of them exact without new structures; the per-bucket bound only makes the skip tighter, and the spike's event logs are identical with and without it.
- **Presets**: a preset name is all a process needs to agree on the network; a run seed would have to reach the UI and every process, and would make seeds incomparable. Two presets show a light and a dense network; adding one is data.
- **Waypoint per driver**: choosing the exit every step costs up to 64 additions per moving driver per tick (82 ms per tick at 600k in the spike); a kept waypoint is one array read, and stays on a shortest path because each step lowers the cost through it by exactly one.
- **Effect size**: rides are 3-11% longer and completions drop a few percent at 10k. Small, as a city with good bridges should be; the visible change is supply piling up near bridges and central districts, which the UI shows.

## Alternatives considered

- **Import OpenStreetMap**: a new dependency and an external download; a graph of ~10⁵ nodes where exact distances need a search per query (or contraction hierarchies), the nearest-driver search loses its cheap exact bound, and every cell-based structure (moves, regions, zones, heatmap, UI) would need rework. Rejected.
- **Arbitrary blocked cells (parks, irregular blocks) with BFS or A\***: districts stop being rectangles, so exact distance needs a search per query; all-pairs over 250k cells is impossible. Rejected.
- **Landmark (ALT) or zone-level heuristic distances**: cheap, but lower bounds or approximations: ETAs wrong, matching inexact, and drivers still need a route. Rejected.
- **Next-hop tables per destination**: 250k destinations × 250k cells. Rejected; the waypoint gives the next hop from the landing table.
- **Road distance in the ring search with only the Manhattan ring bound**: exact but 420 ms per tick (p95 593) at 600k once districts run short of idle drivers. Rejected for the per-bucket bound.
- **One-way streets or road speeds**: asymmetric or weighted distance breaks "distance = ETA = moves" and the search bounds' simplicity for little portfolio value. Out of scope.

## Consequences

- **Shared**: `src/shared/roads.ts` owns the network, road distance, the bucket bound and the next step; callers ask it, never the landing table. `distance` call sites take the network (null: roads off, today's Manhattan).
- **Dispatch**: the index's searches and the batched solver take road distances and the bucket bound; pooling's rules take the network. With roads off, today's code.
- **Drivers**: a waypoint array per shard, placement and targets on road cells, steps via the network.
- **Riders**: pickups and dropoffs on road cells (redrawn from the same stream), fares and direct distance by road.
- **Determinism**: redraws come from the stream that drew the rejected cell, so with roads off no draw shifts, and with roads on two runs of one seed give one event log.
- **Regions**: unchanged tiles; a busy driver's road may leave its trip's region, as today's moves may; every region's dispatch builds the whole network (about 1 MB: a bridge index per cell plus the landing table) and a pickup exit-cost cache (at most 4,096 rows × 96 landings).
- **Memory**: per driver shard 4 bytes per driver for waypoints (2.4 MB at 600k); bench peak RSS within run-to-run noise.
- **Performance**: roads on costs about +15% per tick at 600k greedy (`canals`) and more in batched (+BATCHED_PCT at 150k); the live check finds the realistic limit. Risks: a preset with far fewer bridges widens searches again (the bucket bound is what keeps it in check).
- **Docs**: spec World, invariants and milestone 33; README `--compare-roads` table; architecture (network in shared, waypoints in drivers); domain skill (World: road network terms); `docs/ui.md`.

Domain terms (domain skill, in this change): **Road network**, **River**, **Bridge**, **Landing**, **District**, **Road cell**, **Road distance**, **Waypoint**.

Implementation slicing (each PR keeps roads-off outputs and event logs byte-identical to master on the README seeds and names its tests). #336b, #336d and #336e also gate on cost: `bun run bench --drivers 600000 --ticks 300` (and `--matching batched --drivers 150000` for #336e) with roads off, two runs each alternating with master, mean ms per tick and peak RSS within run-to-run noise of master's; roads on is gated where its hot path lands, with a bench-only switch until #336g (the PR picks the mechanism): #336b (driver moves) and #336d (greedy search) at most +20% over roads off at 600k with `canals`, #336e (batched) at most +40% at 150k; #336g repeats them with `--roads`.

1. **Road network vocabulary** (#336a): `src/shared/roads.ts`: presets, districts, landings and their table, road distance, exit costs and the bucket bound, the next step with a waypoint, road cells. Tests: road distance equals BFS over drivable cells for both presets (from road cells and bridges, both directions), the bucket bound never exceeds the least road distance into a bucket, steps land on a drivable 4-neighbor one closer, a driver keeping its waypoint arrives in exactly the road distance, presets the same for any run seed, bridges at least 2 apart and clear of other rivers. No behavior change.
2. **Drivers drive on roads** (#336b): driver shard `roads` config; placement, wander and chase targets on road cells (redrawn from the same stream); steps by the network with waypoints in shard state; picky max pickup distance by road. Tests: driver brain (a step toward a cell across a river heads for the waypoint, crosses in 2 moves, arrives in road distance ticks; redraws; roads off unchanged; determinism); the bench gates. Nothing turns it on.
3. **Riders request on roads** (#336c): pickups and dropoffs on road cells (uniform and hotspots), direct distance and fares by road distance, rating detour by road. Tests: rider brain and demand (no off-road pickup or dropoff, redraw from the same stream, fare by road distance, roads off unchanged).
4. **Dispatch matches by road distance** (#336d): dispatch `roads` config; the index's nearest and partner searches by road distance with the bucket bound; greedy pickup distance and match cost; pooling's join ETA, detour limit and join reach by road. Tests: idle-drivers (search equals a linear scan by road distance over random fleets for both presets, with and without ratings, ties to the lowest ID), dispatch brain (a nearer driver across a river loses to a farther one on the pickup's side), pool rules by road; the bench gates.
5. **Batched on roads** (#336e): the sentinel from the network's bound, the Manhattan skip, dense costs by road. Tests: matching (by-nearest equals the dense solver's total on random instances by road distance), dispatch batched; the bench gates.
6. **Off-road invariants** (#336f): the checker takes the network; `driver_off_road`, `trip_off_road`, steps by road distance; spec invariants. Tests: checker cases (driver on a river cell, on a bridge allowed, a step across a river, an off-road pickup and dropoff).
7. **Switch roads on** (#336g): `SimConfig.roads`, `--roads` (sim, bench, loadtest), `ROADS` (dev), `--compare-roads`, the summary's ride line. Tests: args and config, summary, system tests in process (greedy, batched, `2x2`, surge, pooling and ratings on: invariants, determinism, 1% loss) and over NATS (invariants); the roads-on bench gates. Docs: README table (numbers match this spike), spec, architecture.
8. **Draw roads** (#337a): the UI draws rivers and bridges in both draw modes from `ROADS`; `ROADS=canals bun run demo`. Tests: render pure seams (river and bridge geometry from the network); screenshot. Docs: README demo, `docs/ui.md`.
9. **Live check** (#337b): live greedy `1x1` with `ROADS=canals`, 600k and 500k, two runs each, against milestone 32's with roads off on the same CPU model; `docs/performance.md`; spec milestone 33 done.
