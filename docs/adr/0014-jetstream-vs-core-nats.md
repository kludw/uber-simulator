# 0014. JetStream vs core NATS per message flow

- Status: Proposed
- Date: 2026-10-02

## Context

Core NATS is fire-and-forget: messages without a live subscriber are lost. JetStream adds persistence, acks, and durable consumers (`@nats-io/jetstream`). Flows: domain events to the ClickHouse writer, domain events to the live UI, commands from the UI to the simulation.

## Decision

We will use:

- JetStream for domain events consumed by the ClickHouse writer (durable consumer, explicit ack, `msgID` dedupe), so writer restarts lose nothing.
- Core NATS for live UI fan-out (latest state matters, gaps acceptable).
- Core NATS request/reply for UI commands to the simulation (caller gets an immediate accept/reject).

## Rationale

- The writer's job is a complete record; only JetStream guarantees no loss across writer restarts.
- The UI only needs current state; durability there adds overhead with no benefit, and a missed update is corrected by the next one.
- Commands need an immediate answer (accepted/rejected), which request/reply gives directly.
- Using each mode only where its guarantees matter keeps the system as simple as possible.

## Alternatives considered

- JetStream everywhere: storage and ack overhead on flows that don't need durability.
- Core NATS everywhere: events lost when the writer is down; ClickHouse incomplete.

## Consequences

- nats-server runs with JetStream enabled (`-js`, storage volume).
- Stream and consumer definitions become part of setup and docs.
