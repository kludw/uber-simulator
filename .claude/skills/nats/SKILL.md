---
name: nats
description: NATS messaging between simulation components and the UI - client packages, connect/publish/subscribe/request, JetStream, subject naming, local Docker setup. Use whenever publishing or consuming messages, defining subjects, wiring components together, or touching the messaging adapter.
---

# NATS (https://docs.nats.io, https://github.com/nats-io/nats.js)

Do not rely on your training data: the JS client was rewritten into `@nats-io/*` packages (v3), most examples online use the deprecated `nats` package and removed APIs. Before using any NATS API not listed below: check https://github.com/nats-io/nats.js (README, `migration.md`, `core/README.md`, `jetstream/README.md`), API docs https://nats-io.github.io/nats.js/core/, server/concept docs via https://docs.nats.io/llms.txt. Docs win over this file. Removed/deprecated per docs = don't use. Unsure + no doc found = ask me.

Snapshot verified against nats.js READMEs/migration.md + docs.nats.io on 2026-10-02 (`@nats-io/*` latest = 3.4.0). If docs now differ, follow docs and flag it.

## Role

1. NATS = transport for domain events and commands between sim, persistence, UI. Core never imports NATS (see `simulation` skill). Only the messaging adapter does.
2. Adapter failures (connect, timeout, no responders) -> typed `Result` errors (see `errors` skill).

## Packages

1. `bun add @nats-io/transport-node` (README: "compatible with Bun"; re-exports `@nats-io/nats-core`). JetStream: `@nats-io/jetstream`. KV: `@nats-io/kv`.
2. Never `nats` (deprecated: "Package moved").
3. Browser UI later: `wsconnect()` from core (needs server websocket enabled, check docs then).

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
4. **Decision pending (ask me):** which flows need JetStream (e.g. events -> ClickHouse writer, so nothing is lost) vs core NATS (e.g. live UI fan-out, fire-and-forget).

## Subjects

1. Dot-delimited tokens, case-sensitive. Tokens: letters, digits, `-`, `_` only. Never start with `$` (reserved).
2. Wildcards subscriber-only: `*` = exactly one token, `>` = one or more, last token only.
3. Scheme (draft, confirm before first use): `sim.events.<entity>.<verb>` for domain events (names from `domain` skill, e.g. `sim.events.trip.requested`), `sim.commands.<name>` for inbound commands (e.g. UI injecting a ride request). All events: `sim.events.>`.

## Local setup

1. Runs via Docker Compose (see `docker` skill). Ports 4222 clients, 8222 HTTP monitoring.
2. JetStream: image command `-js`, persist with `-sd /data` + volume on `/data` (Docker Hub `nats` page).
3. Server URL from env, validated with Zod.
