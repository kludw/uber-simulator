# 0004. Use Biome for linting and formatting

- Status: Accepted
- Date: 2026-10-02

## Context

The project needs consistent formatting and linting with minimal configuration and fast feedback.

## Decision

We will use Biome (https://biomejs.dev), pinned exactly (`bun add -D -E @biomejs/biome`). `biome check --write` before a change is done; `biome ci` in CI. Rules: `.claude/skills/biome/SKILL.md`.

## Rationale

- One fast tool with one config instead of two tools whose rules must be kept from conflicting.
- Speed keeps lint/format in the inner loop: run on every change, not just in CI.
- Exact version pin makes formatting stable across machines; upgrades are deliberate.

## Alternatives considered

- ESLint + Prettier: two tools, more configuration and plugins to align.

## Consequences

- One tool and one config file (`biome.json`) for lint, format, and import sorting.
- Version pinned, so upgrades are explicit.
