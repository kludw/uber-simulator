---
name: tdd
description: Test-driven development rules for this project (red -> green -> refactor, seams, good tests, mocking). Use whenever writing or changing code, fixing bugs, or writing tests.
---

# TDD

## Loop

1. Red before green. Write failing test first, then only enough code to pass. No anticipating future tests.
2. Vertical slices: one seam, one test, one minimal implementation per cycle. Each test a tracer bullet informed by last cycle.
3. Never horizontal slicing (all tests first, then all code). Bulk tests verify imagined behavior, test shape not behavior.
4. Refactor only when all tests green. Never refactor while red.

## Seams

1. Seam = public boundary where behavior is observed. Tests live at seams, never against internals.
2. Before writing tests: list seams under test, confirm with me. No test at unconfirmed seam.
3. Focus effort on critical paths and complex logic, not every edge case.

## Good tests

1. Verify behavior through public interface. Code can change entirely; tests shouldn't.
2. Name reads like spec: describes WHAT, not HOW (`user can checkout with valid cart`).
3. One logical assertion per test.
4. Expected values from independent source: known literal, worked example, spec.

## Anti-patterns

1. Implementation-coupled: mocking internal collaborators, testing private methods, asserting call counts/order. Tell: breaks on refactor with no behavior change.
2. Side-channel verification: e.g. querying DB directly instead of reading back through the interface.
3. Tautological: expected value recomputed the way the code does (`expect(add(a, b)).toBe(a + b)`). Passes by construction.

## Mocking

1. Mock only at system boundaries: external APIs, time/randomness, sometimes DB/filesystem (prefer test DB).
2. Never mock own modules or internal collaborators.
3. Inject boundary dependencies; don't construct them inside.
4. Prefer SDK-style boundary interfaces (`getUser`, `createOrder`) over one generic `fetch(endpoint)`. One mock = one shape, no conditional logic in test setup.
