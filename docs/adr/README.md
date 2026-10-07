# Architecture Decision Records

Format, triggers, lifecycle: `.claude/skills/docs/SKILL.md`.

| #    | Title                                                                    | Status   |
| ---- | ------------------------------------------------------------------------ | -------- |
| 0001 | [Record architecture decisions](0001-record-architecture-decisions.md)   | Accepted |
| 0002 | [Use Bun](0002-use-bun.md)                                               | Accepted |
| 0003 | [Use the latest TypeScript](0003-use-latest-typescript.md)               | Accepted |
| 0004 | [Use Biome](0004-use-biome.md)                                           | Accepted |
| 0005 | [Use Zod for all validation](0005-use-zod-for-validation.md)             | Accepted |
| 0006 | [Develop with TDD](0006-use-tdd.md)                                      | Accepted |
| 0007 | [Code design approach](0007-code-design-approach.md)                     | Accepted |
| 0008 | [Deterministic tick-based simulation](0008-deterministic-tick-based-simulation.md) | Superseded by 0017 |
| 0009 | [Result type for expected failures](0009-result-type-for-expected-failures.md) | Accepted |
| 0010 | [Use NATS for messaging](0010-use-nats-for-messaging.md)                 | Accepted |
| 0011 | [Use ClickHouse for persistence](0011-use-clickhouse-for-persistence.md) | Accepted |
| 0012 | [Docker Compose for local infra](0012-use-docker-compose-for-local-infra.md) | Accepted |
| 0013 | [ClickHouse client for Bun](0013-clickhouse-client.md)                   | Accepted |
| 0014 | [JetStream vs core NATS](0014-jetstream-vs-core-nats.md)                 | Superseded by 0028 |
| 0015 | [NATS subject scheme](0015-nats-subject-scheme.md)                       | Superseded by 0028 |
| 0016 | [Initial domain model](0016-initial-domain-model.md)                     | Accepted (driver states superseded by 0024, then 0025) |
| 0017 | [Independent actor services with pure brains](0017-independent-actor-services-with-pure-brains.md) | Accepted |
| 0018 | [Dispatch matching via offers](0018-dispatch-matching-via-offers.md)     | Accepted (offer transport superseded by 0028; single instance superseded by 0050) |
| 0019 | [One package, entrypoint per service](0019-single-package-multiple-entrypoints.md) | Accepted |
| 0020 | [Browser UI: canvas, NATS over WebSocket](0020-browser-ui-canvas-nats-websocket.md) | Accepted |
| 0021 | [Development workflow](0021-development-workflow.md)                   | Accepted |
| 0022 | [Source layout and brain shape](0022-source-layout-and-brain-shape.md) | Accepted |
| 0023 | [Small in-house seeded PRNG](0023-own-seeded-prng.md)                    | Accepted |
| 0024 | [Add `at_pickup` driver state](0024-driver-at-pickup-state.md)           | Superseded by 0025 (driver states only) |
| 0025 | [Add `at_dropoff` driver state](0025-driver-at-dropoff-state.md)         | Accepted |
| 0026 | [Brains reject invalid inputs with `input_rejected` outputs](0026-brains-reject-invalid-inputs.md) | Accepted |
| 0027 | [In-process bus, service shell, runner](0027-in-process-bus-and-runner.md) | Accepted |
| 0028 | [NATS bus: subjects and delivery](0028-nats-bus-subjects-and-delivery.md) | Accepted (one `sim.>` subscription per service superseded by 0042) |
| 0029 | [Event persistence](0029-event-persistence.md)                           | Accepted (batch size superseded by 0039) |
| 0030 | [Batched matching](0030-batched-matching.md)                            | Accepted |
| 0031 | [Hotspot demand](0031-hotspot-demand.md)                                | Accepted |
| 0032 | [Driver shifts](0032-driver-shifts.md)                                  | Accepted |
| 0033 | [Scale fixes](0033-scale-fixes.md)                                      | Accepted |
| 0034 | [Replay](0034-replay.md)                                                | Accepted |
| 0035 | [Driver preferences](0035-driver-preferences.md)                        | Accepted |
| 0036 | [Scale to 50k](0036-scale-to-50k.md)                                    | Accepted (per-tick dispatch snapshot superseded by 0048) |
| 0037 | [End-to-end load test](0037-end-to-end-load-test.md)                    | Accepted (persister trend criterion superseded by 0038) |
| 0038 | [Persister backlog criterion](0038-persister-backlog-criterion.md)      | Superseded by 0046 |
| 0039 | [Persister batch size](0039-persister-batch-size.md)                    | Accepted (one-round-at-a-time loop and max ack pending superseded by 0044) |
| 0040 | [Pickup wait timeout](0040-pickup-wait-timeout.md)                      | Superseded by 0041 |
| 0041 | [Confirm trip while waiting](0041-confirm-trip-while-waiting.md)        | Accepted |
| 0042 | [Subscribe to taken types](0042-subscribe-to-taken-types.md)            | Accepted |
| 0043 | [Learn drivers from moves](0043-learn-drivers-from-moves.md)          | Accepted |
| 0044 | [Persister pipelining](0044-persister-pipelining.md)                    | Accepted |
| 0045 | [Driver moves in batches](0045-publish-driver-moves-in-batches.md)     | Accepted (message shape superseded by 0047) |
| 0046 | [Persister pending criterion](0046-persister-pending-criterion.md)      | Accepted |
| 0047 | [Driver moves as parallel arrays](0047-driver-moves-as-parallel-arrays.md) | Accepted |
| 0048 | [Keep idle drivers across ticks](0048-keep-idle-drivers-across-ticks.md) | Accepted |
| 0049 | [Drivers going online in batches](0049-publish-drivers-going-online-in-batches.md) | Accepted |
| 0050 | [Split dispatch by region](0050-split-dispatch-by-region.md) | Accepted |
| 0051 | [Search untouched drivers in batched matching](0051-search-untouched-drivers-in-batched-matching.md) | Accepted |
