---
name: clickhouse
description: ClickHouse persistence and analytics for simulation events - client, local Docker setup, table design, batched inserts, queries. Use whenever writing to or querying ClickHouse, designing tables/schemas, writing DDL, or touching the persistence adapter.
---

# ClickHouse (https://clickhouse.com/docs)

Do not rely on your training data. Before using any ClickHouse SQL, setting, type, or client API not listed below: find the page in https://clickhouse.com/docs/llms.txt, fetch it as `.md` (e.g. `https://clickhouse.com/docs/integrations/javascript.md`), follow it. Client README/examples: https://github.com/ClickHouse/clickhouse-js. Docs win over this file. Deprecated per docs/CHANGELOG = don't use. Unsure + no doc found = ask me.

Snapshot verified against clickhouse.com/docs + clickhouse-js README/CHANGELOG on 2026-10-02 (`@clickhouse/client` latest = 1.23.1). If docs now differ, follow docs and flag it.

## Role

1. ClickHouse = append-only event store + analytics. Sim writes events; UI/analysis reads. Sim never reads back from ClickHouse to make decisions (see `simulation` skill).
2. Access only via the persistence adapter. Core never imports the client. Failures -> typed `Result` errors (see `errors` skill).

## Client

1. Use `@clickhouse/client` (0013), gated by a smoke test under Bun (connect, DDL, batched JSONEachRow insert, query). Smoke test fails -> fall back to HTTP interface via Bun `fetch`, and tell me.
2. Config keys: `url` (not deprecated `host`), `username`, `password`, `database`, `request_timeout`, `clickhouse_settings`. Use `http_headers`, not deprecated `additional_headers`.
3. Import from `@clickhouse/client`, never `@clickhouse/client-common` (deprecated 1.23.0).
4. API: `createClient({...})`, `client.insert({ table, values, format: "JSONEachRow" })`, `client.query({ query, format: "JSONEachRow" })` then `await resultSet.json()`, `client.command({ query })` for DDL, `client.close()` on shutdown.

## Local setup

1. Runs via Docker Compose (see `docker` skill). Image `clickhouse/clickhouse-server`. HTTP interface port 8123 (client uses this), native 9000.
2. Env: `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DB`. Connection settings from env, validated with Zod (see `validation` skill).

## Writes

1. Batch client-side. Docs: at least 1,000 rows per insert, ideally 10,000–100,000. Many small sync inserts cause "too many parts" errors.
2. Can't batch enough (e.g. live mode, low volume)? Use async inserts with `clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 }` (docs' strong recommendation for async mode).
3. Adapter buffers events, flushes on size or interval, flushes on shutdown before `close()`.

## Tables

1. Engine `MergeTree`. Ordering key = columns most used in `WHERE`, lower cardinality first. Can't be changed after creation: confirm with me before creating.
2. `LowCardinality(String)` for columns with < ~10,000 unique values (event type, state).
3. Prefer `DateTime` over `DateTime64` unless sub-second precision needed. Sim time is tick-based (see `simulation` skill), store tick as integer; wall-clock ingestion time optional.
4. Column/event names from `domain` skill.
5. DDL lives in `infra/clickhouse/NNN_name.sql`, applied in name order by `bun run db:migrate` and by the persister on every start. Each file must be idempotent (`IF NOT EXISTS`); no migrations table.

## Adapter

`src/persistence/clickhouse.ts`: `connectClickHouse(config)` (runs `SELECT 1` in the configured database, so bad credentials or a missing database fail here), `insertEvents`, `query(sql, params)` (rows unvalidated: parse with Zod), `command(sql)`, `close()`, `migrate(clickhouse)`. Config from env via `parseClickHouseConfig` (`src/sim/config.ts`). Integration tests use a throwaway database and skip without `CLICKHOUSE_URL`. Analytics queries live in `src/analytics/` (`bun run report`): `FINAL` for exact counts, ids bound via `{name:Type}` params, never interpolated.
