# 0005. Use Zod for all validation

- Status: Accepted
- Date: 2026-10-02

## Context

Data enters from NATS messages, env vars, config, ClickHouse results, and later the UI. Untrusted data must become typed domain values before reaching the core.

## Decision

We will validate all external data with Zod (latest, https://zod.dev) at system boundaries ("parse, don't validate"). Types are inferred from schemas. Rules: `.claude/skills/validation/SKILL.md`.

## Rationale

- Schema and type are one thing (`z.infer`), so validation and types can't drift apart.
- Parsing at the boundary turns `unknown` into domain types once; the core then trusts its inputs instead of re-checking everywhere.
- `safeParse` returns a result instead of throwing, which fits our `Result` convention (0009).
- Supports branded types, needed for type-driven design (0007).

## Alternatives considered

- Hand-written type guards: duplicate types, easy to drift, no error detail.
- Other schema libraries: not chosen; Zod is the project owner's choice and supports branded types (see 0007).

## Consequences

- One source of truth per data shape.
- Many online Zod examples use deprecated v3 APIs; docs must be checked.
