# 0029. Persist events from JetStream into one ClickHouse events table

- Status: Accepted
- Date: 2026-10-02

## Context

Milestone 5 (`docs/spec.md`) persists every event to ClickHouse (ADR 0011, client per 0013) for analytics. ADR 0028 reserves JetStream for the persister. Live volume at 100 drivers is ~200 events/s, mostly `driver.moved`. ClickHouse wants at least 1,000 rows per insert, or async inserts when clients can't batch that much (https://clickhouse.com/docs/guides/inserting-data). Events carry no run identifier. Ordering keys can't change after table creation (`clickhouse` skill).

## Decision

We will:

- Add a persister service (shell only, no brain): on start it ensures a JetStream stream `SIM_EVENTS` on `sim.events.>` (file storage, max age 24 h) and a durable pull consumer `persister` (explicit ack). It batches messages (up to 5,000 or 1 s, whichever first), inserts each batch with `async_insert = 1, wait_for_async_insert = 1`, and acks the batch only after the insert succeeds (at-least-once).
- Identify runs by `RUN_ID` env: `bun run dev` generates one per start and passes it to the persister; a standalone persister generates its own.
- Store all events in one table:

  ```sql
  CREATE TABLE IF NOT EXISTS events (
    run_id      LowCardinality(String),
    type        LowCardinality(String),
    tick        UInt32,
    stream_seq  UInt64,
    trip_id     String,
    driver_id   String,
    rider_id    String,
    payload     String,
    ingested_at DateTime
  ) ENGINE = ReplacingMergeTree
  ORDER BY (run_id, type, tick, stream_seq)
  ```

  `trip_id` / `driver_id` / `rider_id` are empty when the event has none; `payload` is the full event JSON. Redelivered messages share `stream_seq`, so ReplacingMergeTree collapses duplicates; exact queries use `FINAL`.
- Keep DDL in `infra/clickhouse/*.sql`, applied idempotently by `bun run db:migrate`.
- Put analytics queries in `src/analytics/`, exposed via `bun run report -- --run <id>`.

## Rationale

- JetStream decouples the persister from live services: a persister restart loses nothing and live services never wait on ClickHouse.
- One wide table with extracted ID columns keeps writes trivial and covers the planned queries (per-run, per-type, over ticks); the raw payload keeps everything else.
- Ordering key: `run_id` (few values) and `type` (~15 values) first, then `tick`, matching every planned `WHERE`; `stream_seq` last makes the key unique per message, which ReplacingMergeTree needs for dedupe.
- Async inserts with wait are the documented choice when client batches stay below ~1,000 rows; 1 s batches at ~200 events/s land there.

## Alternatives considered

- One table per event type: typed columns, but many tables and schemas to keep in sync with `messages.ts`.
- Core NATS subscription for the persister: loses events whenever the persister is down.
- `run_id` inside every message: invasive change to every message type for one consumer.
- Plain MergeTree: duplicates on redelivery.

## Consequences

- At-least-once delivery; queries needing exact counts use `FINAL` (cheap at this scale).
- Changing the ordering key later means a new table and a migration.
- The in-memory runner (`bun run sim`) doesn't persist; persistence is a distributed-mode feature.
