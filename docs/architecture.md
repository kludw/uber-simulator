# Architecture

What lives where and how it connects. Behavior: [spec.md](spec.md). Why: [ADRs](adr/README.md). Terms: `.claude/skills/domain/SKILL.md`.

Current state: milestones 2, 3, and 4 done. `bun run sim` runs everything in one process over an in-memory bus, or with `--bus nats` each service on its own NATS connection. Each service also runs as its own process over NATS ([0019](adr/0019-single-package-multiple-entrypoints.md), [0028](adr/0028-nats-bus-subjects-and-delivery.md)), all spawned by `bun run dev`. Integration tests check invariants on NATS runs. `bun run ui` serves the browser UI, which subscribes to NATS events over WebSocket. Milestone 5 (ClickHouse) in progress: local ClickHouse, the `events` table, and its adapter exist; nothing writes events to it yet. Local NATS and ClickHouse run via Docker Compose (see Local infra).

## Components

| Component | Where | Does | Decisions |
| --- | --- | --- | --- |
| Shared domain | `src/shared/` | grid and cells, message types (`Message` union), branded IDs, `Result`, seeded PRNG | [0016](adr/0016-initial-domain-model.md), [0009](adr/0009-result-type-for-expected-failures.md), [0023](adr/0023-own-seeded-prng.md) |
| Driver brain | `src/driver/brain.ts` | one shard of drivers: placement, wandering, offers, driving to pickup/dropoff | [0022](adr/0022-source-layout-and-brain-shape.md), [0025](adr/0025-driver-at-dropoff-state.md) |
| Dispatch brain | `src/dispatch/brain.ts`, `trip.ts` | owns every trip: queue, offers, matching, pickup, completion, cancel | [0018](adr/0018-dispatch-matching-via-offers.md) |
| Rider brain | `src/rider/brain.ts` | demand generator, riders, patience, cancels | [0016](adr/0016-initial-domain-model.md), [0022](adr/0022-source-layout-and-brain-shape.md) |
| Bus port | `src/bus/bus.ts` | `publish` / `subscribe` by type-guard predicate | [0027](adr/0027-in-process-bus-and-runner.md) |
| In-memory bus | `src/bus/in-memory.ts` | FIFO queue, `drain()` delivers in publish order | [0027](adr/0027-in-process-bus-and-runner.md) |
| NATS bus | `src/bus/nats.ts` | `connectNatsBus`: one connection, one `sim.>` subscription, Zod-parses each payload (invalid ones logged, dropped), then predicates; handlers one at a time in arrival order. Stamps every publish with a `Run-Id` header (its `runId` option, [0029](adr/0029-event-persistence.md)); the `Bus` port and message shapes don't carry it. Reports disconnect / reconnect / close. `close()` drains, or just closes when disconnected or already closed. `subjectFor` maps messages to subjects | [0028](adr/0028-nats-bus-subjects-and-delivery.md), [0029](adr/0029-event-persistence.md) |
| Service shell | `src/bus/service.ts` | runs any brain on the bus: feeds accepted messages to `decide`, publishes outputs, logs `input_rejected` | [0026](adr/0026-brains-reject-invalid-inputs.md), [0027](adr/0027-in-process-bus-and-runner.md) |
| Service wiring | `src/sim/services.ts` | per service (driver shard, dispatch, riders): name, seed stream, start config, `accepts` predicate, driver IDs and shard ownership. Shared by the runner and the entrypoints so both run identical services | [0017](adr/0017-independent-actor-services-with-pure-brains.md), [0023](adr/0023-own-seeded-prng.md) |
| Runner | `src/sim/run.ts` | starts driver shards, dispatch, riders; acts as clock; returns event log + rejected inputs. `runInProcess`: one in-memory bus, `drain()` after each tick, same config gives the same log. `runOverNats`: one NATS connection per service plus one recording `sim.>` and publishing ticks, all with one fresh run id (`crypto.randomUUID()`), returned with the result; a tick has settled once nothing arrives for 10 ms; log differs between runs (only per-publisher order, 0028) | [0027](adr/0027-in-process-bus-and-runner.md) |
| Service config | `src/sim/config.ts` | `parseServiceConfig(env)` (Zod): NATS URL, run id (`RUN_ID`, required, `[A-Za-z0-9_-]+`), seed, speed, clock start delay, shard sizes, demand; `parseShardIndex` for driver processes; `parseUiConfig` for the UI server; `parseClickHouseConfig` for ClickHouse clients | [0005](adr/0005-use-zod-for-validation.md) |
| Process shell | `src/sim/process.ts` | for every entrypoint: reads config, connects the NATS bus, JSON log lines tagged with the service, closes the bus on SIGINT/SIGTERM, exit codes | [0019](adr/0019-single-package-multiple-entrypoints.md) |
| Entrypoints | `src/dispatch/main.ts`, `src/rider/main.ts`, `src/driver/main.ts` (`SHARD_INDEX`) | one service process each: process shell + service wiring | [0019](adr/0019-single-package-multiple-entrypoints.md) |
| Clock | `src/clock/main.ts`, `schedule.ts` | the only wall-time pacer: waits the start delay, then publishes `clock.ticked` from tick 1, due at fixed times 1 s / speed apart (`tickDueAt`, so late ticks don't drift the schedule) | [0008](adr/0008-deterministic-tick-based-simulation.md) |
| Dev launcher | `src/sim/dev.ts` (`bun run dev`) | generates one run id per start (`crypto.randomUUID()`, overrides any `RUN_ID`), prints it, passes it to every entrypoint as `RUN_ID`; spawns every entrypoint (`Bun.spawn`), prefixes their output; SIGINT/SIGTERM or any child exiting stops all | [0019](adr/0019-single-package-multiple-entrypoints.md) |
| Invariant checker | `src/sim/invariants.ts` | spec invariants from the event log alone, own trip model | [0017](adr/0017-independent-actor-services-with-pure-brains.md) |
| Summary | `src/sim/summary.ts` | run result -> counts, mean ticks to pickup, violations | - |
| UI view | `src/ui/view.ts` | `applyEvent(view, event)`: drivers (cell, previous cell, tick moved, state), waiting riders, active trips, counters, from `sim.events.>` alone. Tolerates a mid-run join: a driver first seen moving is shown idle, first seen arriving at its arrival cell. Ignores an arrival for a known idle driver (late over NATS, 0028) | [0020](adr/0020-browser-ui-canvas-nats-websocket.md) |
| UI renderer | `src/ui/render.ts` | `startRenderer(canvas, grid).show(view)`: draws the latest view each animation frame. Grid fitted square and letterboxed (`cellToPixel`), backing store scaled by `devicePixelRatio`. Drivers as dots colored by state (legend colors defined once there), waiting riders as hollow squares, active trips as thin pickup -> dropoff lines. A driver that moved on the current tick slides from previous to current cell (`driverPosition`); fraction (`tickFraction`) = time since the latest tick's arrival / time between the last two arrivals (`observeTick`), capped at 1, and 1 when the last two arrived in the same millisecond. Type-checked with DOM types via `src/ui/tsconfig.json`; the root config excludes `src/ui` so server code can't use browser globals | [0020](adr/0020-browser-ui-canvas-nats-websocket.md) |
| UI side panel | `src/ui/panel.ts` | `panelRows(view)`: label, value, and swatch per row: tick, drivers per state, waiting riders, active trips, trips completed / cancelled, mean ticks to pickup. Swatches use the renderer's colors and shapes, so the panel is the canvas's legend | [0020](adr/0020-browser-ui-canvas-nats-websocket.md) |
| UI page | `src/ui/index.html`, `src/ui/main.ts` | browser entry: fetches `/config.json`, `wsconnect` (retries forever, before the first connection too), subscribes `sim.events.>`, parses each payload with `parseMessage` (invalid or non-event ones `console.warn`ed, dropped), `applyEvent`, `renderer.show`, side panel redrawn at most once per frame, connection status (connecting / live / disconnected) | [0020](adr/0020-browser-ui-canvas-nats-websocket.md) |
| UI server | `src/ui/serve.ts` (`bun run ui`) | `Bun.serve` HTML import: bundles and serves the page on `UI_PORT` (default 3000), serves `NATS_WS_URL` as `/config.json` (env via `parseUiConfig` + `orExit`, exit 2 if invalid) | [0019](adr/0019-single-package-multiple-entrypoints.md), [0020](adr/0020-browser-ui-canvas-nats-websocket.md) |
| ClickHouse adapter | `src/persistence/clickhouse.ts` | `connectClickHouse(config)`: `@clickhouse/client`, pinged with a `SELECT` so bad credentials fail at connect. `insertEvents(rows)` (`EventRow` -> `events` columns, async insert with wait), `query(sql, params)` (rows unvalidated, callers parse), `command(sql)`, `close()`. `migrate(clickhouse)` applies `infra/clickhouse/*.sql` in name order, every file every time (each idempotent). All failures are `Result`s | [0013](adr/0013-clickhouse-client.md), [0029](adr/0029-event-persistence.md) |
| Migrate | `src/persistence/migrate.ts` (`bun run db:migrate`) | config, connect, `migrate`, JSON log line, exit codes | [0029](adr/0029-event-persistence.md) |
| CLI | `src/sim/main.ts` (`bun run sim`) | parses args (Zod), runs in process or `--bus nats` (`NATS_URL`), prints summary, sets exit code | [0005](adr/0005-use-zod-for-validation.md), [0019](adr/0019-single-package-multiple-entrypoints.md) |

Brains are the functional core: pure, seeded, no I/O ([0017](adr/0017-independent-actor-services-with-pure-brains.md), `simulation` skill). Shell: `src/bus/`, `src/persistence/`, `src/sim/` (except invariants and summary), `src/*/main.ts`, `startRenderer` in `src/ui/render.ts`, `src/ui/main.ts`, `src/ui/serve.ts`. Invariant checker, summary, UI view, UI side panel, and the renderer's `cellToPixel` / `driverPosition` / `observeTick` / `tickFraction` are pure but not brains. Dependencies point inward: brains import only `src/shared/`.

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
dev.ts --Bun.spawn, RUN_ID--> dispatch, riders, driver-shard-0..n-1, clock (one process each, own NATS connection)
each: process shell --connect--> NATS bus --> service wiring --> service shell + brain
clock: wait CLOCK_START_DELAY_MS, then clock.ticked every 1 s / SPEED --> NATS sim.events.clock.ticked
every message: publisher --NATS sim.>, Run-Id header--> every service's subscription --accepts--> its brain
```

Browser UI (`bun run ui`):

```
serve.ts --GET /--> index.html + bundled main.ts; --GET /config.json--> { natsWsUrl }
main.ts --wsconnect NATS_WS_URL--> subscribe sim.events.> --parseMessage--> applyEvent --> view
view --> startRenderer.show (canvas, each animation frame) + panelRows (side panel)
```

The UI only subscribes; it builds its view from events alone and joins mid-run (ADR 0020).

The start delay is what orders tick 1 after the other services subscribed; nothing waits for them explicitly. A lost `driver.went_online` costs nothing lasting: dispatch also learns drivers from `driver.moved`.

Services never call each other: commands (`request_trip`, `cancel_trip`), offers, replies, and events are all bus messages. Dispatch is the only source of `trip.*` events ([0018](adr/0018-dispatch-matching-via-offers.md)). Offers reach only the shard owning the driver via the shard's subscription predicate.

## Local infra

Docker Compose ([0012](adr/0012-use-docker-compose-for-local-infra.md)), `compose.yaml`; app runs on the host via Bun. The NATS bus integration tests and `bun run dev` connect (`NATS_URL`; CI runs a plain `nats` service container for the tests). ClickHouse adapter tests and `bun run db:migrate` connect to ClickHouse (`CLICKHOUSE_*`; CI runs the same image as a service container).

| Service | Image | Ports | Config |
| --- | --- | --- | --- |
| NATS | `nats:2.15.0-alpine` | 4222 clients, 8222 monitoring (`/healthz` = healthcheck), 9222 websocket (no TLS, local only) | `infra/nats.conf`: JetStream on named volume `nats-data` (`/data`), websocket for the UI ([0020](adr/0020-browser-ui-canvas-nats-websocket.md), [0028](adr/0028-nats-bus-subjects-and-delivery.md)) |
| ClickHouse | `clickhouse/clickhouse-server:26.9.8.3` | 8123 HTTP (app client; `/ping` = healthcheck via the image's `wget`), 9000 native | env `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` / `CLICKHOUSE_DB` (from `.env`, default `sim`) creates user and database on first start; data on named volume `clickhouse-data`; `nofile` ulimit 262144 per image docs. Tables: `infra/clickhouse/*.sql` via `bun run db:migrate` ([0029](adr/0029-event-persistence.md)) |

Client URLs: `.env.example` (`NATS_URL`, `NATS_WS_URL`, `CLICKHOUSE_URL` plus user, password, database). The browser UI connects to the websocket port (`NATS_WS_URL`), everything else to `NATS_URL`.

## Where decisions live

- Grid geometry, distance, moves, spec grid size (`specGrid`): `src/shared/grid.ts`.
- Message shapes, names, and wire parsing (Zod schemas, `parseMessage`): `src/shared/messages.ts` ([0005](adr/0005-use-zod-for-validation.md), [0016](adr/0016-initial-domain-model.md), `domain` skill). Parsed cells are checked for shape only; grid bounds are an invariant (`src/sim/invariants.ts`). Driver, trip, and rider IDs are restricted to `[A-Za-z0-9_-]+` so they are valid NATS subject tokens (`sim.offers.<driverId>`, [0028](adr/0028-nats-bus-subjects-and-delivery.md)).
- Trip transitions: `src/dispatch/trip.ts`; matching strategy: `src/dispatch/brain.ts` ([0018](adr/0018-dispatch-matching-via-offers.md)).
- Randomness: `src/shared/random.ts`; seed streams per service (child stream named after the service): `src/sim/services.ts` ([0023](adr/0023-own-seeded-prng.md)).
- Driver IDs and shard ownership: `src/sim/services.ts`, from shard index and shard sizes only, so every process agrees.
- Tick pacing: `src/clock/schedule.ts`; service process and UI server config and their defaults: `src/sim/config.ts`.
- Run id: generated by the shell (`src/sim/dev.ts`, `runOverNats`), never by brains; stamped as the `Run-Id` header in `src/bus/nats.ts` ([0029](adr/0029-event-persistence.md)).
- Message delivery order: `src/bus/in-memory.ts` ([0027](adr/0027-in-process-bus-and-runner.md)), `src/bus/nats.ts` ([0028](adr/0028-nats-bus-subjects-and-delivery.md)).
- NATS subject per message: `subjectFor` in `src/bus/nats.ts` ([0028](adr/0028-nats-bus-subjects-and-delivery.md)).
- Rejected-input handling: brains emit, shell logs ([0026](adr/0026-brains-reject-invalid-inputs.md)).
- Default run config (spec scale) and exit codes: `src/sim/main.ts`.
- `events` table DDL: `infra/clickhouse/001_events.sql` ([0029](adr/0029-event-persistence.md)); row -> column encoding: `src/persistence/clickhouse.ts`.
- Legend colors and drawing shapes: `src/ui/render.ts`; the side panel reuses them.
