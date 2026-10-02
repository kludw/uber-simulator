# 0017. Run actors as independent services with pure, seeded brains

- Status: Accepted
- Date: 2026-10-02
- Supersedes 0008

## Context

The project is for learning and a portfolio demo. The owner wants drivers, riders, and dispatch as separate services (e.g. 2 driver services × 50 drivers) communicating over NATS. 0008 requires one deterministic core; independent processes racing over a network cannot produce an identical event log every run. v1 is live-only with no replay, which lowers the cost of losing determinism.

## Decision

We will run clock, driver (sharded), rider, and dispatch as independent services, each owning its own state, communicating only via NATS.

- Each service's decision logic is a pure brain: `decide(state, observation, random) -> { state, intents }`. No I/O, no wall clock, seeded PRNG, deterministic IDs. The rules of `.claude/skills/simulation/SKILL.md` apply to brains.
- The imperative shell per service handles NATS, timers, and applying intents.
- A clock service publishes `clock.ticked` (1 tick = 1 s sim time, paced at 1 s wall × speed). Services act on ticks, never on their own wall clock.
- System-level ordering is nondeterministic and accepted. System tests assert invariants, not exact event sequences.
- A transport-agnostic bus port lets all services run in one process over an in-memory bus (tests, milestone 2) or over NATS.

## Rationale

- Distributed actors are the learning goal; one central core would hide exactly what the owner wants to explore.
- Keeping brains pure retains most of 0008's value: decision logic is still exact, seeded, and TDD-able.
- Invariant tests are the honest way to test a concurrent system.
- The shared clock gives one notion of time, plus speed control, without lockstep.

## Alternatives considered

- Single authoritative core with services only at the edges (0008): fully deterministic, but no distributed actors to learn from.
- Lockstep agents (coordinator barrier each tick, intents sorted by ID): deterministic and distributed, but more complex; rejected by the owner.
- Each service on its own wall clock: no speed control, clocks drift.

## Consequences

- Bugs in system-level behavior may not reproduce; need good logs and invariant checks.
- 0008 superseded; CLAUDE.md rule 8 and the `simulation` skill scope determinism to brains.
- Message loss and races (stale positions, late cancels) become real cases to handle (see 0018).
