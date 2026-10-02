# 0013. ClickHouse client for Bun

- Status: Proposed
- Date: 2026-10-02

## Context

ClickHouse has no official Bun client (https://github.com/ClickHouse/clickhouse-js README points alternative runtimes to ALTERNATIVE_CLIENTS.md). Official packages (latest 1.23.1):

- `@clickhouse/client`: Node-only, built on HTTP and Stream APIs. Bun's docs list `node:http`, `node:stream`, `node:zlib` as fully implemented (https://bun.com/docs/runtime/nodejs-compat).
- `@clickhouse/client-web`: Fetch + Web Streams, targets browsers and Cloudflare Workers.

Project rule: prefer Bun APIs over dependencies unless there's a stated case (0002).

## Decision

We will use `@clickhouse/client`, gated by a smoke test under Bun (connect, DDL, batched JSONEachRow insert, query). If the smoke test fails, fall back to the HTTP interface via Bun `fetch`.

## Rationale

- The official client gives formats, settings, async inserts, and error handling maintained by ClickHouse; reimplementing them is code we'd own forever.
- Bun documents the Node modules it depends on as fully implemented, so it's likely to work; the smoke test turns 'likely' into verified.
- The fetch fallback keeps us unblocked if it fails, and still satisfies the prefer-Bun rule.

## Alternatives considered

- `@clickhouse/client-web`: also unverified on Bun; targets other runtimes.
- Raw HTTP via Bun `fetch`: no dependency, but we reimplement formats, settings, errors, and streaming.

## Consequences

- Official client features (settings, formats, compression) without custom code.
- Depends on Bun's Node compatibility; regressions caught by the smoke test.
