# 0025. Add `at_dropoff` driver state

- Status: Accepted
- Date: 2026-10-02
- Supersedes 0024 (driver states only)

## Context

A driver that reaches the dropoff must report `driver.arrived_at_dropoff` once, then wait without moving until dispatch emits `trip.completed` (`docs/spec.md` step 5). 0024's states have no state for this wait. Same problem as 0024 solved at the pickup: a boolean flag on `on_trip` would allow illegal states, against 0007.

## Decision

We will use driver states `offline -> idle -> en_route -> at_pickup -> on_trip -> at_dropoff -> idle`, and `idle -> offline`.

- `on_trip`: rider aboard, heading to the dropoff.
- `at_dropoff`: arrived at the dropoff, waiting for dispatch. No separate cell; its position is the dropoff.
- `on_trip -> at_dropoff` on the tick the driver emits `driver.arrived_at_dropoff`, including when picked up on the dropoff cell.
- `trip.completed` for the driver's trip frees an `at_dropoff` driver to `idle` at the dropoff.
- Rest of 0024 (`at_pickup`, cancel/expiry handling) unchanged.

## Rationale

Mirrors `at_pickup`: waiting is explicit, position correct by construction, exhaustive switches force each handler to decide what a waiting driver does.

## Alternatives considered

- Boolean flag on `on_trip`: representable illegal combinations (rejected in 0024 for the same reason).
- Derive waiting from `cell === dropoff`: cannot tell reported from not-yet-reported arrival.

## Consequences

- One more state for dispatch views and the UI (driver colors).
