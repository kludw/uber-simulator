# 0028. NATS bus: plain subjects for every message, local predicate filtering

- Status: Accepted
- Date: 2026-10-02
- Supersedes 0014, 0015, and 0018's offer transport

## Context

Milestone 3 runs each service as its own process over NATS, behind the `Bus` port from ADR 0027 (`publish`, `subscribe(accepts, handle)` with type-guard predicates). 0014 planned request/reply for offers and commands; 0015 defined subjects for events and commands only. Since then, every reply became an ordinary `Message` (ADR 0027) and dispatch expires offers in ticks inside its brain (ADR 0018), so a transport-level request timeout duplicates logic (this also replaces the "via request/reply" transport detail in 0018; its matching rules stand). NATS delivers messages "in order from a given publisher, but not across different publishers" (https://github.com/nats-io/nats.docs/blob/master/reference/faq.md#does-nats-offer-any-guarantee-of-message-ordering). Core NATS doesn't guarantee that two subscribers see messages in the same order under load (https://docs.nats.io/learn/core-nats/publish-subscribe). The spec relies on dispatch's `offer` reaching a driver before a `trip.cancelled` naming it.

## Decision

We will:

- Publish every `Message` with plain core NATS publish, JSON-encoded, on:
  - `sim.events.<entity>.<verb>` for events, incl. `sim.events.clock.ticked`;
  - `sim.commands.<name>` for commands (`request_trip`, `cancel_trip`);
  - `sim.offers.<driverId>` for offers;
  - `sim.replies.<name>` for replies (`offer_accepted`, `offer_declined`, `request_trip_accepted`, ...).
- Give each service its own connection with one subscription on `sim.>`. The adapter parses every message with Zod (ADR 0005); invalid payloads are logged and dropped. Valid messages go through the service's `accepts` predicate, handled one at a time in arrival order.
- Use no request/reply. Timeouts stay in brains, in ticks.
- Use JetStream only for the persister (milestone 5): a stream on `sim.events.>` with a durable consumer.
- Enable the server's websocket listener for the browser UI (ADR 0020).

## Rationale

- Plain subjects keep the `Bus` port unchanged; shells and brains run identically on the in-memory and NATS buses.
- One `sim.>` subscription per connection keeps each publisher's order for that subscriber. Offer-before-cancel only needs that: both come from dispatch's single connection and are consumed by one driver-shard subscriber. Cross-publisher order is not guaranteed and nothing relies on it.
- Local predicate filtering costs every service all traffic; at 100 drivers (~200 msg/s) that's trivial. Per-service subject subscriptions are the scaling step when needed.
- Typed subject tokens (`events`, `commands`, `offers`, `replies`) keep direction readable and allow wildcard taps (`sim.events.>` for UI and persister).

## Alternatives considered

- Request/reply for offers and commands (0014): duplicate timeout logic, and the `Bus` port would need an async request API.
- Per-service subject subscriptions now: less traffic, but ordering across subscriptions isn't guaranteed and predicates would need a parallel subject list.
- JetStream for all traffic: durability nobody needs for live services.

## Consequences

- 0014 and 0015 superseded; `nats` skill updated.
- A message lost in transit is handled by brain timeouts and the rejection paths built in milestone 1.
- The NATS server needs a config file to enable websockets.
