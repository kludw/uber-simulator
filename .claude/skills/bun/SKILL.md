---
name: bun
description: Bun runtime, package manager, and test runner reference for this project. Use whenever installing/adding packages, running files or scripts, running or writing tests (bun test, bun:test), or using any Bun API, CLI flag, or config.
---

# Bun (https://bun.com/docs)

Do not rely on your training data, APIs have changed. Before using any Bun API, CLI flag, or config not listed below: find the page in https://bun.com/llms.txt, fetch its `.md` (e.g. `https://bun.com/docs/test/writing-tests.md`), follow it. Unsure + no doc found = ask me.

Prefer Bun APIs over external dependencies unless there's a valid reason (flag it up, present case and let user make the decision).

Every command below verified against bun.com/docs (pm/cli/install, pm/cli/add, pm/bunx, runtime, typescript, test/writing-tests, test/discovery, test/code-coverage, guides/test/watch-mode).

1. Install deps: `bun install`. Add: `bun add <pkg>`. Dev dep: `bun add -d <pkg>`. Pin exact: `-E`.
2. Run file/script: `bun run <file|script>`. One-off package binaries: `bunx <pkg>`.
3. Types for Bun APIs: `bun add -d @types/bun`.
4. Tests: `bun test`. Import from `"bun:test"` (`import { describe, expect, test } from "bun:test"`).
5. Test files: `*.test.ts` (Bun also finds `_test`, `.spec`, `_spec`).
6. Run subset: `bun test <path-substring>`. Exact file: `bun test ./path/file.test.ts`. By name: `bun test -t <regex>`.
7. Watch: `bun test --watch`. Coverage: `bun test --coverage`.
