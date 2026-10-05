# 0041. Drivers confirm their trip with dispatch while waiting

- Status: Accepted
- Date: 2026-10-05
- Supersedes 0040

## Context

Over core NATS a message can be lost to one subscriber and not others (ADR 0028: losses are "handled by brain timeouts and the rejection paths"). A driver waiting at the pickup (`at_pickup`) or dropoff (`at_dropoff`) leaves only on a trip event from dispatch. ADR 0040 frees an `at_pickup` driver after 360 ticks, which repairs a lost `trip.offer_expired` or `trip.cancelled`, but leaves the paths listed in #180:

- Lost `trip.picked_up` to the driver, or lost `driver.arrived_at_pickup` plus a lost rider cancel: dispatch keeps the trip active with the driver, the driver gives up and wanders, is never offered a trip again, and with shifts can go offline with an active trip.
- Lost `driver.arrived_at_dropoff` or lost `trip.completed` to the driver: the driver waits at the dropoff forever.

Every one of these is a disagreement between the driver and dispatch about one trip, and dispatch's trip state is the authority (ADR 0018). A timeout can only guess at it.

## Decision

We will let a waiting driver ask dispatch:

- A driver `at_pickup` or `at_dropoff` that has had no event for its trip for 10 ticks sends `confirm_trip { tripId, driverId, stage: "pickup" | "dropoff" }` (`sim.commands.confirm_trip`), and again every 10 ticks while it still waits.
- Dispatch answers every `confirm_trip`, reading the trip's state:
  - matched to this driver, stage pickup: the confirm counts as the arrival, the normal pickup transition runs (`trip.picked_up`, as for `driver.arrived_at_pickup`);
  - picked up by this driver, stage dropoff: the confirm counts as the dropoff arrival (`trip.completed`);
  - otherwise no transition and no event: it replies `trip_status { tripId, driverId, status }` (`sim.replies.trip_status`) with `picked_up` (picked up by this driver), `completed` (completed by this driver), or `released` (cancelled, offer expired or declined, matched to another driver, or unknown trip).
- The driver treats `trip.picked_up` / `trip_status picked_up` alike (`on_trip`), `trip.completed` / `trip_status completed` alike (`idle`), and `trip_status released` like `trip.cancelled` (`idle`). A reply for a trip it no longer waits on is ignored.
- ADR 0040's 360-tick timeout is removed: a released driver now learns it from dispatch.

## Rationale

- Asks the authority instead of guessing: one mechanism repairs every single lost message on the pickup and dropoff paths, in both directions (driver -> dispatch and dispatch -> driver), and also two losses as long as some later confirm or reply gets through.
- Idempotent: dispatch's answer depends only on its trip state, so repeated confirms and late replies are harmless. Trip events stay facts published once; the reply is a reply, not a repeated event, so the event log and invariants (spec) are unchanged.
- Confirm as arrival keeps one transition path: dispatch already checks the driver's position for an arrival.
- 10 ticks: an answered arrival normally lands within 1-2 ticks; 10 keeps confirms rare under the 25k live load (only drivers whose trip event is late or lost send them) while bounding a lost message's cost to about 10-20 ticks instead of 360 or the rest of the run.
- In-process runs never lose messages and answer within a tick, so no confirm is ever sent: `bun run sim` outputs stay identical.

## Alternatives considered

- Keep ADR 0040 and add a dropoff timeout plus a "driver gave up" event that cancels the trip: a lost `trip.picked_up` would need a `picked_up -> cancelled` transition the spec forbids, and a rider in the car would be cancelled.
- Re-publish `driver.arrived_at_*` on a timer and have dispatch re-publish the trip event: repeated events break "published once", the invariant checker, and analytics counts.
- JetStream (at-least-once) delivery for trip events and arrivals: removes loss at the transport, but adds acks and consumers to every service's hot path; ADR 0028 chose core NATS for the brains.

## Consequences

- New command and reply types, subjects, and validation; dispatch and the driver brain each gain one input.
- The UI learns driver state from events, so a driver released by `trip_status` shows its old state until its next state event (as under ADR 0040).
- Rider-side losses (a rider missing `trip.picked_up` / `trip.completed`) are not covered; rider handling is unchanged (spec trip lifecycle step 6).
- A lossy in-memory bus becomes worth having: system tests that drop messages and check that trips still end.
