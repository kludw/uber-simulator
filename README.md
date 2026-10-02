# uber-simulator

Ride-hailing simulator for learning and fun: drivers, riders, and dispatch run as independent services over NATS on a synthetic city grid, watched live in the browser. What it does: [docs/spec.md](docs/spec.md). Why: [docs/adr](docs/adr/README.md).

Status: milestone 2 in progress. Driver brain places drivers, wanders idle ones, and carries trips from offer to completion. Dispatch brain accepts trip requests, tracks driver positions, each tick offers queued trips to the nearest idle driver, and matches accepted offers or requeues declined and expired ones, confirms pickup and completion on driver arrivals, and cancels trips before pickup. Rider brain spawns riders (Poisson demand) that request trips, cancel when their patience runs out, and leave once their trip completes or is cancelled. An in-memory bus delivers messages deterministically (publish order), and a generic service shell runs any brain on it (publishes outputs, logs rejected inputs). A runner starts driver shards, dispatch, and riders on that bus and drives them for N ticks, returning the event log; same seed and config give the same log. An invariant checker reports spec invariant violations (`docs/spec.md`) from an event log alone. `bun run sim` runs it all headless and prints a summary. No NATS bus adapter or UI yet; a local NATS server runs via Docker Compose. How it fits together: [docs/architecture.md](docs/architecture.md).

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

Prints seed, ticks, drivers, trips requested / completed / cancelled, mean ticks from request to pickup, rejected inputs, and invariant violations (one JSON line each). Exit code 0 ok, 1 invariant violated, 2 invalid args.

## Commands

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
