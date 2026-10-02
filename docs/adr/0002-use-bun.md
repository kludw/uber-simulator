# 0002. Use Bun as runtime, package manager, and test runner

- Status: Accepted
- Date: 2026-10-02

## Context

The project needs a TypeScript runtime, package manager, and test runner. One tool for all three reduces configuration and moving parts.

## Decision

We will use Bun (https://bun.com/docs) for running code, managing packages (`bun install`/`bun add`), and testing (`bun test`, `bun:test`). Bun APIs are preferred over external dependencies; adding a dependency where Bun has an equivalent needs a stated case. Rules: `.claude/skills/bun/SKILL.md`.

## Rationale

- One tool replaces runtime + package manager + test runner, so less configuration and fewer version mismatches.
- Runs TypeScript directly, which keeps the TDD loop fast (no build step between edit and test).
- Built-in APIs (HTTP server, WebSockets, SQLite, test runner) cover needs that would otherwise be dependencies.
- Project owner preference; no requirement here that Bun can't meet.

## Alternatives considered

- Node.js + npm/pnpm + a separate test framework: more tools to configure and keep aligned.
- Deno: not chosen; project owner preference for Bun.

## Consequences

- Runs TypeScript directly; no build step for local runs.
- Bun does not type-check: `tsc` runs separately (see 0003).
- Some libraries officially target Node only (e.g. ClickHouse client, see 0013) and rely on Bun's Node compatibility.
