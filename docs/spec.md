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
| driver (×2, 50 drivers each, fixed shard) | driver position, state | moves drivers each tick, answers offers, reports arrivals |
| rider | riders, demand generator | spawns riders (Poisson, random cells), requests trips, cancels on lost patience |
| dispatch (single) | trips | queues requests, matches, owns every trip transition |
| persister (later) | — | writes all events to ClickHouse |
| UI (browser) | — | renders a view built from events |

Nobody owns "the world". Views (dispatch's driver positions, UI) are built from events.

## Trip lifecycle (0018)

1. Rider spawns at a random cell with a random dropoff and patience (random 120–300 ticks). Sends `request_trip` to dispatch -> reply `request_trip_accepted` + `trip.requested`. A trip ID dispatch already knows -> reply `request_trip_rejected` (`duplicate_trip_id`, e.g. after a rider service restart), no event; rider removed.
2. Dispatch queues it (FIFO). Each tick, for each queued trip without a pending offer: pick nearest known-idle driver with no pending offer and not already offered this trip (ties by driver ID), send offer (expires after 3 ticks without reply). At most one pending offer per trip and per driver.
3. Driver accepts if idle, else declines. Accept -> `trip.matched`, driver `en_route`. Decline (`trip.offer_declined`) or timeout (`trip.offer_expired`, frees a driver that accepted late) -> try next candidate next tick; the trip keeps its FIFO position. Replies to declined, expired, or unknown offers are ignored.
4. Driver drives to pickup, publishes `driver.arrived_at_pickup` once, waits (`at_pickup`). Dispatch -> `trip.picked_up` (driver `on_trip`).
5. Driver drives to dropoff, publishes `driver.arrived_at_dropoff` once, waits (`at_dropoff`). Dispatch -> `trip.completed`, driver `idle`, rider removed.
6. Rider patience expires before pickup -> `cancel_trip` to dispatch -> reply `cancel_trip_accepted` + `trip.cancelled` (driverId = driver to free: the matched driver or the one holding a pending offer, null if none), that driver `idle`, rider removed. A pending offer is dropped; a late reply to it is ignored. Trip picked up, completed, already cancelled, or unknown -> reply `cancel_trip_rejected` (`invalid_transition` / `unknown_trip`), no event. Rider: completed or cancelled trip -> removed, even if riding (its trip event was lost); unknown trip -> cancelling rider removed (request lost); picked up -> waits for `trip.picked_up` / `trip.completed`.
7. Races resolved by dispatch: whichever of arrival / cancel reaches dispatch first wins. Arrival first -> picked up, cancel rejected. Cancel first -> cancelled, arrival ignored.

Idle drivers wander: pick a random target cell, drive there, repeat. All 100 drivers online the whole run. A crashed driver shard's drivers just disappear.

## Invariants (system tests)

- A driver has at most one active trip.
- Trip states only follow legal transitions.
- `trip.picked_up` only when the driver is at the pickup cell; `trip.completed` only at dropoff.
- A driver moves at most 1 cell per tick and stays inside the grid.
- Every completed trip was matched and picked up.
- A `trip.cancelled` naming a driver comes after that trip's `trip.offered` to that driver (else the driver could get stuck).
- A `trip.cancelled` names the driver to free: the matched driver, else the driver holding the pending offer, else null.

Checked from the event log alone by `checkInvariants` (`src/sim/invariants.ts`), independent of brain code.

## UI (0020)

Watch-only, live-only. Browser canvas: drivers as dots colored by state, waiting riders as markers, active trip lines. Side panel: counts per state, avg wait time. Interpolates between ticks.

## Milestones

1. **Brains**: domain types + pure seeded decision functions for driver, rider, dispatch. TDD.
2. **In-process**: all services in one process over an in-memory bus, headless, invariant checker, run summary printed (`bun run sim`).
3. **Distributed**: same services over NATS as separate processes. Infra in Docker, `bun run dev` spawns services. Done: NATS runs break no invariant (`bun run sim -- --bus nats`).
4. **UI**: live canvas view.
5. **Persistence**: persister -> ClickHouse, first analytics queries.

## Later (not v1)

Batched matching (compare wait times), driver preferences / rejections, shifts (online/offline), hotspot demand, scaling to 10k+ drivers, replay. Pricing, surge, ratings, real roads, pooling stay out of scope.
