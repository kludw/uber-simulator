# 0016. Initial domain model: synthetic grid, states, matching

- Status: Proposed
- Date: 2026-10-02

## Context

The first version uses a synthetic grid, not real maps. The model must be simple enough to build test-first and extend later (routing, pricing, pooling are out of scope).

## Decision

We will model:

- Grid of integer cells, `width x height`; Manhattan distance; a driver moves at most one cell per tick to a 4-neighbor.
- Driver states: `offline -> idle -> en_route -> on_trip -> idle`; `idle -> offline`.
- Trip states: `requested -> matched -> picked_up -> completed`; `requested | matched -> cancelled`.
- Matching: nearest idle driver by Manhattan distance, ties broken by driver ID (deterministic).

Glossary and event names: `.claude/skills/domain/SKILL.md`.

## Rationale

- Manhattan distance and 4-neighbor moves match a street grid and are trivial to compute and test exactly.
- Explicit state machines make invalid transitions detectable (returned as errors) instead of silent bugs.
- Nearest-driver matching is the simplest strategy that produces realistic behavior; it's a baseline to measure better strategies against.
- Tie-breaking by driver ID keeps matching deterministic (0008).

## Alternatives considered

- Diagonal moves / Euclidean distance: closer to reality, but grid streets make Manhattan the natural fit.
- Batch/global-optimal matching: better outcomes, more complex; candidate for a later ADR once nearest-driver is in place.

## Consequences

- Deterministic, easily testable movement and matching.
- Changing movement or distance later touches only the grid module (see 0007).
