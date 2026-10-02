# 0007. Code design: deep modules, type-driven design, functional core

- Status: Accepted
- Date: 2026-10-02

## Context

Goal: highly maintainable code that scales with features and contributors. Candidate styles: Clean Code, A Philosophy of Software Design, functional core/imperative shell, type-driven design, DDD, Clean/Hexagonal Architecture, data-oriented design, AHA.

## Decision

We will combine:

- Deep modules and information hiding (Ousterhout) as the primary principle.
- Type-driven design: illegal states unrepresentable, parse don't validate, branded IDs.
- DDD-lite: ubiquitous language, value objects, aggregates own invariants; no ceremony.
- Functional core, imperative shell; dependencies point inward.
- AHA: abstract on the third real use.
- From Clean Code: naming and flat control flow only.

Rules: `CLAUDE.md` (Design) and `.claude/skills/design/SKILL.md`.

## Rationale

- Maintainability cost is driven by complexity; deep modules and information hiding attack it directly by keeping each decision in one place.
- Type-driven design moves whole classes of bugs (invalid states, mixed-up IDs) from runtime to compile time, at near-zero cost with TS + Zod.
- Functional core keeps logic pure, which is what makes the deterministic simulation (0008) and fast unit tests possible.
- DDD-lite and AHA take the useful parts (shared language, owned invariants, deliberate abstraction) without ceremony that slows a small team.

## Alternatives considered

- Clean Code fully: tiny-function fragmentation and shallow modules.
- Full Clean/Hexagonal Architecture: layers and indirection before they're needed.
- Full DDD tactical patterns: ceremony (repositories, factories) without a concrete need.
- Data-oriented design/ECS: deferred; adopt only if profiling shows the tick loop is the bottleneck.

## Consequences

- Changes stay local; types catch invalid states at compile time.
- Requires judgment on module depth; reviewed against the design skill.
