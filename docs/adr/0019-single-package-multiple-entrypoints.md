# 0019. One package with an entrypoint per service

- Status: Accepted
- Date: 2026-10-02

## Context

0017 splits the system into ~6 processes (clock, driver ×2, rider, dispatch, persister) plus a browser UI. They share domain types, schemas, and the bus port.

## Decision

We will keep one Bun package. Each service has its own entrypoint file; shared domain code lives in the same package. Infra (NATS, ClickHouse) runs in Docker Compose; services run locally, all spawned by `bun run dev`.

## Rationale

- One tsconfig, one biome config, one dependency set: minimal setup.
- Shared types need no publishing or workspace linking.
- Running services outside Docker keeps the edit-run loop fast.

## Alternatives considered

- Bun workspaces (`core`, `services/*`, `ui`): enforces boundaries, more config. Revisit when boundaries leak or the UI needs its own build.
- All services in Docker Compose: closer to deployment, slower loop. Revisit for the portfolio demo setup.

## Consequences

- Module boundaries enforced by convention and review, not package boundaries.
- A later move to workspaces or containerized services needs a new ADR.
