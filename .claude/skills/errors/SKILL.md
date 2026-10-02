---
name: errors
description: Project error-handling and logging conventions - Result type for expected failures, throw for bugs, typed error unions, wrapping I/O errors at adapters, where to log. Use whenever writing code that can fail, handling errors, adding try/catch, returning failures, or adding logging.
---

# Errors

## Two kinds of failure

1. **Expected failure** (part of the domain or input): no idle driver, invalid trip transition, validation failed, NATS/ClickHouse unavailable. Return it as a value: `Result<T, E>`.
2. **Bug** (broken invariant, impossible state): `throw new Error(...)`. Fail fast, never catch-and-continue.
3. Brain input invalid for the addressed entity's state (stale/out-of-order message) = expected failure, emitted as an `input_rejected` output (snake_case `reason`), not thrown. See `simulation` skill.

## Result

1. One project-wide type, no library:
   `type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }`.
2. Errors are tagged unions, discriminated by `type`:
   `{ type: "no_idle_driver"; tripId: TripId } | { type: "invalid_transition"; from: TripState; to: TripState }`.
3. Error `type` names: snake_case, describe what happened. Carry the data needed to act on it, not a prose message.
4. Callers handle every variant. `switch` on `error.type` with exhaustive `never` check in `default`.
5. Zod `safeParse` failure -> map to a project error at the boundary (see `validation` skill). Don't leak `ZodError` into core.

## Adapters / I/O

1. Catch I/O exceptions (network, DB, broker) in the adapter, convert to a typed `Result` error. Core never sees raw exceptions.
2. Wrapping a thrown error: keep the original as `cause` (`new Error("...", { cause })`).
3. Never swallow: no empty `catch {}`, no catch that only logs and returns `undefined`.
4. Retry policy lives in the adapter, explicit and bounded. Not hidden in core.

## Logging

1. Log where an error is handled, once. Not at every layer it passes through.
2. Structured: object with context (`tick`, `tripId`, `driverId`, `error.type`), not interpolated strings.
3. Core (`simulation` skill) doesn't log; it emits events. Runners/adapters log.

## Tests

1. Expected failures get tests at the seam: assert `result.ok === false` and `error.type` + data.
2. Never assert on error message strings.
