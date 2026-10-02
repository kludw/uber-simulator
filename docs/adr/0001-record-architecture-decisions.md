# 0001. Record architecture decisions

- Status: Accepted
- Date: 2026-10-02

## Context

The project targets production-quality, maintainable code. Decisions about technology, structure, and conventions need to stay understandable after the people and conversations that made them are gone.

## Decision

We will record every architecture decision as an ADR in `docs/adr/`, using the format, triggers, and lifecycle defined in `.claude/skills/docs/SKILL.md`. Docs are written in the same change as the code.

## Rationale

- Decisions outlive the conversations that made them; without a record, future changes either repeat old debates or unknowingly break old constraints.
- ADRs are small and append-only, so they stay accurate: a decision is never rewritten, only superseded, which preserves the history of why.
- Proposing before implementing makes open decisions visible and gives the project owner a clear accept/reject point.

## Alternatives considered

- No formal records, rely on commit messages/PRs: rationale scattered and hard to find.
- Long design documents: heavy to maintain, go stale.

## Consequences

- Every significant decision has a findable "why".
- Small overhead per decision. Proposed ADRs gate implementation of open decisions.
