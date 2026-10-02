# 0010. Use NATS for messaging

- Status: Accepted
- Date: 2026-10-02

## Context

Simulation, persistence writer, and UI need to exchange events and commands, and be able to run as separate processes.

## Decision

We will use NATS (https://docs.nats.io) with the `@nats-io/*` v3 client (`@nats-io/transport-node`, documented as Bun-compatible). Only adapters touch NATS. Rules: `.claude/skills/nats/SKILL.md`. Open follow-ups: 0014 (JetStream vs core NATS), 0015 (subject scheme).

## Rationale

- Lightweight single binary: trivial to run locally and in Docker.
- Subject-based pub/sub with wildcards fits fan-out of domain events to multiple consumers (writer, UI).
- Request/reply built in, useful for UI commands.
- JetStream adds durability where needed (0014) without a second system.
- The v3 client is documented as Bun-compatible.

## Alternatives considered

- Kafka/Redpanda: heavier to run locally for this scale.
- In-process event bus only: blocks splitting components into processes.

## Consequences

- Components decoupled and independently scalable.
- Legacy `nats` package and many online examples are outdated and must not be used.
