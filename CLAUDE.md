# Working agreement

## Communication

1. Don't assume. Surface confusion and tradeoffs immediately.
2. Be extremely concise. Sacrifice grammar for concision.
3. Push back when you disagree. Don't defer reflexively.
4. When blocked, stop and ask. Don't guess forward.

## Code

1. Minimum code that solves the problem. Nothing speculative.
2. Tests and logging needed for verification are not speculative.
3. Match existing style over "best practice."
4. Simplicity and clarity over cleverness.
5. Development done using TDD -> red -> green -> refactor. No exceptions unless user specifically says so. Load `tdd` skill before writing code or tests.
6. Follow Design (see below). Even if not using Go: we value Go's simplicity, not Go's typical sloppy styling. Load `design` skill before designing modules, types, or abstractions.
7. Domain terms from `domain` skill only. Load it before naming anything.
8. Simulation core deterministic: no wall clock, no unseeded randomness. Load `simulation` skill before touching sim logic, time, or randomness.
9. Expected failures = `Result`, bugs = throw. Load `errors` skill before handling errors or logging.

## Tooling

1. Bun for runtime, package manager, test runner. Load `bun` skill before any Bun command or API.
2. Biome for lint + format. Load `biome` skill before linting/formatting or finishing a change.
3. Zod (latest, per zod.dev docs) for all validation. Load `validation` skill before handling external/untrusted data or defining data shapes.
4. TypeScript (latest, currently 7.x, per official docs). Load `typescript` skill before writing TS, editing tsconfig, or type-checking.
5. NATS for messaging. Load `nats` skill before publishing/consuming messages or defining subjects.
6. ClickHouse for persistence + analytics. Load `clickhouse` skill before reading/writing it or designing tables.
7. Docker Compose for local infra. Load `docker` skill before editing compose.yaml/Dockerfiles or managing containers.
8. No npm/yarn/pnpm/node, no ESLint/Prettier, no Jest/Vitest, no other validation libs.

## Design

1. Deep modules: small interface, hidden complexity. Each design decision lives in one module. No pass-through or wrapper-only functions.
2. Illegal states unrepresentable: state = discriminated union, IDs branded. Parse at the edge, core trusts types.
3. Functional core, imperative shell. Core pure; I/O in adapters; dependencies point inward.
4. Abstract on third real use (AHA). Extract only to hide complexity or reuse, not because a block has a name.
5. Names describe purpose, use domain terms. No `tmp`, `data2`, vague verbs. Rename when meaning shifts.
6. Flatten nesting. Errors first, early `continue`/`return`, happy path falls through.
7. Optimize only with a profile.

## Scope

1. Touch only what the task requires.
2. Spotted an adjacent bug? Flag it. Don't fix unprompted.
3. Ask before refactors, renames, or moving files.

## Docs

1. Docs written alongside code, in the same change. Change not done until affected docs (README, `docs/architecture.md`, ADRs, skills) are updated.
2. Every architecture decision has an ADR in `docs/adr/`. Propose ADR before implementing; accepted ADRs immutable, superseded not edited.
3. Load `docs` skill before making a decision, changing setup/components/data flow, or finishing a change.

## Verification

1. State success criteria before starting. Confirm with me if unclear.
2. Loop until criteria met. Report what you verified and how.
3. Docs updated and README commands verified as part of done.
