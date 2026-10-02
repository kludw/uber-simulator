# 0006. Develop with test-driven development

- Status: Accepted
- Date: 2026-10-02

## Context

Production-quality code needs a test suite that verifies behavior and survives refactoring.

## Decision

We will develop with TDD: red, green, refactor, in vertical slices, testing behavior through public interfaces at agreed seams, mocking only at system boundaries. Exceptions only when the project owner explicitly says so. Rules: `.claude/skills/tdd/SKILL.md` (adapted from https://github.com/mattpocock/skills).

## Rationale

- Writing the test first proves the test can fail, so it actually guards the behavior.
- Testing through public interfaces at agreed seams keeps tests valid through refactors, which is what makes long-term maintenance cheap.
- Vertical slices give fast feedback on design: hard-to-test code shows up immediately, not after it's built.

## Alternatives considered

- Tests after implementation: tends to test implementation details and misses design feedback.

## Consequences

- Every behavior is covered by a test written first.
- Seams must be agreed before tests are written.
