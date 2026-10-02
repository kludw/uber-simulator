---
name: domain
description: Domain glossary for the uber-simulator - world, grid, riders, drivers, trips, states, events. Use whenever naming types, functions, tests, events, NATS subjects, or ClickHouse tables/columns, or discussing simulation behavior.
---

# Domain

Code, tests, events, subjects, tables all use these exact terms. No synonyms (`passenger`, `car`, `ride`, `job` are not terms here).

Living document. New concept in code = add term here in same change. Meaning shifts = update here and rename in code. Draft entries marked (draft): confirm with me before relying on them.

## World

- **World**: whole simulation state at a tick.
- **Grid**: synthetic square grid, `width × height` cells. No real maps for now.
- **Cell**: one grid square, integer `x`, `y`. Origin top-left, `0 ≤ x < width`, `0 ≤ y < height`.
- **Position**: an entity's current cell.
- **Distance**: Manhattan distance between cells, `|x1 - x2| + |y1 - y2|`. (draft)
- **Move**: one step to a 4-neighbor cell (no diagonals). Max one move per tick per driver. (draft)
- **Tick**: one discrete simulation step. See `simulation` skill.

## Actors

- **Rider**: requests trips.
- **Driver**: fulfills trips. States (draft):
  - `offline` -> `idle` (available) -> `en_route` (heading to pickup) -> `on_trip` (rider aboard) -> `idle`.
  - `idle` -> `offline`.

## Trip

- **Trip**: one rider's journey from pickup cell to dropoff cell. States (draft):
  - `requested` -> `matched` -> `picked_up` -> `completed`.
  - `requested` | `matched` -> `cancelled`.
- **Pickup** / **Dropoff**: trip start / end cells.
- **Matching**: assigning an idle driver to a requested trip. Strategy TBD (start: nearest idle driver).
- **ETA**: ticks until a driver reaches a cell.

## Events

1. Named `<entity>.<past-tense-verb>`: `trip.requested`, `trip.matched`, `trip.picked_up`, `trip.completed`, `trip.cancelled`, `driver.moved`, `driver.went_online`, `driver.went_offline`. (draft)
2. Same name used as event `type` in code, NATS subject suffix, ClickHouse event type value.
3. Invalid state transition = domain error (see `errors` skill), never silently ignored.

## Not in scope yet

Pricing, surge, ratings, real roads/routing, multi-rider pooling. Don't model until asked.
