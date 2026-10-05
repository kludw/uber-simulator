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

- A driver `at_pickup` or `at_dropoff` that has had no event for its trip for 10 ticks sends `confirm_trip { tripId, driverId, stage: "pickup" | "dropoff", cell }` (`sim.commands.confirm_trip`, the first command a driver sends), and again every 10 ticks while it still waits.
- Dispatch handles `confirm_trip` by its trip state and the trip's relation to this driver. Every case is one of: run the arrival transition, reply, stay silent, or reject:

  | Dispatch's trip state | Stage pickup | Stage dropoff |
  | --- | --- | --- |
  | unknown | reply `released` | reply `released` |
  | pending offer to this driver | silent (the offer's accept or `trip.offer_expired` resolves it) | reject |
  | matched to this driver | arrival: same transition and checks as `driver.arrived_at_pickup` (`trip.picked_up`) | reject |
  | picked up by this driver | reply `picked_up` | arrival: same as `driver.arrived_at_dropoff` (`trip.completed`) |
  | completed by this driver | reply `completed` | reply `completed` |
  | anything else (waiting without an offer to it, cancelled, its offer expired or declined, matched / picked up / completed by another driver) | reply `released` | reply `released` |

  The reply is `trip_status { tripId, driverId, stage, status }` (`sim.replies.trip_status`), echoing the confirm's stage. "Reject" and a failed arrival check (e.g. `wrong_cell`) are logged as `input_rejected` like any rejected arrival (ADR 0026) and get no reply: they mean a driver brain bug, not a lost message, and the driver keeps confirming.
- The driver acts on a `trip_status` only if it is still waiting for that trip at that stage, else ignores it: stage pickup + `picked_up` -> `on_trip` (as `trip.picked_up`); stage dropoff + `completed` -> `idle` (as `trip.completed`); `released` at either stage -> `idle`, unlike `trip.cancelled`, which a driver at the dropoff rejects. Any other combination is ignored.
- ADR 0040's 360-tick timeout is removed: a released driver now learns it from dispatch.

## Rationale

- Asks the authority instead of guessing: one mechanism repairs every single lost message on the pickup and dropoff paths, in both directions (driver -> dispatch and dispatch -> driver), and also two losses as long as some later confirm or reply gets through.
- Idempotent: dispatch's answer depends only on its trip state, so repeated confirms and late replies are harmless. Trip events stay facts published once; the reply is a reply, not a repeated event, so the event log and invariants (spec) are unchanged.
- Confirm as arrival keeps one transition path: the confirm carries the driver's cell, so dispatch runs the same arrival checks (`src/dispatch/trip.ts`) as for `driver.arrived_at_*`.
- Total over dispatch's states, so no confirm goes unanswered by accident; the only silent case (a pending offer to this driver) is resolved by the offer itself, and replying `released` there could free a driver whose accept is about to land.
- Replies echo the stage, so a late reply from an earlier confirm (e.g. `picked_up` reaching a driver already at the dropoff of the same trip) is told apart and ignored.
- 10 ticks: an answered arrival normally lands within 1-2 ticks; 10 keeps confirms rare under the 25k live load (only drivers whose trip event is late or lost send them) while bounding a lost message's cost to about 10-20 ticks instead of 360 or the rest of the run.
- In-process runs never lose messages and answer within a tick, so no confirm is ever sent: `bun run sim` outputs stay identical.

## Alternatives considered

- Keep ADR 0040 and add a dropoff timeout plus a "driver gave up" event that cancels the trip: a lost `trip.picked_up` would need a `picked_up -> cancelled` transition the spec forbids, and a rider in the car would be cancelled.
- Re-publish `driver.arrived_at_*` on a timer and have dispatch re-publish the trip event: repeated events break "published once", the invariant checker, and analytics counts.
- JetStream (at-least-once) delivery for trip events and arrivals: removes loss at the transport, but adds acks and consumers to every service's hot path; ADR 0028 chose core NATS for the brains.

## Consequences

- New command and reply types, subjects, and validation; dispatch and the driver brain each gain one input. Drivers now send a command for the first time: the `domain` skill and `docs/architecture.md` message tables change with the implementation, as do spec trip lifecycle steps 4-5 and the rider brain's patience comment (both reference ADR 0040).
- The UI learns driver state from events, so a driver released by `trip_status` shows its old state until its next state event (as under ADR 0040).
- Rider-side losses (a rider missing `trip.picked_up` / `trip.completed`) are not covered; rider handling is unchanged (spec trip lifecycle step 6).
- A lossy in-memory bus becomes worth having: system tests that drop messages and check that trips still end.
