# 0040. Free a driver waiting at the pickup after a timeout

- Status: Accepted
- Date: 2026-10-05
- Extends the driver states of 0025 (new `at_pickup -> idle` transition; nothing superseded)

## Context

A driver `at_pickup` (ADR 0024, 0025) leaves only on a trip event: `trip.picked_up`, `trip.cancelled`, `trip.offer_expired`. Over core NATS a message can be lost (ADR 0028: "handled by brain timeouts and the rejection paths"). Since #175 dispatch ignores `driver.arrived_at_pickup` from a driver excluded for the trip (its accept arrived after the offer expired); `trip.offer_expired` is the only thing that frees it. If that event is lost, the driver waits at the pickup forever and dispatch, which already counts it idle, keeps offering it trips it declines. Same for a `trip.cancelled` lost to a driver `en_route` or `at_pickup` for that trip: dispatch ignores arrivals for a cancelled trip and counts the driver free, while the driver waits forever.

Riders wait at most 300 ticks from request (patience 120-300, `src/rider/brain.ts`), then cancel; the rider is at the pickup, so an arrival reaching dispatch is answered within a tick or two.

## Decision

We will free a driver that has been `at_pickup` for 360 ticks without a trip event: on the tick `arrivedAt + 360` it becomes `idle` at the pickup and starts wandering that same tick. It emits no new event (its next `driver.moved` is the only sign). The timeout lives in the driver brain, in ticks (simulation skill, ADR 0028: no transport timeouts).

## Rationale

- Ticks since arrival, not since offer: the brain knows its own arrival tick; it never sees the request tick.
- 360 > max patience 300 + margin for message delay: when dispatch holds the trip `matched` and the driver's arrival was lost, the rider's cancel (at most 300 ticks after request, so at most 300 after arrival) frees the driver first. With one lost `trip.offer_expired` or `trip.cancelled` the timeout fires only for a driver dispatch already counts free, so freeing it is consistent with dispatch. A lost `trip.picked_up` or two losses leave dispatch holding the driver (Consequences).
- No event: the cases the timeout fixes need no one else to change state. The cases where dispatch still holds the driver need two lost messages or a lost `trip.picked_up` (below), and no event can repair those without new trip transitions.
- In-process runs never lose messages, so the timeout never fires: the README sim outputs are unchanged.

## Alternatives considered

- Short timeout (e.g. the 3-tick offer timeout): under load a legitimate `trip.picked_up` can arrive late; the driver would have left, reject it (`driver_not_at_pickup`), and strand a picked-up trip.
- Announce giving up (new `driver.*` event, dispatch cancels a still-matched trip): repairs the double-loss case, but adds an event, a subject, persister rows, UI and invariant handling for a two-loss path; and a lost `trip.picked_up` would need a `picked_up -> cancelled` transition the spec forbids. Not worth it until losses are measured.
- Re-send `driver.arrived_at_pickup` on a timer: dispatch ignores an excluded driver's arrival, so it never frees the driver in the case that motivated this.

## Consequences

- A lost `trip.offer_expired` costs the driver at most 360 ticks at the pickup instead of the rest of the run.
- The timeout must stay above max rider patience; raising patience means raising it.
- Remaining divergence (follow-ups): if `trip.picked_up` is lost to the driver, or the driver's arrival and the rider's cancel are both lost, dispatch keeps the trip active with this driver while the driver, after the timeout, wanders. Dispatch never offers it again, as before (the driver was stuck anyway); with shifts the driver can now go offline, which the invariant checker reports as `driver_went_offline_with_active_trip`.
- The same lost-message gap exists at the dropoff (`at_dropoff` waits for `trip.completed`) and is not covered here.
- A UI that missed the freeing event keeps showing the driver `at_pickup` until its next state event; driver moves keep the last known state.
