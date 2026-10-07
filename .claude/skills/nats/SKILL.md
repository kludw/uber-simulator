---
name: nats
description: NATS messaging between simulation components and the UI - client packages, connect/publish/subscribe/request, JetStream, subject naming, local Docker setup. Use whenever publishing or consuming messages, defining subjects, wiring components together, or touching the messaging adapter.
---

# NATS (https://docs.nats.io, https://github.com/nats-io/nats.js)

Do not rely on your training data: the JS client was rewritten into `@nats-io/*` packages (v3), most examples online use the deprecated `nats` package and removed APIs. Before using any NATS API not listed below: check https://github.com/nats-io/nats.js (README, `migration.md`, `core/README.md`, `jetstream/README.md`), API docs https://nats-io.github.io/nats.js/core/, server/concept docs via https://docs.nats.io/llms.txt. Docs win over this file. Removed/deprecated per docs = don't use. Unsure + no doc found = ask me.

Snapshot verified against nats.js READMEs/migration.md + docs.nats.io on 2026-10-02 (`@nats-io/*` latest = 3.4.0). If docs now differ, follow docs and flag it.

## Role

1. NATS = transport between services (clock, driver, rider, dispatch, persister) and UI (0017). Brains never import NATS (see `simulation` skill). Only the bus adapter does; an in-memory bus implements the same port.
2. Adapter failures (connect, disconnect, publish errors) -> typed `Result` errors (see `errors` skill).

## Packages

1. `bun add @nats-io/transport-node` (README: "compatible with Bun"; re-exports `@nats-io/nats-core`). JetStream: `@nats-io/jetstream`. KV: `@nats-io/kv`.
2. Never `nats` (deprecated: "Package moved").
3. Browser UI: `wsconnect()` from `@nats-io/nats-core` (direct dependency; `transport-node` pulls in Node APIs), direct to NATS (0020). Server websocket listener on 9222 (`infra/nats.conf`). A `ws://` URL needs its port: the client assumes 80 otherwise (core README).

## Core API

1. Connect: `const nc = await connect({ servers: "localhost:4222" })`.
2. Publish: `nc.publish(subject, JSON.stringify(payload))`.
3. Subscribe: `const sub = nc.subscribe(subject); for await (const m of sub) { ... }`. Async handling in the iterator, not in callbacks (callbacks must not `await`). Exception: the bus (`src/bus/nats.ts`) uses `nc.subscribe(subject, { callback: (err, m) => ... })`: synchronous, called in arrival order on the connection, so several subscriptions keep one publisher's order (0042). A throw inside a callback only stops the client's reader (callbacks per core README "Async vs. Callbacks"; the throw lands in the client's read loop, which logs "reader closed", per `@nats-io/nats-core` 3.4.0 source): catch it.
4. Request/reply: `await nc.request(subject, data, { timeout })`; responder `m.respond(data)`. Not used by services (ADR 0028).
5. Payloads: `m.string()` / `m.json()`. `JSONCodec` / `StringCodec` are removed.
6. Incoming payloads are untrusted: `m.json()` result goes through Zod `safeParse` (see `validation` skill). Never cast.
7. Errors are specific classes (`RequestError`, `TimeoutError`, `NoRespondersError`), not `NatsError`.
8. Shutdown: `await nc.drain()` (delivers in-flight messages, then closes).
9. Headers: `const h = headers(); h.set(key, value); nc.publish(subject, data, { headers: h })`; read `m.headers?.get(key)`. `set` throws on invalid values (CR/LF). Publishing with headers needs a server advertising `headers: true` in INFO (fake servers in tests too). The bus stamps `Run-Id` on every publish (0029).

## JetStream (durable streams)

1. `jetstreamManager(nc)` -> `jsm.streams.add({ name, subjects })`, `jsm.consumers.add(stream, { durable_name, ack_policy: AckPolicy.Explicit })`.
2. `jetstream(nc)` -> `js.publish(subject, data, { msgID })` (msgID = dedupe), `js.consumers.get(stream, consumer)` -> `consume()` -> `for await (const m of messages) { m.ack() }`.
3. `nc.jetstream()`, `JetStreamClient#subscribe()/fetch()` removed. Use the above.
4. Which flow uses what (0028): core NATS publish for every message; no request/reply. JetStream only for the persister (`src/persister/persister.ts`: stream `SIM_EVENTS` on `sim.events.>`, durable pull consumer `persister`, batches via `consumer.fetch({ max_messages, expires })`, the next fetch running while the current batch is persisted, `max_ack_pending` 2x batch, ADR 0029, 0044).
5. Durations in stream/consumer config (`max_age`, `ack_wait`) are nanoseconds: `nanos(ms)` from `@nats-io/transport-node`. `streams.add` / `consumers.add` with an identical config are no-ops; a changed config is a `JetStreamApiError`, then `update`.
6. `ack_wait` must exceed the longest a message waits for its ack (fetch wait + the previous batch's processing + its own), or the server redelivers it mid-batch.

## Subjects

1. Dot-delimited tokens, case-sensitive. Tokens: letters, digits, `-`, `_` only. Never start with `$` (reserved).
2. Wildcards subscriber-only: `*` = exactly one token, `>` = one or more, last token only.
3. Scheme (0028), all names in `src/shared/subjects.ts` (pure, imported by bus, persister, replay, and UI): `sim.events.<entity>.<verb>` (incl. `sim.events.clock.ticked`; entity plural for a batch: `sim.events.drivers.moved` and `sim.events.drivers.went_online`, one per shard per up to 5,000 drivers as parallel arrays, ~93 KB, under the default 1 MB `max_payload`, 0045, 0047, 0049), `sim.commands.<name>`, `sim.offers.<driverId>`, `sim.replies.<name>`. Each service (0042): one connection, one subscription per message type it takes (`subscriptionSubject`: the type's subject, `sim.offers.*` for offers), declared at connect (`inputs`) and flushed; all delivered through one synchronous `callback` (not async iterators, which would lose order between subscriptions), Zod-parse, then the subscribers of that type. Never one `sim.>` subscription per service (every service decoding all traffic was most of the CPU, 0042). Replay (0034): `replay.<runId>.<live subject>` (`replaySubject`; UI wildcard `replaySubjects`), plain connection, publish only, never `sim.*`.

## Local setup

1. Runs via Docker Compose (see `docker` skill). Ports 4222 clients, 8222 HTTP monitoring, 9222 websocket. `bun run loadtest` reads `/varz` and `/connz` on 8222 (`src/loadtest/monitoring.ts`, Zod-parsed).
2. Server config: `infra/nats.conf` (syntax: https://docs.nats.io/running-a-nats-service/configuration). JetStream via `jetstream { store_dir: /data }`, `/data` on a named volume. Websocket via `websocket { port, no_tls: true }` (local only).
3. Server URLs from env (`NATS_URL`, `NATS_WS_URL`, see `.env.example`), validated with Zod.
