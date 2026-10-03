# 0032. Driver shifts: drivers go offline and come back online

- Status: Accepted
- Date: 2026-10-03

## Context

All drivers stay online for the whole run (spec, v1). The domain model already has `offline` and the events `driver.went_online` / `driver.went_offline`, but nothing emits `went_offline`. Supply that varies over time is the next realism step after clustered demand (ADR 0031), and it exercises paths no run hits today: dispatch losing and regaining drivers, the UI and invariant checker seeing drivers disappear. Driver brains are pure and seeded (ADR 0017, 0023); dispatch only knows drivers from events (ADR 0018).

## Decision

We will:

- Add a driver shard `shifts` config: `{ type: "always_online" }` (default, unchanged) or `{ type: "shifts", onlineTicks: { min, max }, offlineTicks: { min, max }, startOnlineShare }`.
- In shift mode each driver has a schedule drawn from per-driver child streams (`shift:<driverId>:<n>` for the n-th period): at start it is online with probability `startOnlineShare`, then alternates online periods and offline periods with lengths uniform in the given ranges.
- A driver whose online period ends goes offline only when `idle`: a driver in any trip state finishes the trip first and goes offline on the first tick it is idle again. Going offline emits `driver.went_offline` (tick, driverId, cell); coming back emits `driver.went_online` at the same cell. Offline drivers don't move and decline every offer.
- Dispatch removes a driver from its known positions on `driver.went_offline` (no offers until `went_online`); a pending offer to a driver who goes offline expires as today.
- The UI view and the invariant checker handle offline drivers. New invariants: an offline driver never moves, is never matched or offered a trip, and `driver.went_offline` only happens with no active trip.
- Expose a `shifts` preset on `bun run sim` / `--compare` (`--shifts on|off`, default off) and `SHIFTS` env for driver services.

## Rationale

- Alternating random periods is the simplest model that makes supply vary and exercises both transitions; per-driver, per-period child streams keep schedules independent and replayable.
- "Finish the trip first" matches real driver behaviour and keeps every trip invariant intact (no trip is abandoned by a shift change).
- Reusing existing events and states means no new message types except the `driver.went_offline` schema, and persistence works unchanged.

## Alternatives considered

- Global shift calendar (rush hours): more realistic, couples to time-of-day demand; later.
- Drivers abandoning trips at shift end: needs a new trip transition and rider handling; not worth it.
- Dispatch-controlled supply (dispatch sends drivers offline): inverts ownership; drivers own their state (ADR 0017).

## Consequences

- Default runs stay byte-identical (no shift streams are taken in `always_online` mode).
- Comparisons can include varying supply; fleet capacity numbers in the spec become averages under shifts.
