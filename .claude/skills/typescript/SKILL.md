---
name: typescript
description: Project rules for TypeScript (latest, currently 7.x native Go compiler). Use whenever writing TypeScript, editing tsconfig.json, running type-checks (tsc), choosing language/lib features, or fixing type errors.
---

# TypeScript (latest, https://www.typescriptlang.org)

Always latest TypeScript. Do not rely on your training data: TS 6.0 changed defaults and deprecated many options, TS 7.0 (native Go port) turned those deprecations into hard errors. Before using any compiler option, CLI flag, or newer language/lib feature not listed below, check official sources and follow them:

- Release notes: https://www.typescriptlang.org/docs/handbook/release-notes/overview.html (6.0: `.../release-notes/typescript-6-0.html`)
- Announcements (7.x lands here first): https://devblogs.microsoft.com/typescript/ (7.0: `/announcing-typescript-7-0/`)
- tsconfig reference: https://www.typescriptlang.org/tsconfig
- Current version: `npm view typescript dist-tags`

Docs win over this file. Deprecated or removed per docs = don't use. Unsure + no doc found = ask me.

Snapshot below verified against TS 7.0 announcement, TS 6.0 release notes, and bun.com/docs/typescript-6 on 2026-10-02 (npm `latest` = 7.0.2). If docs now differ, follow docs and flag it so this file gets updated.

## Tooling

1. Install: `bun add -d typescript@latest @types/bun`.
2. Type-check: `bun run typecheck` (runs `tsc` then `tsc -p src/ui`; both `noEmit`). Bun runs TS but type-check is a separate step.
3. Don't pass file paths to `tsc` when a tsconfig exists: error in 7.0 unless `--ignoreConfig`.
4. TS 7.0 ships no programmatic API (expected in 7.1). Tools importing `typescript` as a library may need `@typescript/typescript6` side-by-side. Check the 7.0 announcement before adding such a tool.
5. `@typescript/native-preview` is superseded. Nightlies: `typescript@next`.

## tsconfig

1. Base: Bun's recommended tsconfig (bun.com/docs/typescript-6). Includes `"types": ["bun"]`, `module: "Preserve"`, `moduleResolution: "bundler"`, `noEmit`, `strict`.
2. `types` defaults to `[]`: list every `@types` package needed (`["bun"]`, ...). Missing globals like `Bun` = this.
3. `rootDir` defaults to `./`. Set it explicitly if sources live in `src/` and output structure matters.
4. Defaults now: `strict: true`, `module: esnext`, `noUncheckedSideEffectImports: true`, `stableTypeOrdering: true` (can't turn off).
5. Browser code (`src/ui/`) has its own `src/ui/tsconfig.json`: extends the root, adds `"DOM"` to `lib`. Root excludes `src/ui`, so DOM globals stay out of server code. New browser dirs go under `src/ui/`.
6. Removed (hard errors in 7.0), never use: `target: es5`, `downlevelIteration`, `moduleResolution: node`/`node10`/`classic`, `module: amd`/`umd`/`systemjs`/`none`, `baseUrl` (make `paths` relative to project root), `outFile`, `esModuleInterop: false`, `allowSyntheticDefaultImports: false`, `alwaysStrict: false`.

## Syntax

1. Namespaces: `namespace Foo {}`. Not `module Foo {}` (error). `declare module "pkg" {}` still fine.
2. Import attributes: `import x from "./x.json" with { type: "json" }`. Not `asserts { ... }` (error).
3. Template literal type inference splits by Unicode code point (`"😀"` = one unit), not UTF-16 code unit.

## Newer lib types (TS 6.0+)

Typed by TS; runtime support is Bun's job, so check bun.com/docs before relying on them.

1. `Map`/`WeakMap` `.getOrInsert()` / `.getOrInsertComputed()` (esnext lib).
2. `RegExp.escape()` (es2025 lib).
3. `Temporal` (esnext lib).
