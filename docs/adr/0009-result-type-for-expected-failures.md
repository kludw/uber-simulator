# 0009. Result type for expected failures, throw for bugs

- Status: Accepted
- Date: 2026-10-02

## Context

The domain has expected failures (no idle driver, invalid transition, invalid input, broker/DB unavailable) and bugs (broken invariants). Exceptions hide the former from the type system.

## Decision

We will return expected failures as a project-wide `Result<T, E>` with tagged error unions, and throw only for bugs. Adapters convert I/O exceptions to typed errors, keeping `cause`. Errors are logged once where handled; the core emits events, not logs. No library. Rules: `.claude/skills/errors/SKILL.md`.

## Rationale

- Expected failures in the type signature force callers to handle them; the compiler flags any missed variant.
- Throwing only for bugs keeps exceptions meaningful: an exception always means something is broken.
- Converting I/O exceptions at adapters keeps the core free of network/DB failure modes.
- The type is a few lines; a library would add a dependency and its own conventions for little gain.

## Alternatives considered

- Exceptions everywhere: failure modes invisible in types, easy to forget handling.
- A Result library: unneeded dependency for a small type.

## Consequences

- Callers must handle every failure variant (exhaustive checks).
- Slightly more verbose call sites.
