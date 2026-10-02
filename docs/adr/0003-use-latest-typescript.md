# 0003. Use the latest TypeScript (currently 7.x)

- Status: Accepted
- Date: 2026-10-02

## Context

TypeScript 7.0 (native Go port) is the current `latest` on npm (7.0.2). It adopts TS 6.0 defaults (`strict`, `types: []`, `rootDir: ./`) and makes 6.0 deprecations hard errors. Sources: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/, https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html.

## Decision

We will use the latest TypeScript, with Bun's recommended tsconfig (https://bun.com/docs/typescript-6) and `"types": ["bun"]`. Type-checking via `bunx tsc` with `noEmit`. Rules: `.claude/skills/typescript/SKILL.md`.

## Rationale

- Latest TS is where fixes and new type features land; starting on it avoids a forced migration later.
- TS 7's native compiler makes type-checking fast, so type-checks stay in the inner loop instead of being skipped.
- Its stricter defaults (`strict`, explicit `types`) match our type-driven design (0007).
- The main cost of TS 7 (no compiler API until 7.1) doesn't affect us: no tool we use needs it.

## Alternatives considered

- TypeScript 6.0: needed only for tools requiring the compiler API (TS 7.0 ships none until 7.1). We use none yet.
- Plain JavaScript: loses type-driven design (see 0007).

## Consequences

- Much faster type-checking.
- Tools that embed the TS compiler API may need `@typescript/typescript6` side-by-side.
- Online examples using removed options (`baseUrl`, `moduleResolution: node`, ...) must not be copied.
