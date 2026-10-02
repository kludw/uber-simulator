---
name: docs
description: Project documentation rules - docs written alongside code, what lives where (README, architecture, ADRs), Architecture Decision Record format, numbering, lifecycle, and when an ADR is required. Use whenever making or changing a decision (technology, library, pattern, schema, subject scheme, convention), changing setup/commands/components/data flow, or finishing any change.
---

# Docs

Docs are part of the change, not a follow-up. Change not done until docs that it affects are updated in the same change.

## What lives where

1. `README.md`: what the project is, prerequisites, setup, run, test, lint commands. Every command copy-paste runnable; verify by running it.
2. `docs/spec.md`: what v1 does - world, services, trip lifecycle, invariants, milestones. Update when behavior or scope changes.
3. `docs/architecture.md`: components, how they connect, data flow (services <-> NATS -> ClickHouse / UI), where each design decision lives. Update when a component, flow, or boundary changes.
4. `docs/adr/NNNN-kebab-title.md`: one file per architecture decision. Index in `docs/adr/README.md` (number, title, status).
5. `.claude/skills/*`, `CLAUDE.md`: rules for Claude. Convention changes -> update the skill in the same change, and the ADR if one covers it.
6. Code comments: *why* and non-obvious contracts only (see `design` skill).
7. Don't duplicate: link to the single source (ADR, skill, official docs) instead of copying.

## When an ADR is required

Write one for any decision that is hard to reverse, affects more than one module, or that a future reader would ask "why?" about:

- Choosing/replacing a technology, library, or service.
- Structural patterns, module boundaries, component split.
- Data schemas: ClickHouse tables + ordering keys, event shapes, NATS subject scheme.
- Cross-cutting conventions (errors, determinism, validation).
- Rejecting an obvious option (record why).

Unsure if ADR-worthy? Ask me.

## ADR lifecycle

1. Before implementing: write ADR with status `Proposed`, present it, wait for my decision.
2. I accept -> status `Accepted`, then implement. Rejected -> keep file, status `Rejected` (records why not).
3. Accepted ADRs are immutable. Changed mind -> new ADR, old one status `Superseded by NNNN`, new one says `Supersedes NNNN`.
4. Numbers: 4 digits, sequential, never reused. Next number = highest existing + 1.

## ADR template

```markdown
# NNNN. Title in imperative form (e.g. "Use NATS for messaging")

- Status: Proposed | Accepted | Rejected | Superseded by NNNN
- Date: YYYY-MM-DD

## Context

Problem, forces, constraints. Facts, with links to sources (official docs).

## Decision

What we do. Active voice: "We will ...".

## Rationale

Why this option wins given the context: the reasons, tied to project goals and constraints. Required. Preference-driven decisions say so honestly.

## Alternatives considered

Each option with its main pro/con and why not chosen.

## Consequences

What becomes easier, what becomes harder, follow-up work, risks.
```

Keep ADRs short: one decision each, a page at most.
