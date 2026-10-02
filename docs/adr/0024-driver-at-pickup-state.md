# 0024. Add `at_pickup` driver state

- Status: Accepted
- Date: 2026-10-02
- Supersedes 0016 (driver states only)

## Context

A driver that reaches the pickup must report `driver.arrived_at_pickup` once, then wait without moving until dispatch answers (`docs/spec.md` step 4). 0016's states fold this waiting into `en_route`. Tracking it with a boolean flag on `en_route` allowed illegal states (arrival reported while away from the pickup), against 0007 (illegal states unrepresentable).

## Decision

We will use driver states `offline -> idle -> en_route -> at_pickup -> on_trip -> idle`, and `idle -> offline`.

- `at_pickup`: arrived at the pickup, waiting for dispatch. No separate cell; its position is the pickup.
- `en_route -> at_pickup` on the tick the driver emits `driver.arrived_at_pickup`, including when it accepted while already on the pickup cell.
- `trip.cancelled` / `trip.offer_expired` for the driver's current trip free both `en_route` and `at_pickup` drivers to `idle`.

## Rationale

- A distinct state makes "waiting at pickup" explicit and its position correct by construction.
- Exhaustive switches force every handler to decide what a waiting driver does.

## Alternatives considered

- Boolean flag on `en_route`: fewer states, but representable illegal combinations.
- Derive waiting from `cell === pickup`: cannot tell "arrived, not yet reported" from "reported", so arrival could repeat or be missed.

## Consequences

- One more state for dispatch views and the UI (driver colors) to handle.
- Rest of 0016 (grid, trip states, matching) unchanged.
