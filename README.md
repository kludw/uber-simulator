# uber-simulator

Ride-hailing simulator for learning and fun: drivers, riders, and dispatch run as independent services over NATS on a synthetic city grid, watched live in the browser. What it does: [docs/spec.md](docs/spec.md). Why: [docs/adr](docs/adr/README.md).

Status: setup only, no simulation code yet.

## Prerequisites

- [Bun](https://bun.com) 1.4.2

## Setup

```bash
bun install
```

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

`bun run typecheck` works once `src/` contains TypeScript (`tsc` errors with no inputs).

## Workflow

Tickets, PRs, review, CI: [ADR 0021](docs/adr/0021-development-workflow.md).
