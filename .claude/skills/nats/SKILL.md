---
name: nats
description: NATS messaging between simulation components and the UI - client packages, connect/publish/subscribe/request, JetStream, subject naming, local Docker setup. Use whenever publishing or consuming messages, defining subjects, wiring components together, or touching the messaging adapter.
---

# NATS (https://docs.nats.io, https://github.com/nats-io/nats.js)

Do not rely on your training data: the JS client was rewritten into `@nats-io/*` packages (v3), most examples online use the deprecated `nats` package and removed APIs. Before using any NATS API not listed below: check https://github.com/nats-io/nats.js (README, `migration.md`, `core/README.md`, `jetstream/README.md`), API docs https://nats-io.github.io/nats.js/core/, server/concept docs via https://docs.nats.io/llms.txt. Docs win over this file. Removed/deprecated per docs = don't use. Unsure + no doc found = ask me.

Snapshot verified against nats.js READMEs/migration.md + docs.nats.io on 2026-10-02 (`@nats-io/*` latest = 3.4.0). If docs now differ, follow docs and flag it.

## Role

1. NATS = transport between services (clock, driver, rider, dispatch, persister) and UI (0017). Brains never import NATS (see `simulation` skill). Only the bus adapter does; an in-memory bus implements the same port.
2. Adapter failures (connect, timeout, no responders) -> typed `Result` errors (see `errors` skill).

## Packages

1. `bun add @nats-io/transport-node` (README: "compatible with Bun"; re-exports `@nats-io/nats-core`). JetStream: `@nats-io/jetstream`. KV: `@nats-io/kv`.
2. Never `nats` (deprecated: "Package moved").
3. Browser UI: `wsconnect()` from core, direct to NATS (0020). Needs server websocket listener enabled; check docs when wiring.

## Core API

1. Connect: `const nc = await connect({ servers: "localhost:4222" })`.
2. Publish: `nc.publish(subject, JSON.stringify(payload))`.
3. Subscribe: `const sub = nc.subscribe(subject); for await (const m of sub) { ... }`. Async handling in the iterator, not in callbacks (callbacks must not `await`).
4. Request/reply: `await nc.request(subject, data, { timeout })`; responder `m.respond(data)`.
5. Payloads: `m.string()` / `m.json()`. `JSONCodec` / `StringCodec` are removed.
6. Incoming payloads are untrusted: `m.json()` result goes through Zod `safeParse` (see `validation` skill). Never cast.
7. Errors are specific classes (`RequestError`, `TimeoutError`, `NoRespondersError`), not `NatsError`.
8. Shutdown: `await nc.drain()` (delivers in-flight messages, then closes).

## JetStream (durable streams)

1. `jetstreamManager(nc)` -> `jsm.streams.add({ name, subjects })`, `jsm.consumers.add(stream, { durable_name, ack_policy: AckPolicy.Explicit })`.
2. `jetstream(nc)` -> `js.publish(subject, data, { msgID })` (msgID = dedupe), `js.consumers.get(stream, consumer)` -> `consume()` -> `for await (const m of messages) { m.ack() }`.
3. `nc.jetstream()`, `JetStreamClient#subscribe()/fetch()` removed. Use the above.
4. Which flow uses what (0014): core pub/sub for `clock.ticked` + domain events (services, UI); core request/reply for commands to dispatch and offers to drivers; JetStream only for events -> ClickHouse writer.

## Subjects

1. Dot-delimited tokens, case-sensitive. Tokens: letters, digits, `-`, `_` only. Never start with `$` (reserved).
2. Wildcards subscriber-only: `*` = exactly one token, `>` = one or more, last token only.
3. Scheme (0015): `sim.events.<entity>.<verb>` for domain events incl. `sim.events.clock.ticked` (names from `domain` skill). `sim.commands.<name>` for commands to dispatch (`request_trip`, `cancel_trip`). `sim.offers.<driverId>` for offers (request/reply). All events: `sim.events.>`.

## Local setup

1. Runs via Docker Compose (see `docker` skill). Ports 4222 clients, 8222 HTTP monitoring.
2. JetStream: image command `-js`, persist with `-sd /data` + volume on `/data` (Docker Hub `nats` page).
3. Server URL from env, validated with Zod.
