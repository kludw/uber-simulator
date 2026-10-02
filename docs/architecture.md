# Architecture

What lives where and how it connects. Behavior: [spec.md](spec.md). Why: [ADRs](adr/README.md). Terms: `.claude/skills/domain/SKILL.md`.

Current state: milestones 2 and 3 done. `bun run sim` runs everything in one process over an in-memory bus, or with `--bus nats` each service on its own NATS connection. Each service also runs as its own process over NATS ([0019](adr/0019-single-package-multiple-entrypoints.md), [0028](adr/0028-nats-bus-subjects-and-delivery.md)), all spawned by `bun run dev`. Integration tests check invariants on NATS runs. UI (4) in progress: its view model and canvas renderer are built, the page and NATS wiring are not. ClickHouse (5) is not built yet. Local NATS server runs via Docker Compose (see Local infra).

## Components

| Component | Where | Does | Decisions |
| --- | --- | --- | --- |
| Shared domain | `src/shared/` | grid and cells, message types (`Message` union), branded IDs, `Result`, seeded PRNG | [0016](adr/0016-initial-domain-model.md), [0009](adr/0009-result-type-for-expected-failures.md), [0023](adr/0023-own-seeded-prng.md) |
| Driver brain | `src/driver/brain.ts` | one shard of drivers: placement, wandering, offers, driving to pickup/dropoff | [0022](adr/0022-source-layout-and-brain-shape.md), [0025](adr/0025-driver-at-dropoff-state.md) |
| Dispatch brain | `src/dispatch/brain.ts`, `trip.ts` | owns every trip: queue, offers, matching, pickup, completion, cancel | [0018](adr/0018-dispatch-matching-via-offers.md) |
| Rider brain | `src/rider/brain.ts` | demand generator, riders, patience, cancels | [0016](adr/0016-initial-domain-model.md), [0022](adr/0022-source-layout-and-brain-shape.md) |
| Bus port | `src/bus/bus.ts` | `publish` / `subscribe` by type-guard predicate | [0027](adr/0027-in-process-bus-and-runner.md) |
| In-memory bus | `src/bus/in-memory.ts` | FIFO queue, `drain()` delivers in publish order | [0027](adr/0027-in-process-bus-and-runner.md) |
| NATS bus | `src/bus/nats.ts` | `connectNatsBus`: one connection, one `sim.>` subscription, Zod-parses each payload (invalid ones logged, dropped), then predicates; handlers one at a time in arrival order. Reports disconnect / reconnect / close. `close()` drains, or just closes when disconnected or already closed. `subjectFor` maps messages to subjects | [0028](adr/0028-nats-bus-subjects-and-delivery.md) |
| Service shell | `src/bus/service.ts` | runs any brain on the bus: feeds accepted messages to `decide`, publishes outputs, logs `input_rejected` | [0026](adr/0026-brains-reject-invalid-inputs.md), [0027](adr/0027-in-process-bus-and-runner.md) |
| Service wiring | `src/sim/services.ts` | per service (driver shard, dispatch, riders): name, seed stream, start config, `accepts` predicate, driver IDs and shard ownership. Shared by the runner and the entrypoints so both run identical services | [0017](adr/0017-independent-actor-services-with-pure-brains.md), [0023](adr/0023-own-seeded-prng.md) |
| Runner | `src/sim/run.ts` | starts driver shards, dispatch, riders; acts as clock; returns event log + rejected inputs. `runInProcess`: one in-memory bus, `drain()` after each tick, same config gives the same log. `runOverNats`: one NATS connection per service plus one recording `sim.>` and publishing ticks; a tick has settled once nothing arrives for 10 ms; log differs between runs (only per-publisher order, 0028) | [0027](adr/0027-in-process-bus-and-runner.md) |
| Service config | `src/sim/config.ts` | `parseServiceConfig(env)` (Zod): NATS URL, seed, speed, clock start delay, shard sizes, demand; `parseShardIndex` for driver processes | [0005](adr/0005-use-zod-for-validation.md) |
| Process shell | `src/sim/process.ts` | for every entrypoint: reads config, connects the NATS bus, JSON log lines tagged with the service, closes the bus on SIGINT/SIGTERM, exit codes | [0019](adr/0019-single-package-multiple-entrypoints.md) |
| Entrypoints | `src/dispatch/main.ts`, `src/rider/main.ts`, `src/driver/main.ts` (`SHARD_INDEX`) | one service process each: process shell + service wiring | [0019](adr/0019-single-package-multiple-entrypoints.md) |
| Clock | `src/clock/main.ts`, `schedule.ts` | the only wall-time pacer: waits the start delay, then publishes `clock.ticked` from tick 1, due at fixed times 1 s / speed apart (`tickDueAt`, so late ticks don't drift the schedule) | [0008](adr/0008-deterministic-tick-based-simulation.md) |
| Dev launcher | `src/sim/dev.ts` (`bun run dev`) | spawns every entrypoint (`Bun.spawn`), prefixes their output; SIGINT/SIGTERM or any child exiting stops all | [0019](adr/0019-single-package-multiple-entrypoints.md) |
| Invariant checker | `src/sim/invariants.ts` | spec invariants from the event log alone, own trip model | [0017](adr/0017-independent-actor-services-with-pure-brains.md) |
| Summary | `src/sim/summary.ts` | run result -> counts, mean ticks to pickup, violations | - |
| UI view | `src/ui/view.ts` | `applyEvent(view, event)`: drivers (cell, previous cell, tick moved, state), waiting riders, active trips, counters, from `sim.events.>` alone. Tolerates a mid-run join: a driver first seen moving is shown idle, first seen arriving at its arrival cell. Ignores an arrival for a known idle driver (late over NATS, 0028) | [0020](adr/0020-browser-ui-canvas-nats-websocket.md) |
| UI renderer | `src/ui/render.ts` | `startRenderer(canvas, grid).show(view)`: draws the latest view each animation frame. Grid fitted square and letterboxed (`cellToPixel`), backing store scaled by `devicePixelRatio`. Drivers as dots colored by state (legend colors defined once there), waiting riders as hollow squares, active trips as thin pickup -> dropoff lines. A driver that moved on the current tick slides from previous to current cell (`driverPosition`); fraction = time since the tick's arrival / time between the last two arrivals. Type-checked with DOM types via `src/ui/tsconfig.json`; the root config excludes `src/ui` so server code can't use browser globals | [0020](adr/0020-browser-ui-canvas-nats-websocket.md) |
| CLI | `src/sim/main.ts` (`bun run sim`) | parses args (Zod), runs in process or `--bus nats` (`NATS_URL`), prints summary, sets exit code | [0005](adr/0005-use-zod-for-validation.md), [0019](adr/0019-single-package-multiple-entrypoints.md) |

Brains are the functional core: pure, seeded, no I/O ([0017](adr/0017-independent-actor-services-with-pure-brains.md), `simulation` skill). Shell: `src/bus/`, `src/sim/` (except invariants and summary), `src/*/main.ts`, `startRenderer` in `src/ui/render.ts`. Invariant checker, summary, UI view, and the renderer's `cellToPixel` / `driverPosition` are pure but not brains. Dependencies point inward: brains import only `src/shared/`.

## Data flow

```
bun run sim -> main.ts --config--> runner
runner: start shards, dispatch, riders on in-memory bus
  each tick: publish clock.ticked, drain
    bus --message--> service shell --input--> brain.decide --outputs--> shell --publish--> bus
    every published message --> event log
  --bus nats: same, each service on its own NATS connection, runner records sim.>,
    waits for 10 ms of quiet instead of drain
runner --{ eventLog, rejected }--> summarize --> checkInvariants --> main.ts prints, exits
```

Separate processes (`bun run dev`):

```
dev.ts --Bun.spawn--> dispatch, riders, driver-shard-0..n-1, clock (one process each, own NATS connection)
each: process shell --connect--> NATS bus --> service wiring --> service shell + brain
clock: wait CLOCK_START_DELAY_MS, then clock.ticked every 1 s / SPEED --> NATS sim.events.clock.ticked
every message: publisher --NATS sim.>--> every service's subscription --accepts--> its brain
```

The start delay is what orders tick 1 after the other services subscribed; nothing waits for them explicitly. A lost `driver.went_online` costs nothing lasting: dispatch also learns drivers from `driver.moved`.

Services never call each other: commands (`request_trip`, `cancel_trip`), offers, replies, and events are all bus messages. Dispatch is the only source of `trip.*` events ([0018](adr/0018-dispatch-matching-via-offers.md)). Offers reach only the shard owning the driver via the shard's subscription predicate.

## Local infra

Docker Compose ([0012](adr/0012-use-docker-compose-for-local-infra.md)), `compose.yaml`; app runs on the host via Bun. The NATS bus integration tests and `bun run dev` connect (`NATS_URL`; CI runs a plain `nats` service container for the tests).

| Service | Image | Ports | Config |
| --- | --- | --- | --- |
| NATS | `nats:2.15.0-alpine` | 4222 clients, 8222 monitoring (`/healthz` = healthcheck), 9222 websocket (no TLS, local only) | `infra/nats.conf`: JetStream on named volume `nats-data` (`/data`), websocket for the UI ([0020](adr/0020-browser-ui-canvas-nats-websocket.md), [0028](adr/0028-nats-bus-subjects-and-delivery.md)) |

Client URLs: `.env.example` (`NATS_URL`, `NATS_WS_URL`).

## Where decisions live

- Grid geometry, distance, moves: `src/shared/grid.ts`.
- Message shapes, names, and wire parsing (Zod schemas, `parseMessage`): `src/shared/messages.ts` ([0005](adr/0005-use-zod-for-validation.md), [0016](adr/0016-initial-domain-model.md), `domain` skill). Parsed cells are checked for shape only; grid bounds are an invariant (`src/sim/invariants.ts`). Driver, trip, and rider IDs are restricted to `[A-Za-z0-9_-]+` so they are valid NATS subject tokens (`sim.offers.<driverId>`, [0028](adr/0028-nats-bus-subjects-and-delivery.md)).
- Trip transitions: `src/dispatch/trip.ts`; matching strategy: `src/dispatch/brain.ts` ([0018](adr/0018-dispatch-matching-via-offers.md)).
- Randomness: `src/shared/random.ts`; seed streams per service (child stream named after the service): `src/sim/services.ts` ([0023](adr/0023-own-seeded-prng.md)).
- Driver IDs and shard ownership: `src/sim/services.ts`, from shard index and shard sizes only, so every process agrees.
- Tick pacing: `src/clock/schedule.ts`; service process config and its defaults: `src/sim/config.ts`.
- Message delivery order: `src/bus/in-memory.ts` ([0027](adr/0027-in-process-bus-and-runner.md)), `src/bus/nats.ts` ([0028](adr/0028-nats-bus-subjects-and-delivery.md)).
- NATS subject per message: `subjectFor` in `src/bus/nats.ts` ([0028](adr/0028-nats-bus-subjects-and-delivery.md)).
- Rejected-input handling: brains emit, shell logs ([0026](adr/0026-brains-reject-invalid-inputs.md)).
- Default run config (spec scale) and exit codes: `src/sim/main.ts`.
