# 0011. Use ClickHouse for event persistence and analytics

- Status: Accepted
- Date: 2026-10-02

## Context

The simulation produces a high-volume, append-only event stream. The project owner wants fast analytics over it and to experiment with ClickHouse.

## Decision

We will store simulation events in ClickHouse (https://clickhouse.com/docs) as an append-only event store. The simulation never reads from ClickHouse to make decisions. Writes are batched per official guidance. Rules: `.claude/skills/clickhouse/SKILL.md`. Open follow-up: 0013 (client choice); table schema/ordering key via a later ADR.

## Rationale

- Columnar storage is built for analytical scans over large append-only event streams, which is exactly the simulation's output.
- Fast aggregate queries make run analysis (wait times, utilization, matching quality) interactive.
- Keeping it write-only from the simulation's view preserves determinism (0008).
- Project owner wants to experiment with it; the workload is a good fit.

## Alternatives considered

- PostgreSQL: general-purpose, less suited to large analytical scans over events.
- SQLite (`bun:sqlite`): zero setup, not aimed at analytics at volume.

## Consequences

- Fast analytical queries over runs.
- Ordering keys can't be changed after table creation: schema decisions need an ADR first.
- No official Bun client (see 0013).
