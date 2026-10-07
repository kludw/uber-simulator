# 0050. Split dispatch by region

- Status: Accepted
- Date: 2026-10-07
- Supersedes 0018's single dispatch instance (0018's offers and trip ownership per instance stand); extends 0028's subject scheme

## Context

At 400k drivers (greedy) dispatch takes 287-371 ms per tick on one thread, 73-78% of it `drivers.moved` (decode 119-145 ms, handle 104-127 ms), and settle fails on the EPYC 7763 once dispatch passes about 414 ms per tick ([After milestone 20](../performance.md#after-milestone-20)). Per move, decoding and handling cost about the same, so cheaper decoding alone can't double the limit. The runner has 4 CPUs; the whole stack uses 1.4-1.9 cores. Milestone 21 splits dispatch across processes.

What dispatch needs per driver: its cell while it is idle (matching, ADR 0036/0048), and its busy mark from its offer until the offer or trip is over (`storeTrip`). Arrivals and confirms carry their own cell (ADR 0018, 0041). The driver shard knows each driver's state, so it knows whether a driver is idle or serving a trip, and that trip's pickup (from the offer).

Spike on the unmerged branch `236-exp-region-spike` (`26cdc27`): one dispatch in process, nearest search and batches restricted to the pickup's region, drivers declining offers from a region other than their cell's. It doesn't model the one-tick handoff lag below. `bun run sim -- --compare`, seed 42, completed trips greedy / batched (mean ticks request to pickup):

| Layout | README spec load (100 drivers, 3,600 ticks) | README heavy load (city, 50 drivers) | 10k drivers, 1,000 req/min, 1,800 ticks |
| --- | --- | --- | --- |
| 1x1 (today) | 477 / 474 (61.1 / 62.0) | 235 / 421 (186.8 / 124.2) | 24,205 / 24,189 (11.5 / 13.2) |
| 2x1 | 468 / 467 (61.1 / 61.2) | 247 / 417 (185.6 / 123.4) | 24,220 / 24,177 (11.4 / 13.3) |
| 2x2 | 472 / 481 (63.8 / 65.2) | 271 / 418 (182.5 / 118.7) | 24,223 / 24,186 (11.5 / 13.3) |
| 4x1 | 445 / 461 (61.0 / 66.2) | 288 / 398 (177.2 / 120.2) | 24,211 / 24,168 (11.5 / 13.4) |

1x1 reproduces the README exactly. At 10k (greedy runs only), 0.16% (2x1), 0.31% (2x2) and 0.38% (4x1) of drivers cross a border per tick, and 0.07%, 0.17% and 0.29% of offers are declined for being out of region.

## Decision

We will run one dispatch instance per **region**, a rectangle of the grid, and route every message dispatch takes to the one instance that owns it.

1. **Regions**: the grid split into `columns × rows` equal tiles (`--regions 2x1`, env `REGIONS`; default `1x1`), numbered row-major from 0; `regionOf(cell)` in one pure shared module (`src/shared/regions.ts`). Every service of a run gets the same layout (`SimConfig`). Instance k is `dispatch-<k>`, process env `REGION_INDEX`. Nothing checks that processes agree: a different `REGIONS` in one process misroutes silently, so the launchers (`dev`, `loadtest`, `runOverNats`) pass one value to all. The load test starts with `2x1`.
2. **Trip ownership**: the region of its pickup, for the trip's whole life (ended trips included, so late inputs get today's answers). Riders send `request_trip` and `cancel_trip` to it; a driver keeps its trip's region from the offer and sends `offer_accepted` / `offer_declined`, `driver.arrived_at_*` and `confirm_trip` (ADR 0041) to it.
3. **Driver ownership, routed by the shard**: a driver's move goes to the region that owned it before the move: an idle driver's to its previous cell's region, an `en_route` / `on_trip` driver's to its trip's region. The shard knows the trip's region from driver state: `en_route`, `at_pickup`, `on_trip` and `at_dropoff` keep the region of the offer's pickup, set when the driver accepts. `drivers.went_online` and `driver.went_offline` go to the cell's region (only idle drivers go offline, ADR 0032). Shards chunk `drivers.went_online` and `drivers.moved` per region (at most 5,000 entries each, regions in index order, ADR 0045/0049's order kept per region). No new message: an idle driver's border-crossing move reaches the old region with a cell outside it, which is the handoff.
4. **Each instance's index (ADR 0048)** covers its region only. A move or a freed driver (`markFree`) with a cell outside the region drops the driver, unless it is busy: a busy driver keeps its record (cell updated) until freed, then is dropped if still outside. A driver first seen moving inside the region is placed (ADR 0043, per region).
5. **Ownership invariant**: a driver accepts an offer only from the region its cell is in; it declines any other (a stale view after it crossed). So a matched driver is always its trip's region's, and an instance can't keep a driver it no longer owns busy. With one region every offer passes.
6. **Recovery when messages are lost (ADR 0041)**: a lost crossing move leaves the old region an idle driver at a stale cell inside it (a ghost). `offer_declined` carries `idleAt`: the driver's cell if it is idle, else null (offline, or on another region's trip). Dispatch updates the record's cell from it before `markFree`, and drops the driver on null, so the first decline that reaches the old region drops the ghost, whether the driver is idle elsewhere or busy passing through; likewise an arrival (`driver.arrived_at_*`, or `confirm_trip` standing in for one) updates its driver's cell before its trip frees it, only when the transition runs (a rejected arrival, e.g. a wrong driver, may name an idle bucketed driver) and only through `placeDriver`, the one writer of cells (it re-buckets), so a lost last move can't leave it bucketed at a stale cell. Without loss and with one region these change nothing: an idle decline's cell and an arrival's or confirm's cell equal the last move dispatch already has (same publisher, published after its moves, ADR 0045), and the only non-idle decline is an offline driver's, which dispatch already dropped on its `driver.went_offline`; with loss a ghost lives until its next delivered decline, and an expired offer (no reply) re-buckets it at its stale cell until then.
7. **Matching is region-local**: greedy takes the nearest idle driver in the trip's region; batched matches each region's queued trips and idle drivers on the same window ticks (ADR 0030 per region). No instance asks another.
8. **Subjects (extends ADR 0028)**: the ten message types in 2-3 carry a `region` field (non-negative integer; parsed with default 0, so runs stored before replay as region 0), and `subjectFor` appends `.region-<k>` to their subject (e.g. `sim.events.drivers.moved.region-1`, `sim.commands.request_trip.region-0`). `Bus.subscribe` takes an optional region: dispatch k subscribes to its region's subjects plus `clock.ticked`; every other subscriber of those types takes all regions (`.*`; the persister, UI and observer already use `sim.events.>`). Offers (`sim.offers.<driverId>`), replies to riders, `trip_status` and `trip.*` stay unregioned: trip IDs are global and every consumer is unregioned.

## Rationale

- **The work splits with the moves**: an instance decodes and handles only its region's moves (about 1/N with uniform demand) and steps only its trips. At 500k with `2x1`, about 250k moves per instance per tick at today's 0.56-0.68 µs each is 140-170 ms, plus half the step, well under the ~414 ms where settle fails; the stack has 2+ cores spare for the second process.
- **The shard is the one place that knows a driver's state**, so routing there needs no handoff protocol between instances and no new message. Routing busy drivers to their trip's region keeps ADR 0045's guarantee (a driver's cell reaches its subscriber before its arrival: same publisher, same instance) and keeps busy drivers from looking idle to the region they drive through. Routing an idle driver's move by its previous cell gives the old region the departure and the new region the driver one move later.
- **Exact is not worth it**: the spike's difference is within noise at 10k drivers at the spec demand ratio (completed within 0.1%, ticks to pickup within 0.2). Milestone 21 runs at 400k-500k, 40× denser, where idle drivers near a border are closer still, so the loss should be smaller; #237 measures it. Only the sparse README fleet shows a cost, mostly in strips (4x1: -6.7% completed greedy), and an exact cross-border search needs a per-tick round between instances. Under overload greedy even gains (235 → 247-288 completed), as region-local matching stops it sending drivers across the grid.
- **Tiles, not only strips**: `columns × rows` covers strips (`Nx1`) at no extra cost, and tiles shorten the total border for 4+ regions (2x2: 1,000 cells against 4x1's 1,500; 2x2 crosses 0.31% against 4x1's 0.38%, with fewer declines).
- **One region is today**: with `1x1` every brain's decisions and the event log are today's, plus `region: 0` on the ten types and `idleAt` on `offer_declined`.

## Alternatives considered

- **Shard dispatch by driver ID**: each instance would hold a slice of drivers spread over the grid, so every trip's nearest search needs every instance (scatter-gather per trip per tick, conflicting offers). Rejected.
- **Regions with a border overlap** (instances also track drivers within m cells of their border, exact near borders): two instances hold the same driver, so offers collide and busy marks must sync between instances; extra traffic grows with m. The loss it removes is within noise at scale. Rejected.
- **Exact nearest across borders, asking neighbours**: a request/reply round between instances each tick (ADR 0028 has none), order-dependent results. Rejected for the same reason.
- **Centralized matching with decoding on workers**: exact, but handling moves (as costly as decoding) and the step stay on one thread, and decoded moves overtake later messages of the same shard ([Dispatch moves profile](../performance.md#dispatch-moves-profile)). Decoding is 119-145 of 287-371 ms per tick at 400k, so the thread keeps about 60% of its work. Rejected; it can still be combined later.
- **Route every move by its cell, learn busy drivers from other regions' `trip.*` events**: each instance would decode every region's trip events (667 requests per tick at 400k, several events each), and border regions would see busy drivers as idle until those events arrive. Rejected.
- **Handoff messages between instances** (old region tells new region "driver d is yours"): a second path whose order against the shard's moves isn't guaranteed. Rejected: the shard routes at the source.
- **Region encoded in trip IDs** (no new field): IDs would carry routing. Rejected for an explicit field.

## Consequences

- **Outcomes with several regions** differ from one region only by: matching within the pickup's region (batched per region); a driver crossing a border, or finishing a trip outside its trip's region, unknown to its new region until its next move (1 tick, 2 if it stopped at its wander target); out-of-region declines. Measured above without the lag; #237 re-measures on the README seeds with the real implementation.
- **Invariants**: every spec invariant stays global and unchanged: each is about one trip (events from one instance) or one driver (moves from one shard, each move published once), and a driver accepts only while idle, so two instances can't both match it. None becomes per-region; the checker needs no layout. The ownership invariant (5) is a driver brain rule, tested there, not an event-log check.
- **Load balance** follows demand: hotspots (`city`) load the downtown region more. The load test uses uniform demand.
- **Shards** do a `regionOf` per move and publish up to `shards × regions` more chunks per tick (a few, against 100 at 500k).
- **Docs to change in the implementation**: domain skill (Region, Dispatch, `drivers.moved` per region), nats skill and ADR 0028's subject list via this ADR, spec services table and invariants note, architecture.

Implementation slicing (each keeps `1x1` outcomes identical and the system working):

1. **Region addressing**: `src/shared/regions.ts` (layout parse, `regionOf`, bounds); `region` on the ten types (default 0 on parse) and `idleAt` on `offer_declined`; `subjectFor` / subscription subjects; `Bus.subscribe` region option in the in-memory and NATS buses; riders set the region from the pickup (kept for `cancel_trip`); driver shards keep the trip's region from the offer in driver state and set it on replies, arrivals and confirms, cell regions on `drivers.went_online` / `driver.went_offline` / moves. Layout fixed at `1x1`. Seams: regions, messages, subjects, both buses, rider and driver brains.
2. **Shard routing for several regions**: moves by the ownership rule, chunks per region, out-of-region decline (5). Seams: driver brain with a `2x1` layout.
3. **Region-bounded dispatch**: `startDispatch` takes its region; the index covers it; outside cells drop non-busy drivers; `markFree` outside drops; declines, arrivals and confirms update the driver's cell first (6). Seams: idle-drivers, dispatch brain.
4. **Several instances in process**: `SimConfig.regions` configurable (`--regions` for `sim`, `bench`); one dispatch service per region in `runInProcess`; system tests at `2x2`: invariants, and with message loss (ADR 0041) also that no instance keeps an idle driver last seen outside its region; README outcomes on its seeds. Seams: service wiring, config, runner.
5. **Several instances over NATS**: `REGIONS` / `REGION_INDEX` env, one dispatch process per region in `runOverNats`, `dev`, `loadtest` (`--regions`, timing per instance), all from one `REGIONS` value; NATS system test: invariants at `2x1`. Seams: config, process launchers.
6. Re-measure live limits (#238).
