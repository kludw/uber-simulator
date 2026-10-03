# uber-simulator

Ride-hailing simulator for learning and fun: drivers, riders, and dispatch run as independent services over NATS on a synthetic city grid, watched live in the browser. What it does: [docs/spec.md](docs/spec.md). Why: [docs/adr](docs/adr/README.md).

Status: milestone 4 done. Driver brain places drivers, wanders idle ones, and carries trips from offer to completion. Dispatch brain accepts trip requests, tracks driver positions, each tick offers queued trips to the nearest idle driver, and matches accepted offers or requeues declined and expired ones, confirms pickup and completion on driver arrivals, and cancels trips before pickup. Rider brain spawns riders (Poisson demand) that request trips, cancel when their patience runs out, and leave once their trip completes or is cancelled. An in-memory bus delivers messages deterministically (publish order), and a generic service shell runs any brain on it (publishes outputs, logs rejected inputs). A runner starts driver shards, dispatch, and riders on that bus and drives them for N ticks, returning the event log; same seed and config give the same log. An invariant checker reports spec invariant violations (`docs/spec.md`) from an event log alone. `bun run sim` runs it all headless and prints a summary. A NATS bus adapter implements the same bus over a local NATS server (Docker Compose), and `bun run dev` runs clock, dispatch, riders, and each driver shard as its own process on it. `bun run sim -- --bus nats` runs the same simulation over NATS, each service on its own connection; integration tests check it breaks no invariant. `bun run ui` serves a browser page that subscribes to the events over NATS WebSocket and draws the live city on a canvas with a side panel of counters. Milestone 5 in progress: a local ClickHouse (Docker Compose) with an `events` table (`bun run db:migrate`), and a persister service (started by `bun run dev`) that stores every event from a NATS JetStream stream in it, tagged with the run id; no analytics queries yet. How it fits together: [docs/architecture.md](docs/architecture.md).

## Prerequisites

- [Bun](https://bun.com) 1.4.2
- [Docker](https://docs.docker.com) with Compose (for local NATS and ClickHouse)

## Setup

```bash
bun install
```

```bash
cp .env.example .env
```

## Local infra

NATS with JetStream and a websocket listener, and ClickHouse ([docs/architecture.md](docs/architecture.md#local-infra)). ClickHouse's user, password, and database come from `.env` (`CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DB`) and are created on its first start. Start and wait until healthy:

```bash
docker compose up -d --wait
```

Status and logs:

```bash
docker compose ps
```

```bash
docker compose logs -f nats
```

Create the ClickHouse `events` table (ADR 0029) from `infra/clickhouse/*.sql`; rerunning is a no-op. The persister also does this on every start, so `bun run dev` doesn't need it. Exit code 0 applied, 1 ClickHouse unreachable or a migration failed, 2 invalid config:

```bash
bun run db:migrate
```

Stop (keeps JetStream data in the `nats-data` volume, ClickHouse data in `clickhouse-data`):

```bash
docker compose down
```

## Run

Seeded headless run at spec scale (500 × 500 grid, 2 shards × 50 drivers, 10 trip requests/min). Defaults: `--seed 1 --ticks 3600` (1 simulated hour).

```bash
bun run sim -- --seed 42 --ticks 3600
```

Prints seed, ticks, drivers, trips requested / completed / cancelled, mean ticks from request to pickup, rejected inputs, and invariant violations (one JSON line each). Exit code 0 ok, 1 invariant violated, 2 invalid args or `NATS_URL`, 3 NATS unreachable.

Same run over NATS, each service on its own connection, ticks as fast as the services settle (needs the local NATS server and `NATS_URL`, see Local infra; don't run `bun run dev` on the same server at the same time). Only each publisher's order is guaranteed, so the counts can differ from the in-process run and between runs. The summary starts with `run id: <id>`, a fresh UUID per run carried as the `Run-Id` header on every message ([ADR 0029](docs/adr/0029-event-persistence.md)):

```bash
bun run sim -- --seed 42 --ticks 600 --bus nats
```

### As separate processes over NATS

Needs the local NATS server and ClickHouse (`docker compose up -d --wait`); the persister creates the `events` table itself on start. Starts the persister, then (once its stream exists, so no event is missed) dispatch, riders, one process per driver shard, and the clock; if the persister isn't ready within 30 s, everything stops (exit code 1). Their output is prefixed by service, one JSON log line per entry (started with run id and seed, NATS disconnect/reconnect/close, rejected inputs, dropped messages, stopped). Ctrl+C stops them all; so does any one of them exiting (exit code 1).

Each start gets a new run id (a UUID), printed first as `[dev] run id: <id>` and in every `service_started` line. Every message the services publish carries it as a `Run-Id` NATS header ([ADR 0029](docs/adr/0029-event-persistence.md)); it is how persisted events are told apart by run.

```bash
bun run dev
```

Config from env (Bun loads `.env`; defaults are spec scale, real time):

| Variable | Default | Meaning |
| --- | --- | --- |
| `NATS_URL` | (required) | NATS server |
| `RUN_ID` | (set by `bun run dev`) | run id stamped on every publish; letters, digits, `-`, `_`. Required when starting a service entrypoint directly |
| `SEED` | `1` | seed for every service's random stream |
| `SPEED` | `1` | sim seconds per wall second: one tick every 1 s / `SPEED` |
| `CLOCK_START_DELAY_MS` | `2000` | wall time the clock waits before tick 1, so the other services are subscribed |
| `DRIVER_SHARDS` | `2` | driver shard processes |
| `DRIVERS_PER_SHARD` | `50` | drivers in each shard |
| `REQUESTS_PER_MINUTE` | `10` | rider demand |
| `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DB` | (required) | ClickHouse the persister writes to |

E.g. 100× real time, so trips complete within seconds:

```bash
SPEED=100 bun run dev
```

### See the stored events

The persister ([ADR 0029](docs/adr/0029-event-persistence.md)) reads every `sim.events.>` message from the JetStream stream `SIM_EVENTS` (kept 24 h, so events published while it is down are stored once it is back) and inserts them into the `events` table within about a second, at least once: a redelivered event is stored again with the same `stream_seq` and collapses on merge, so exact queries use `FINAL`. Events without a `Run-Id` header get `run_id = 'unknown'`. Events published by the NATS integration tests (`bun run test`) also land in the stream once it exists, and the next persister run stores them under the tests' run ids. Its log lines: `service_started`, `message_dropped` (payload not an event), `insert_failed` (retried after 1, 2, 4, 8 s), `batch_not_persisted` (redelivered after 60 s), `service_stopped`. Run alone: `bun src/persister/main.ts` (migrates the `events` table first; exit codes 0 stopped by SIGINT/SIGTERM, 1 NATS / ClickHouse unreachable, migration or JetStream failed, 2 invalid config).

With `bun run dev` running (or after it), event counts per run and type, using the image's `clickhouse-client` and the `.env` defaults (user, password, database `sim`):

```bash
docker compose exec clickhouse clickhouse-client --user sim --password sim -d sim -q "SELECT run_id, type, count() FROM events FINAL GROUP BY run_id, type ORDER BY run_id, type"
```

One run's trips, by the run id `bun run dev` printed:

```bash
docker compose exec clickhouse clickhouse-client --user sim --password sim -d sim --param_run=<run id> -q "SELECT tick, type, trip_id, driver_id, rider_id FROM events FINAL WHERE run_id = {run:String} AND type LIKE 'trip.%' ORDER BY tick, stream_seq LIMIT 20"
```

### Watch it in the browser

With the local NATS server and `bun run dev` running (separate terminals), serve the UI:

```bash
bun run ui
```

Open http://localhost:3000. The canvas shows the city: drivers as dots colored by state, waiting riders as hollow squares, active trips as pickup -> dropoff lines. The side panel shows the tick, counters, the legend, and the connection status (connecting / live / disconnected). The page joins mid-run and reconnects on its own if NATS restarts.

![Live city at SPEED=10: drivers, waiting riders, trip lines, side panel](docs/images/ui-live.jpg)

| Variable | Default | Meaning |
| --- | --- | --- |
| `NATS_WS_URL` | (required) | NATS websocket the browser connects to |
| `UI_PORT` | `3000` | port the page is served on |

Exit code 2: invalid config.

A single service: `bun src/clock/main.ts`, `bun src/dispatch/main.ts`, `bun src/rider/main.ts`, `SHARD_INDEX=0 bun src/driver/main.ts`. Exit codes: 0 stopped by SIGINT/SIGTERM, 1 NATS connection failed or lost, 2 invalid config.

## Commands

Integration tests need the local infra (`docker compose up -d --wait`) and its URLs (Bun loads `.env`): NATS tests (bus, distributed runs) need `NATS_URL`, ClickHouse adapter tests need `CLICKHOUSE_URL` and the other `CLICKHOUSE_*` variables (they work in a throwaway database), persister tests need both (their own streams and a throwaway database). Without the URL, each group is skipped with a warning.

```bash
bun run test
```

```bash
bun run lint
```

```bash
bun run check
```

```bash
bun run typecheck
```

## Workflow

Tickets, PRs, review, CI: [ADR 0021](docs/adr/0021-development-workflow.md).
