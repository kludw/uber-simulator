# 0035. Driver preferences: drivers may decline offers

- Status: Accepted
- Date: 2026-10-04

## Context

Drivers accept every offer when idle (ADR 0018). Real drivers turn down far pickups and sometimes decline for no visible reason. The spec lists driver preferences as the last later feature. Dispatch already handles declines: the driver is excluded for that trip and the next candidate is tried next tick (ADR 0018), and dispatch's view can be stale (ADR 0032), so nothing in dispatch, the UI, persistence, or the invariant checker depends on drivers accepting. Driver brains are pure and seeded (ADR 0017, 0023).

## Decision

We will:

- Add a driver shard `preferences` config: `{ type: "accept_all" }` (default, unchanged) or `{ type: "picky", maxPickupDistance: { min, max }, declineShare }`.
- In picky mode each driver gets a maximum pickup distance (cells, Manhattan) drawn once at start, uniform in `[min, max]`, from the child stream `preference:<driverId>`. An idle driver declines an offer whose pickup is farther than its maximum from its current cell; otherwise it declines with probability `declineShare`, drawn from `offer:<tripId>:<driverId>` (one stream per offer, so the outcome doesn't depend on the order offers arrive in). A declined offer is an ordinary `offer_declined`.
- Take no preference streams in `accept_all` mode, so default runs stay byte-identical.
- Define one `picky` preset next to the other presets; select it with `--preferences off|picky` on `bun run sim` / `--compare` and `PREFERENCES` for driver services.
- Validate config with Zod at the edge; a brain receiving an invalid config throws (`min > max`, negative distances, `declineShare` outside [0, 1]).

## Rationale

- Distance limits are the dominant real reason to decline and interact directly with matching: batched matching (ADR 0030) minimizes pickup distance, so it should suffer fewer distance declines than greedy. That makes the comparison informative.
- A per-offer stream keeps a driver's decision a pure function of seed, driver, and trip, independent of offer timing.
- Dispatch stays unaware of preferences: drivers own their decisions (ADR 0017), and the existing decline path already retries other drivers.

## Alternatives considered

- Dispatch filters candidates by known driver preferences: faster matching, but couples dispatch to driver internals and needs a new message to publish preferences.
- Preferences by area (avoid airport, prefer downtown): richer, more parameters; later if needed.
- Declining only by probability: misses the distance interaction that makes the comparison meaningful.

## Consequences

- With picky drivers, trips can be declined repeatedly and wait longer or be cancelled; `--compare` shows how greedy vs batched cope.
- Repeated declines grow each trip's excluded-driver set (ADR 0018); a driver who declined a trip is never offered it again.
