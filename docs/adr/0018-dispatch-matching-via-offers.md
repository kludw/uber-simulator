# 0018. Dispatch matches trips via offers to drivers

- Status: Accepted
- Date: 2026-10-02

## Context

With independent services (0017), dispatch only knows driver positions and states from events, which may be stale. A driver it picks may already be busy. Something must own trip state and resolve races (e.g. rider cancels as driver arrives).

## Decision

We will have a single dispatch service own all trip state transitions.

- Riders send `request_trip` / `cancel_trip` commands; drivers report `driver.arrived_at_pickup` / `driver.arrived_at_dropoff`. Only dispatch emits `trip.*` events.
- Requests queue FIFO. Each tick, per queued trip, dispatch picks the nearest known-idle driver (Manhattan, ties by driver ID) not yet offered that trip, and sends an offer via request/reply with a 3-tick timeout.
- Driver accepts iff idle. Accept -> `trip.matched`. Reject or timeout -> next candidate next tick.
- Conflicting messages resolved by arrival order at dispatch.

## Rationale

- One owner per trip makes illegal trip states impossible regardless of message races.
- Offer/accept handles stale views explicitly instead of assuming dispatch's view is correct; mirrors real ride-hailing.
- Greedy nearest-driver is the simplest baseline to measure batched matching against later.
- Single dispatch avoids conflicting matches between dispatchers.

## Alternatives considered

- Dispatch assigns without asking: double-booking when its view is stale.
- Drivers bid on broadcast requests: more messages, harder to reason about.
- Batched matching every N ticks: better outcomes, more complex; later experiment.
- Sharded dispatch: unnecessary at 100 drivers.

## Consequences

- Dispatch is a single point of failure and a future bottleneck.
- Drivers wait at pickup until dispatch confirms; adds one message round trip.
- Offer events (`trip.offered`, `trip.offer_declined`, `trip.offer_expired`) are logged like all others.
