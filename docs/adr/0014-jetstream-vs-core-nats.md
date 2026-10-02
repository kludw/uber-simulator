# 0014. JetStream vs core NATS per message flow

- Status: Superseded by 0028
- Date: 2026-10-02

## Context

Core NATS is fire-and-forget: messages without a live subscriber are lost. JetStream adds persistence, acks, and durable consumers (`@nats-io/jetstream`). Flows (0017, 0018): `clock.ticked` and domain events between services and to the live UI; commands to dispatch (`request_trip`, `cancel_trip`); offers from dispatch to drivers; domain events to the ClickHouse writer.

## Decision

We will use:

- Core NATS pub/sub for `clock.ticked` and domain events between services and to the UI (gaps acceptable; the next tick/move corrects state).
- Core NATS request/reply for commands to dispatch and offers to drivers (caller needs an immediate answer or a timeout).
- JetStream for domain events consumed by the ClickHouse writer (durable consumer, explicit ack, `msgID` dedupe), so writer restarts lose nothing. Added with the persister (milestone 5).

## Rationale

- The writer's job is a complete record; only JetStream guarantees no loss across writer restarts.
- The UI only needs current state; durability there adds overhead with no benefit, and a missed update is corrected by the next one.
- Commands and offers need an immediate answer (accepted/rejected) or a timeout, which request/reply gives directly.
- Using each mode only where its guarantees matter keeps the system as simple as possible.

## Alternatives considered

- JetStream everywhere: storage and ack overhead on flows that don't need durability.
- Core NATS everywhere: events lost when the writer is down; ClickHouse incomplete.

## Consequences

- nats-server runs with JetStream enabled (`-js`, storage volume).
- Stream and consumer definitions become part of setup and docs.
