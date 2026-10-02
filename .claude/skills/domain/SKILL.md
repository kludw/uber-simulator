---
name: domain
description: Domain glossary for the uber-simulator - world, grid, services, riders, drivers, dispatch, trips, offers, states, events, commands. Use whenever naming types, functions, tests, events, NATS subjects, or ClickHouse tables/columns, or discussing simulation behavior.
---

# Domain

Code, tests, events, subjects, tables all use these exact terms. No synonyms (`passenger`, `car`, `ride`, `job` are not terms here).

Living document. New concept in code = add term here in same change. Meaning shifts = update here and rename in code. Entries marked (draft): confirm with me before relying on them.

## World

- **World**: the simulated city. No single owner; each service owns its part, views built from events (0017).
- **Grid**: synthetic square grid, `width × height` cells (v1: 500 × 500, 1 cell = 10 m). No real maps for now.
- **Cell**: one grid square, integer `x`, `y`. Origin top-left, `0 ≤ x < width`, `0 ≤ y < height`.
- **Position**: an entity's current cell.
- **Distance**: Manhattan distance between cells, `|x1 - x2| + |y1 - y2|`.
- **Move**: one step to a 4-neighbor cell (no diagonals). Max one move per tick per driver. Toward a target: larger remaining axis first.
- **Tick**: one discrete simulation step, 1 s sim time, published by the clock. See `simulation` skill.

## Services

- **Service**: independent process owning part of the world, talking only via the bus (0017).
- **Brain**: a service's pure, seeded decision logic. **Shell**: its I/O around the brain.
- **Bus**: messaging port; in-memory or NATS adapter.
- **Runner**: starts all services and drives ticks; in-process, it is the clock (0027).
- **Event log**: every published message of a run, in publish order.
- **Summary**: a run's headline numbers (trip counts, mean ticks from request to pickup, rejected inputs, invariant violations), computed from its event log.
- **Input rejected**: brain output for an input addressed to one of its entities but invalid for that entity's state. Logged by the shell, never published.
- **Violation**: a broken spec invariant (`docs/spec.md`) found in an event log, tagged by `type` (e.g. `illegal_trip_transition`).
- **Clock**: service publishing ticks.
- **Shard**: fixed set of drivers owned by one driver service instance.
- **Dispatch**: service owning all trips; matches trips to drivers (0018).
- **Demand generator**: part of the rider service; spawns riders (Poisson).

## Actors

- **Rider**: requests one trip, then is removed (after `completed` or `cancelled`, or when dispatch says the trip can't proceed). States:
  - `waiting` (trip requested) -> `riding` (picked up).
  - `waiting` | `cancelling` -> removed on `request_trip_rejected`.
  - `waiting` -> `cancelling` (patience ran out, sent `cancel_trip`, awaiting dispatch's outcome) -> removed on `trip.cancelled` or `cancel_trip_rejected` (`unknown_trip`), or `riding` if pickup won the race.
  - `cancelling` | `riding` -> removed on `cancel_trip_rejected` (`invalid_transition` from `completed` / `cancelled`): trip already over.
- **Patience**: ticks a rider waits for pickup before cancelling.
- **Driver**: fulfills trips. States:
  - `offline` -> `idle` (available) -> `en_route` (heading to pickup) -> `at_pickup` (arrived at pickup, waiting for dispatch) -> `on_trip` (rider aboard) -> `at_dropoff` (arrived at dropoff, waiting for dispatch) -> `idle`.
  - `idle` -> `offline`. (v1: all drivers stay online.)
- **Wander target**: random cell an idle driver drives toward; new one picked on arrival.

## Trip

- **Trip**: one rider's journey from pickup cell to dropoff cell. States:
  - `requested` -> `matched` -> `picked_up` -> `completed`.
  - `requested` | `matched` -> `cancelled`.
- **Pickup** / **Dropoff**: trip start / end cells.
- **Matching**: assigning an idle driver to a requested trip. v1: nearest known-idle driver, ties by driver ID.
- **Ordered by ID**: plain string comparison of IDs (default `toSorted()`, so `d-10` < `d-2`). Every brain uses it for iteration order and tie-breaks.
- **Offer**: dispatch asking one driver to take a trip; driver accepts or declines, or the offer expires (3 ticks). Message `offer` (tripId, driverId, pickup, dropoff); driver replies `offer_accepted` or `offer_declined` (tripId, driverId). Replies are not events: dispatch turns them into `trip.*` events.
- **Excluded drivers**: drivers that declined or let an offer expire for a trip; never offered that trip again, and their late replies for it are stale (ignored).
- **Command**: request to the owner of some state (`request_trip`, `cancel_trip` to dispatch). Events are facts; commands may be rejected. Dispatch replies to the sender (not an event): `request_trip_accepted` (tripId), or `request_trip_rejected` (tripId, `error` tagged by `type`, e.g. `duplicate_trip_id`). Same for `cancel_trip`: `cancel_trip_accepted` / `cancel_trip_rejected` (`unknown_trip`, `invalid_transition`).
- **ETA**: ticks until a driver reaches a cell.

## Events

1. Named `<entity>.<past-tense-verb>`:
   - `clock.ticked`
   - `trip.requested`, `trip.offered`, `trip.offer_declined`, `trip.offer_expired`, `trip.matched`, `trip.picked_up`, `trip.completed`, `trip.cancelled` (only dispatch emits `trip.*`)
   - `driver.went_online`, `driver.went_offline`, `driver.moved`, `driver.arrived_at_pickup`, `driver.arrived_at_dropoff`
2. Same name used as event `type` in code, NATS subject suffix, ClickHouse event type value.
3. Invalid state transition = domain error (see `errors` skill), never silently ignored.

## Not in scope yet

Pricing, surge, ratings, real roads/routing, multi-rider pooling. Don't model until asked.
