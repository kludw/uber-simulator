# 0026. Brains reject invalid inputs with `input_rejected` outputs

- Status: Accepted
- Date: 2026-10-02

## Context

Services talk over a bus (0017); messages can arrive stale or out of order (e.g. a late `trip.completed`, a `trip.picked_up` for a driver whose trip already changed). Events are broadcast, so a brain also sees inputs about entities it doesn't own (drivers in another shard). An input addressed to an owned entity but invalid for its state is therefore expected, not a bug (0009). Throwing would crash the service on normal traffic.

## Decision

We will:

- Ignore silently inputs not addressed to an entity the brain owns.
- Emit a typed output `{ type: "input_rejected", reason, input }` (`InputRejected` in `src/shared/messages.ts`, snake_case `reason`) for inputs addressed to an owned entity but invalid for its state, leaving state unchanged.
- Have shells log `input_rejected` outputs and never publish them.

## Rationale

- Keeps brains total over their inputs: no crash on stale messages, no hidden drop.
- Rejections stay visible (logged) and testable at the brain seam, like any other output.
- One output list keeps the brain shape of 0022 unchanged.

## Alternatives considered

- Throw: treats normal message races as bugs, crashes the service.
- Return a `Result` separate from outputs: changes the 0022 brain shape for every service, for data that is only logged.
- Silent ignore: hides real protocol bugs, against the "never silently ignored" rule.

## Consequences

- Each brain lists its rejection reasons; shells need a log path for `input_rejected`.
- Reason/input pairing is loosely typed (one union of inputs, one of reasons); acceptable for log-only output.
