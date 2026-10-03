# uber-simulator

Ride-hailing simulator for learning and fun: drivers, riders, and dispatch run as independent services over NATS on a synthetic city grid, watched live in the browser. What it does: [docs/spec.md](docs/spec.md). Why: [docs/adr](docs/adr/README.md).

Status: milestone 4 done. Driver brain places drivers, wanders idle ones, and carries trips from offer to completion. Dispatch brain accepts trip requests, tracks driver positions, each tick offers queued trips to the nearest idle driver, and matches accepted offers or requeues declined and expired ones, confirms pickup and completion on driver arrivals, and cancels trips before pickup. Rider brain spawns riders (Poisson demand) that request trips, cancel when their patience runs out, and leave once their trip completes or is cancelled. An in-memory bus delivers messages deterministically (publish order), and a generic service shell runs any brain on it (publishes outputs, logs rejected inputs). A runner starts driver shards, dispatch, and riders on that bus and drives them for N ticks, returning the event log; same seed and config give the same log. An invariant checker reports spec invariant violations (`docs/spec.md`) from an event log alone. `bun run sim` runs it all headless and prints a summary. A NATS bus adapter implements the same bus over a local NATS server (Docker Compose), and `bun run dev` runs clock, dispatch, riders, and each driver shard as its own process on it. `bun run sim -- --bus nats` runs the same simulation over NATS, each service on its own connection; integration tests check it breaks no invariant. `bun run ui` serves a browser page that subscribes to the events over NATS WebSocket and draws the live city on a canvas with a side panel of counters. How it fits together: [docs/architecture.md](docs/architecture.md).

## Prerequisites

- [Bun](https://bun.com) 1.4.2
- [Docker](https://docs.docker.com) with Compose (for local NATS)

## Setup

```bash
bun install
```

```bash
cp .env.example .env
```

## Local infra

NATS with JetStream and a websocket listener ([docs/architecture.md](docs/architecture.md#local-infra)). Start and wait until healthy:

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

Stop (keeps JetStream data in the `nats-data` volume):

```bash
docker compose down
```

## Run

Seeded headless run at spec scale (500 × 500 grid, 2 shards × 50 drivers, 10 trip requests/min). Defaults: `--seed 1 --ticks 3600` (1 simulated hour).

```bash
bun run sim -- --seed 42 --ticks 3600
```

Prints seed, ticks, drivers, trips requested / completed / cancelled, mean ticks from request to pickup, rejected inputs, and invariant violations (one JSON line each). Exit code 0 ok, 1 invariant violated, 2 invalid args or `NATS_URL`, 3 NATS unreachable.

Same run over NATS, each service on its own connection, ticks as fast as the services settle (needs the local NATS server and `NATS_URL`, see Local infra; don't run `bun run dev` on the same server at the same time). Only each publisher's order is guaranteed, so the counts can differ from the in-process run and between runs:

```bash
bun run sim -- --seed 42 --ticks 600 --bus nats
```

### As separate processes over NATS

Needs the local NATS server (`docker compose up -d --wait`). Starts dispatch, riders, one process per driver shard, and the clock; their output is prefixed by service, one JSON log line per entry (started with seed, NATS disconnect/reconnect/close, rejected inputs, dropped messages, stopped). Ctrl+C stops them all; so does any one of them exiting (exit code 1).

```bash
bun run dev
```

Config from env (Bun loads `.env`; defaults are spec scale, real time):

| Variable | Default | Meaning |
| --- | --- | --- |
| `NATS_URL` | (required) | NATS server |
| `SEED` | `1` | seed for every service's random stream |
| `SPEED` | `1` | sim seconds per wall second: one tick every 1 s / `SPEED` |
| `CLOCK_START_DELAY_MS` | `2000` | wall time the clock waits before tick 1, so the other services are subscribed |
| `DRIVER_SHARDS` | `2` | driver shard processes |
| `DRIVERS_PER_SHARD` | `50` | drivers in each shard |
| `REQUESTS_PER_MINUTE` | `10` | rider demand |

E.g. 100× real time, so trips complete within seconds:

```bash
SPEED=100 bun run dev
```

### Watch it in the browser

With the local NATS server and `bun run dev` running (separate terminals), serve the UI:

```bash
bun run ui
```

Open http://localhost:3000. The canvas shows the city: drivers as dots colored by state, waiting riders as hollow squares, active trips as pickup -> dropoff lines. The side panel shows the tick, counters, the legend, and the connection status (connecting / live / disconnected). The page joins mid-run and reconnects on its own if NATS restarts.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NATS_WS_URL` | (required) | NATS websocket the browser connects to |
| `UI_PORT` | `3000` | port the page is served on |

Exit code 2: invalid config.

A single service: `bun src/clock/main.ts`, `bun src/dispatch/main.ts`, `bun src/rider/main.ts`, `SHARD_INDEX=0 bun src/driver/main.ts`. Exit codes: 0 stopped by SIGINT/SIGTERM, 1 NATS connection failed or lost, 2 invalid config.

## Commands

NATS integration tests (bus, distributed runs) need the local NATS server (`docker compose up -d --wait`) and `NATS_URL` (Bun loads `.env`); without `NATS_URL` they are skipped with a warning.

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
