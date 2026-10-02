# 0008. Deterministic, tick-based simulation core

- Status: Accepted
- Date: 2026-10-02

## Context

The simulator must be testable, debuggable, and replayable, and later watchable live in a UI.

## Decision

We will build a pure simulation core advanced in discrete ticks: `step(state, tick, random) -> { state, events }`. No wall clock or unseeded randomness in core; a seeded PRNG and deterministic IDs are injected. A headless runner runs ticks as fast as possible; a live runner paces the same core to wall time for the UI. External input enters as commands applied at the next tick. Rules: `.claude/skills/simulation/SKILL.md`.

## Rationale

- Determinism makes every bug reproducible from a seed: replay the run, get the same failure.
- Tests can assert exact outcomes instead of tolerating timing noise.
- Separating pacing (runner) from logic (core) lets the same engine serve fast batch runs and live UI watching.
- Applying external commands at tick boundaries keeps the core free of concurrency issues.

## Alternatives considered

- Real-time, wall-clock-driven simulation: not reproducible, hard to test.
- Separate engines for headless and live: duplicate logic that drifts.

## Consequences

- Same seed and inputs reproduce the same event log: exact tests and replayable bugs.
- All I/O (NATS, ClickHouse, UI) consumes events outside the core.
