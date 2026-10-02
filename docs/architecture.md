# Architecture

What lives where and how it connects. Behavior: [spec.md](spec.md). Why: [ADRs](adr/README.md). Terms: `.claude/skills/domain/SKILL.md`.

Current state: milestone 2, everything in one process over an in-memory bus. Milestone 3 in progress: the NATS bus adapter exists ([0028](adr/0028-nats-bus-subjects-and-delivery.md)), service entrypoints and clock service don't yet. UI (4) and ClickHouse (5) are not built yet. Local NATS server runs via Docker Compose (see Local infra).

## Components

| Component | Where | Does | Decisions |
| --- | --- | --- | --- |
| Shared domain | `src/shared/` | grid and cells, message types (`Message` union), branded IDs, `Result`, seeded PRNG | [0016](adr/0016-initial-domain-model.md), [0009](adr/0009-result-type-for-expected-failures.md), [0023](adr/0023-own-seeded-prng.md) |
| Driver brain | `src/driver/brain.ts` | one shard of drivers: placement, wandering, offers, driving to pickup/dropoff | [0022](adr/0022-source-layout-and-brain-shape.md), [0025](adr/0025-driver-at-dropoff-state.md) |
| Dispatch brain | `src/dispatch/brain.ts`, `trip.ts` | owns every trip: queue, offers, matching, pickup, completion, cancel | [0018](adr/0018-dispatch-matching-via-offers.md) |
| Rider brain | `src/rider/brain.ts` | demand generator, riders, patience, cancels | [0016](adr/0016-initial-domain-model.md), [0022](adr/0022-source-layout-and-brain-shape.md) |
| Bus port | `src/bus/bus.ts` | `publish` / `subscribe` by type-guard predicate | [0027](adr/0027-in-process-bus-and-runner.md) |
| In-memory bus | `src/bus/in-memory.ts` | FIFO queue, `drain()` delivers in publish order | [0027](adr/0027-in-process-bus-and-runner.md) |
| NATS bus | `src/bus/nats.ts` | `connectNatsBus`: one connection, one `sim.>` subscription, Zod-parses each payload (invalid ones logged, dropped), then predicates; handlers one at a time in arrival order. `subjectFor` maps messages to subjects | [0028](adr/0028-nats-bus-subjects-and-delivery.md) |
| Service shell | `src/bus/service.ts` | runs any brain on the bus: feeds accepted messages to `decide`, publishes outputs, logs `input_rejected` | [0026](adr/0026-brains-reject-invalid-inputs.md), [0027](adr/0027-in-process-bus-and-runner.md) |
| Runner | `src/sim/run.ts` | starts driver shards, dispatch, riders; acts as clock; returns event log + rejected inputs | [0027](adr/0027-in-process-bus-and-runner.md) |
| Invariant checker | `src/sim/invariants.ts` | spec invariants from the event log alone, own trip model | [0017](adr/0017-independent-actor-services-with-pure-brains.md) |
| Summary | `src/sim/summary.ts` | run result -> counts, mean ticks to pickup, violations | - |
| CLI | `src/sim/main.ts` (`bun run sim`) | parses args (Zod), runs, prints summary, sets exit code | [0005](adr/0005-use-zod-for-validation.md), [0019](adr/0019-single-package-multiple-entrypoints.md) |

Brains are the functional core: pure, seeded, no I/O ([0017](adr/0017-independent-actor-services-with-pure-brains.md), `simulation` skill). Shell: `src/bus/`, `src/sim/run.ts`, `src/sim/main.ts`. Invariant checker and summary are pure but not brains. Dependencies point inward: brains import only `src/shared/`.

## Data flow

```
bun run sim -> main.ts --config--> runner
runner: start shards, dispatch, riders on in-memory bus
  each tick: publish clock.ticked, drain
    bus --message--> service shell --input--> brain.decide --outputs--> shell --publish--> bus
    every published message --> event log
runner --{ eventLog, rejected }--> summarize --> checkInvariants --> main.ts prints, exits
```

Services never call each other: commands (`request_trip`, `cancel_trip`), offers, replies, and events are all bus messages. Dispatch is the only source of `trip.*` events ([0018](adr/0018-dispatch-matching-via-offers.md)). Offers reach only the shard owning the driver via the shard's subscription predicate.

## Local infra

Docker Compose ([0012](adr/0012-use-docker-compose-for-local-infra.md)), `compose.yaml`; app runs on the host via Bun. Only the NATS bus integration tests connect so far (`NATS_URL`; CI runs a plain `nats` service container).

| Service | Image | Ports | Config |
| --- | --- | --- | --- |
| NATS | `nats:2.15.0-alpine` | 4222 clients, 8222 monitoring (`/healthz` = healthcheck), 9222 websocket (no TLS, local only) | `infra/nats.conf`: JetStream on named volume `nats-data` (`/data`), websocket for the UI ([0020](adr/0020-browser-ui-canvas-nats-websocket.md), [0028](adr/0028-nats-bus-subjects-and-delivery.md)) |

Client URLs: `.env.example` (`NATS_URL`, `NATS_WS_URL`).

## Where decisions live

- Grid geometry, distance, moves: `src/shared/grid.ts`.
- Message shapes, names, and wire parsing (Zod schemas, `parseMessage`): `src/shared/messages.ts` ([0005](adr/0005-use-zod-for-validation.md), [0016](adr/0016-initial-domain-model.md), `domain` skill). Parsed cells are checked for shape only; grid bounds are an invariant (`src/sim/invariants.ts`). Driver, trip, and rider IDs are restricted to `[A-Za-z0-9_-]+` so they are valid NATS subject tokens (`sim.offers.<driverId>`, [0028](adr/0028-nats-bus-subjects-and-delivery.md)).
- Trip transitions: `src/dispatch/trip.ts`; matching strategy: `src/dispatch/brain.ts` ([0018](adr/0018-dispatch-matching-via-offers.md)).
- Randomness: `src/shared/random.ts`; seed streams per service: `src/sim/run.ts` ([0023](adr/0023-own-seeded-prng.md)).
- Driver IDs and shard ownership: `src/sim/run.ts`.
- Message delivery order: `src/bus/in-memory.ts` ([0027](adr/0027-in-process-bus-and-runner.md)), `src/bus/nats.ts` ([0028](adr/0028-nats-bus-subjects-and-delivery.md)).
- NATS subject per message: `subjectFor` in `src/bus/nats.ts` ([0028](adr/0028-nats-bus-subjects-and-delivery.md)).
- Rejected-input handling: brains emit, shell logs ([0026](adr/0026-brains-reject-invalid-inputs.md)).
- Default run config (spec scale) and exit codes: `src/sim/main.ts`.
