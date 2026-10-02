---
name: validation
description: Project rules for data validation with Zod (latest). Use whenever code receives or parses external/untrusted data (HTTP bodies, query params, env vars, JSON.parse, files, API responses, CLI args, config), defines data shapes/types, or handles validation errors.
---

# Validation (Zod, https://zod.dev)

Always latest Zod. Do not rely on your training data, APIs have changed (most examples online are outdated). Before writing Zod code: find the page in https://zod.dev/llms.txt (full text: https://zod.dev/llms-full.txt), follow it. Docs win over this file. Deprecated per docs = don't use. Unsure + no doc found = ask me.

API list below is a snapshot verified against zod.dev (llms-full.txt, v4/changelog) on 2026-10-02. If docs now differ, follow docs and flag it so this file gets updated.

## Rules

1. All validation uses Zod. No hand-rolled `typeof`/`in` checks, no other validation libs.
2. Validate at system boundaries, once. Inside the boundary, trust the inferred type.
3. Schema is the source of truth. Types via `z.infer<typeof Schema>`, never a hand-written duplicate type. Use `z.input<>` / `z.output<>` when transforms make them differ.
4. Untrusted input: `safeParse()` and handle `result.success`. `parse()` (throws) only where failure is a bug, not user error.
5. Async refinements: `parseAsync()` / `safeParseAsync()`.

## Current APIs (use these, not deprecated forms)

1. Install latest: `bun add zod@latest`. Import: `import * as z from "zod"`.
2. String formats top-level: `z.email()`, `z.uuid()`, `z.url()`. Not `z.string().email()` (deprecated).
3. Custom errors: `{ error: "..." }`. Not `{ message }` (deprecated) or `errorMap` (replaced by `error`).
4. Error formatting: `z.flattenError(err)` (flat), `z.treeifyError(err)` (nested), `z.prettifyError(err)` (string). Not `.flatten()` / `.format()` (deprecated).
5. Unknown keys: `z.strictObject()` / `z.looseObject()`. Not `.strict()` / `.passthrough()` (deprecated).
6. Combine objects: `A.extend(B.shape)`. Not `.merge()` (deprecated).
7. TS enums: `z.enum(MyEnum)`. Not `z.nativeEnum()` (deprecated).
8. Multi-issue refinements: `.check()`. Not `.superRefine()` (deprecated). Simple predicate: `.refine()`.
