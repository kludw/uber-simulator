# 0015. NATS subject scheme

- Status: Accepted
- Date: 2026-10-02

## Context

Subjects are dot-delimited, case-sensitive tokens; tokens use letters, digits, `-`, `_`; `$`-prefixed subjects are reserved; wildcards `*` (one token) and `>` (rest) are subscriber-only (https://docs.nats.io/learn/core-nats/subjects-and-wildcards). Domain events are named `<entity>.<past-tense-verb>` (domain skill).

## Decision

We will use:

- `sim.events.<entity>.<verb>` for domain events, e.g. `sim.events.trip.requested`. All events: `sim.events.>`.
- `sim.events.clock.ticked` for the clock (same scheme as domain events).
- `sim.commands.<name>` for commands to dispatch, e.g. `sim.commands.request_trip`, `sim.commands.cancel_trip`.
- `sim.offers.<driverId>` for dispatch offers to one driver (request/reply). Each driver service subscribes to its own drivers' subjects.

## Rationale

- A `sim` prefix namespaces everything, leaving room for other systems on the same server.
- Separating `events` from `commands` makes direction obvious: events are facts any service may observe, commands are requests to the owner of the state.
- Per-driver offer subjects route an offer to exactly the service owning that driver without dispatch knowing the sharding.
- Reusing domain event names as subject suffixes means one name across code, subjects, and ClickHouse; no mapping tables.
- Token order (entity, then verb) enables useful wildcards like `sim.events.trip.*`.

## Alternatives considered

- Including run ID in the subject (`sim.<runId>.events...`): enables parallel runs on one server, adds a token everywhere. Defer until parallel runs are needed.
- Flat names without a prefix: no namespace for other components later.

## Consequences

- Subscribers filter by entity with `sim.events.trip.*`.
- Event names in code, subjects, and ClickHouse stay identical.
