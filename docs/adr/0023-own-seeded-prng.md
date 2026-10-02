# 0023. Small in-house seeded PRNG

- Status: Accepted
- Date: 2026-10-02

## Context

Brains need seeded randomness with independent child streams (`simulation` skill). Bun has no seeded PRNG API; `Math.random()` is unseeded.

## Decision

We will implement a small seeded PRNG in `src/shared/random.ts` (sfc32 seeded via splitmix32), behind a `Random` interface with integer sampling and `child(label)` deriving an independent stream from the parent seed and a label hash. No dependency.

## Rationale

- ~30 lines of well-known, public-domain algorithms; a dependency would cost more than it saves (Bun skill: prefer no deps).
- Statistical quality of sfc32 is far beyond what a ride simulation needs.
- Owning `child(label)` makes stream derivation explicit and testable.

## Alternatives considered

- npm PRNG packages (e.g. seedrandom): extra dependency, API not shaped for child streams.
- Mulberry32: simpler, weaker; no reason to prefer it.

## Consequences

- Determinism tests guard the implementation; changing the algorithm changes every seeded outcome (acceptable, no stored replays).
