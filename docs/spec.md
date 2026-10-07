# Spec (v1)

What we build and why. Decisions behind it: ADRs linked inline. Terms: `.claude/skills/domain/SKILL.md`.

## Purpose

Learning, exploring, portfolio demo. Demo moment: watch a live city of drivers and riders in the browser.

## World

- Grid 500 × 500 cells, 1 cell = 10 m, so 5 × 5 km city. Manhattan distance, 4-neighbor moves. (0016)
- Tick = 1 s sim time. Driver speed 1 cell/tick = 36 km/h.
- Moving toward a target: step along the axis with the larger remaining distance first.
- Scale v1: 100 drivers, ~10 trip requests/min (configurable). Rough math: avg trip ~333 cells (~5.5 min), pickup ~30–60 s, fleet capacity ~15 trips/min.

## Services (0017)

Independent processes, each owning its state, talking over NATS. Each service's decision logic is a pure, seeded "brain"; only the system as a whole is nondeterministic.

| Service | Owns | Does |
| --- | --- | --- |
| clock | tick counter | publishes `clock.ticked` every 1 s / speed |
| driver (×2, 50 drivers each, fixed shard) | driver position, state | announces drivers going online (one `drivers.went_online` per up to 5,000 drivers, first in the tick, 0049), moves drivers each tick (one `drivers.moved` per up to 5,000 moves, as parallel arrays of driver IDs and coordinates, before its other events of the tick, 0045, 0047), answers offers, reports arrivals |
| rider | riders, demand generator | spawns riders (Poisson; pickups uniform or around hotspots, 0031), requests trips, cancels on lost patience |
| dispatch (single) | trips | queues requests, matches, owns every trip transition |
| persister | stream position (JetStream consumer) | writes all events to ClickHouse, at-least-once |
| UI (browser) | — | renders a view built from events |

Nobody owns "the world". Views (dispatch's driver positions, UI) are built from events. Dispatch learns a driver from its `drivers.went_online` entry or, if it missed that (it subscribed after the shard started, 0043), from its first `drivers.moved` entry.

## Trip lifecycle (0018)

1. Rider spawns at a random cell with a random dropoff and patience (random 120–300 ticks). Sends `request_trip` to dispatch -> reply `request_trip_accepted` + `trip.requested`. A trip ID dispatch already knows -> reply `request_trip_rejected` (`duplicate_trip_id`, e.g. after a rider service restart), no event; rider removed.
2. Dispatch queues it (FIFO). Each tick, for each queued trip without a pending offer: pick nearest known-idle driver with no pending offer and not already offered this trip (ties by driver ID), send offer (expires after 3 ticks without reply). At most one pending offer per trip and per driver. Alternative (`batched`, 0030): only on ticks where `tick % windowTicks === 0`, match all such trips and drivers at once, as many pairs as possible with least total pickup distance; offers sent in trip FIFO order. Expiry is still checked every tick; declined or expired trips wait for the next window. Greedy is the default.
3. Driver accepts if idle, else declines. With picky preferences (0035) an idle driver also declines an offer whose pickup is beyond its max pickup distance, or at random (`declineShare`). Accept -> `trip.matched`, driver `en_route`. Decline (`trip.offer_declined`) or timeout (`trip.offer_expired`, frees a driver that accepted late) -> try next candidate next tick; the trip keeps its FIFO position. Replies to declined, expired, or unknown offers are ignored, and so is a `driver.arrived_at_pickup` from a driver whose offer for that trip expired: under load its accept can reach dispatch after the expiry, and the driver can reach the pickup before `trip.offer_expired` frees it (#173).
4. Driver drives to pickup, publishes `driver.arrived_at_pickup` once, waits (`at_pickup`). Dispatch -> `trip.picked_up` (driver `on_trip`). Every 10 ticks after arrival without a trip event (e.g. its arrival or `trip.picked_up` was lost), the driver sends `confirm_trip` (stage `pickup`, its cell); dispatch runs it as the arrival, or replies `trip_status`: `picked_up` -> driver `on_trip`, `released` (trip cancelled, expired, unknown, or another driver's) -> driver `idle` at the pickup, no event (0041).
5. Driver drives to dropoff, publishes `driver.arrived_at_dropoff` once, waits (`at_dropoff`). Dispatch -> `trip.completed`, driver `idle`, rider removed. Same confirm every 10 ticks without a trip event (stage `dropoff`): dispatch runs it as the arrival, or replies `completed` / `released` -> driver `idle` at the dropoff (0041). Replies for another trip or stage are ignored. In-process runs lose no messages (unless a test sets a loss share), so drivers never confirm there.
6. Rider patience expires before pickup -> `cancel_trip` to dispatch -> reply `cancel_trip_accepted` + `trip.cancelled` (driverId = driver to free: the matched driver or the one holding a pending offer, null if none), that driver `idle`, rider removed. A pending offer is dropped; a late reply to it is ignored. Trip picked up, completed, already cancelled, or unknown -> reply `cancel_trip_rejected` (`invalid_transition` / `unknown_trip`), no event. Rider: completed or cancelled trip -> removed, even if riding (its trip event was lost); unknown trip -> cancelling rider removed (request lost); picked up -> waits for `trip.picked_up` / `trip.completed`.
7. Races resolved by dispatch: whichever of arrival / cancel reaches dispatch first wins. Arrival first -> picked up, cancel rejected. Cancel first -> cancelled, arrival ignored.

Idle drivers wander: pick a random target cell, drive there, repeat. By default (shifts off) all 100 drivers online the whole run. With shifts on (`--shifts on`, `SHIFTS=on`, 0032) each driver alternates online periods of 1200-2400 ticks and offline periods of 300-900 ticks, 80% start online (about 75% online on average); a driver goes offline (`driver.went_offline`) only when idle and comes back with a `drivers.went_online` entry; dispatch makes no new offers to it in between. Dispatch's view can be stale: an offer made on the tick a driver goes offline is declined, and a `trip.cancelled` / `trip.offer_expired` / `trip.offer_declined` naming an offline driver leaves it offline. By default (preferences off) idle drivers accept every offer. With picky preferences (`--preferences picky`, `PREFERENCES=picky`, 0035) each driver gets a max pickup distance of 20-80 cells (200-800 m) at start and declines farther pickups, plus 10% of the rest at random; each decline excludes that driver for the trip. A crashed driver shard's drivers just disappear.

## Invariants (system tests)

- A driver has at most one active trip.
- Trip states only follow legal transitions.
- `trip.picked_up` only when the driver is at the pickup cell; `trip.completed` only at dropoff.
- A driver moves at most 1 cell per tick and stays inside the grid (each entry of `drivers.moved` is one move).
- Every completed trip was matched and picked up.
- A `trip.cancelled` naming a driver comes after that trip's `trip.offered` to that driver (else the driver could get stuck).
- A `trip.cancelled` names the driver to free: the matched driver, else the driver holding the pending offer, else null.
- An offline driver (from `driver.went_offline` until its `drivers.went_online` entry) never moves and is never matched (`trip.matched`). Offers to it are allowed (stale view; it declines), and events freeing it (cancel, expiry, decline) don't bring it online.
- A driver goes offline only with no active trip.

Checked from the event log alone, one message at a time, by `createInvariantChecker` (`checkInvariants` over a whole log; `src/sim/invariants.ts`), independent of brain code.

## UI (0020)

Watch-only: a live run, or a stored run's replay with `?replay=<runId>` (0034). Browser canvas: drivers as dots colored by state, waiting riders as markers, active trip lines. Side panel: counts per state, trip counters, mean ticks from request to pickup, legend, connection status and what is watched (live or replay). Interpolates between ticks.

## Milestones

1. **Brains**: domain types + pure seeded decision functions for driver, rider, dispatch. TDD. Done.
2. **In-process**: all services in one process over an in-memory bus, headless, invariant checker, run summary printed (`bun run sim`). Done.
3. **Distributed**: same services over NATS as separate processes. Infra in Docker, `bun run dev` spawns services; NATS runs break no invariant (`bun run sim -- --bus nats`). Done.
4. **UI**: live canvas view, served by `bun run ui`, subscribed to NATS events over WebSocket. Done.
5. **Persistence**: persister -> ClickHouse, first analytics queries (`bun run report`). Done.
6. **Batched matching** (0030): dispatch strategy switch (greedy | batched every N ticks, min total pickup distance), `bun run sim -- --compare` prints both on one seed. Done.
7. **Hotspot demand** (0031): rider demand model (uniform | hotspots, `city` preset), configurable demand rate and fleet size in `bun run sim` / `--compare`. Done.
8. **Driver shifts** (0032): drivers alternate online/offline periods (finish trips first), dispatch/UI/invariants handle offline drivers, `--shifts on|off`. Done.
9. **Scale to 10k drivers** (0033): profile-first (`docs/performance.md`), owned brain state for dispatch positions, rectangular matching, streaming run checks; target p95 < 1 s per tick at 10k. Done.
10. **Replay** (0034): `bun run replay -- --run <id>` republishes a stored run from ClickHouse on `replay.<id>.*`, paced by tick; the UI watches it with `?replay=<id>`. Done.
11. **Driver preferences** (0035): drivers decline offers beyond a per-driver max pickup distance or at random (`picky` preset, `--preferences off|picky`). Done.
12. **Scale to 50k drivers** (0036): indexed brain state, spatial driver lookup in dispatch, exact results; target unprofiled p95 < 1 s per tick at 50k (two CI runs each). Done.
13. **Live limits** (0037): `bun run loadtest` runs the distributed stack at real time and reports settle latency, persister backlog, and NATS slow consumers; find the largest live fleet that keeps up. Done: 10k greedy, at least 10k batched, limited by the persister ([Live limits](performance.md#live-limits)).
14. **Persister throughput** (0038): `bun run loadtest` judges the persister by its backlog in ticks of events; time the persister's rounds, raise its write throughput where the timing points, re-measure live limits. Target: live greedy 20k keeps up (two CI runs), or the new first limit identified. Done: 25k greedy, 20k batched; settle fails first now, the persister next ([After milestone 14](performance.md#after-milestone-14)).
15. **Lost-message recovery** (0041): drivers waiting at the pickup or dropoff confirm their trip with dispatch (`confirm_trip` / `trip_status`), replacing the pickup wait timeout; a lossy in-memory bus shows trips still end when messages are dropped. Done: at 1% loss every waiting driver moves on within 3 confirm rounds and every invariant holds; without confirms drivers and trips get stuck (riders are not recovered).
16. **Live capacity**: raise the live stack's limit past greedy 25k / batched 20k, where settle fails first. Time each service's decoding vs handling of bus messages and which publisher closes each tick, then change where the timing points, re-measure. Target: live greedy 40k keeps up (two CI runs), or the new first limit identified. Done: 32.5k greedy, 32.5k batched; 40k not met (2 of 4 runs pass). The persister's backlog fails first now, settle not until 50k ([After milestone 16](performance.md#after-milestone-16)).
17. **Persister under load**: raise the live limit past greedy 32.5k / batched 32.5k, where the persister's backlog fails first. Report the NATS server's and ClickHouse's CPU in the load test, change what that CPU budget points to, re-measure. Target: live greedy 40k keeps up (two CI runs), or the new first limit identified. Done: 35k greedy, 32.5k batched; 40k not met (2 of 4 runs pass). The persister's backlog still fails first for greedy, on slower runners, mostly at the run's large ClickHouse merge; batched fails settle first ([After milestone 17](performance.md#after-milestone-17)).
18. **One positions message per shard**: raise the live limit past greedy 35k / batched 32.5k by cutting per-message work: every driver publishes one `driver.moved` per tick, so N drivers mean N messages per tick through NATS, dispatch, the persister (N rows), and ClickHouse merges. Measure `driver.moved`'s share of each process's work, decide the message shape in an ADR, implement it end to end, re-measure. Target: live greedy 45k keeps up (two CI runs), or the new first limit identified. Done: 200k greedy (4 of 4 runs), 45k batched (35k and 45k pass twice each; 40k fails only the persister backlog bound, in both runs, while the persister keeps up, so not every size below 45k passes). Greedy fails settle first now, set by dispatch's per-tick work (225k passes 2 of 4); batched fails settle at 50k. 40k fails the bound because a backlog unit is now one message and the persister holds about two seconds of messages in flight ([After milestone 18](performance.md#after-milestone-18)).
19. **Dispatch per tick**: raise the live greedy limit past 200k, where settle fails first, set by dispatch's per-tick work on one thread (profiled at 200k: about half decoding `drivers.moved`, 35-36% its `clock.ticked` step, 10-11% position updates). Profile dispatch, cut the largest part, re-measure; splitting dispatch across processes is out of scope. Target: live greedy 300k keeps up (two CI runs), or the new first limit identified. Done: 325k greedy (4 of 4 runs; 300k 4 of 4), 50k batched (4 of 4). Greedy still fails settle first, set by dispatch, now mostly decoding and applying `drivers.moved` (350k passes 3 of 4, fails on the EPYC 7763); from 375k dispatch is also a NATS slow consumer in the drivers' startup burst of `driver.went_online`. Batched fails settle at 55k ([After milestone 19](performance.md#after-milestone-19)).
20. **Dispatch moves**: raise the live greedy limit past 325k by cutting dispatch's per-tick work again. At 325k, 74-79% of dispatch's time per tick is `drivers.moved` (decoding and applying moves about equal), 51-82 ms its `clock.ticked` step, on one thread while the runner has cores to spare. Profile dispatch at 325k-400k, cut where the profile points, re-measure. Target: live greedy 400k keeps up (two CI runs), or the new first limit identified. Done: 400k greedy (4 of 4 runs), 50k batched (4 of 4). Greedy still fails settle first, set by dispatch's per-tick work, decoding and applying `drivers.moved` about equal (425k passes 5 of 6, 450k 4 of 6, failing on the EPYC 7763); no slow consumers up to 600k. Above about 447k drivers the riders' request draw caps demand below the spec ratio (a bug, fixed in [#246](https://github.com/kludw/uber-simulator/issues/246), [Request draw cap](performance.md#request-draw-cap)). Batched fails settle at 55k ([After milestone 20](performance.md#after-milestone-20)).
21. **Dispatch by region**: split dispatch across processes by region so the live limit is no longer one dispatch thread. Each dispatch instance owns the trips and drivers of its region; trips near region borders and drivers crossing regions need a defined handoff. Design first (ADR), then implement, then re-measure. Decided in 0050: regions are `columns × rows` tiles of the grid (default `1x1`, today's behavior); a trip belongs to its pickup's region; driver shards route each driver's messages to the region that owns it (an idle driver's previous cell, a busy driver's trip), so crossing a border needs no extra message; matching stays within a region (no cross-border search); every invariant stays global. Target: live greedy 500k keeps up (two CI runs) with dispatch split, or the new first limit identified; in-process outcomes may change only as the ADR states (e.g. border trips), with invariants holding.
22. **Cheaper batched matching**: raise the live batched limit past 50k. Batched matching is exact (0030), its cost grows with trips x idle drivers, and it fails settle at 55k. Consider each trip's k nearest idle drivers only: inexact, so it changes results; decided in an ADR with the measured quality cost. Target: live batched 100k keeps up (two CI runs) with a measured, documented quality cost against exact matching, or the new first limit identified.

## Later (not v1)

Pricing, surge, ratings, real roads, pooling stay out of scope.
