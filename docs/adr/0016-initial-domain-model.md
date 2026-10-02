# 0016. Initial domain model: synthetic grid, states, matching

- Status: Accepted (driver states superseded by 0024)
- Date: 2026-10-02

## Context

The first version uses a synthetic grid, not real maps. The model must be simple enough to build test-first and extend later (routing, pricing, pooling are out of scope).

## Decision

We will model:

- Grid of integer cells, 500 x 500 (1 cell = 10 m); 1 tick = 1 s; Manhattan distance; a driver moves at most one cell per tick to a 4-neighbor, larger remaining axis first.
- Idle drivers wander: random target cell, drive there, repeat.
- Riders: spawned by a demand generator (Poisson, ~10/min) at random pickup/dropoff cells with random patience (120-300 ticks); cancel if not picked up in time; removed after completion or cancellation.
- Driver states: `offline -> idle -> en_route -> on_trip -> idle`; `idle -> offline`.
- Trip states: `requested -> matched -> picked_up -> completed`; `requested | matched -> cancelled`.
- Matching: nearest idle driver by Manhattan distance, ties broken by driver ID, via offers (0018).

Glossary and event names: `.claude/skills/domain/SKILL.md`.

## Rationale

- Manhattan distance and 4-neighbor moves match a street grid and are trivial to compute and test exactly.
- Explicit state machines make invalid transitions detectable (returned as errors) instead of silent bugs.
- Nearest-driver matching is the simplest strategy that produces realistic behavior; it's a baseline to measure better strategies against.
- Tie-breaking by driver ID keeps the dispatch brain deterministic (0017).
- 1 s ticks at 10 m cells give a realistic 36 km/h with one-cell moves; the UI interpolates for smoothness.

## Alternatives considered

- Diagonal moves / Euclidean distance: closer to reality, but grid streets make Manhattan the natural fit.
- Batch/global-optimal matching: better outcomes, more complex; candidate for a later ADR once nearest-driver is in place.

## Consequences

- Deterministic, easily testable movement and matching.
- Changing movement or distance later touches only the grid module (see 0007).
