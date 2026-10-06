# 0045. Publish driver moves in batches per shard and tick

- Status: Accepted
- Date: 2026-10-06
- No ADR is superseded: `driver.moved` is defined in the `domain` skill and `src/shared/messages.ts`, not by an ADR; the new subject follows 0028's scheme

## Context

At greedy 35k drivers ([Cost of driver moves](../performance.md#cost-of-driver-moves), runs 37469524072 / 37469508917, EPYC 7763), `driver.moved` is 99.0% of events, 98.9% of payload bytes, 99.3% of the messages dispatch receives, 83.8% of dispatch's decode + handle time (about 200 of 240 ms per tick, mostly decode), and 98.9% of the persister's rows. Every driver that moves publishes its own message, so N drivers cost N NATS messages, N decodes in dispatch, the persister and the load-test observer, and N ClickHouse rows per tick. Milestone 17 found the live limit set by the persister falling behind, mostly during ~20M-row ClickHouse merges of exactly these rows ("After milestone 17"). Decode of one small message costs far more on the CI runners than its fields justify (ADR 0042), so the per-message overhead, not the data, dominates.

## Decision

We will replace `driver.moved` with `drivers.moved { tick, moves: [{ driverId, cell }, ...] }` (subject `sim.events.drivers.moved`):

- A driver shard publishes, for each tick, the moves of all its drivers that moved that tick, in chunks of at most 5,000 moves per message, and none when no driver moved. Each chunk is published before the shard's other events of that tick, so a subscriber has a driver's position for the tick before that driver's `driver.arrived_at_*` or `driver.went_offline`.
- Every consumer treats one entry exactly as it treated one `driver.moved`: dispatch updates positions, the invariant checker checks each move, the UI animates each driver.
- The persister stores one row per message (type `drivers.moved`, driver id empty, the moves in the payload), like any other event (ADR 0029). Replay republishes it unchanged (ADR 0034).
- `driver.moved` is removed; no consumer reads both.

## Rationale

- Cuts the dominant cost at its source for every process at once: messages per tick go from about N to about N / 5,000 per shard, persister rows and ClickHouse merge volume by about 99%. The per-move work that remains (validating each entry, updating a map) was a small part of a message's cost.
- Chunks of 5,000 keep each message under NATS's default 1 MB `max_payload` (a move is about 47 bytes of JSON, so a chunk is about 240 KB) without server config, and bound a single message's decode time.
- Publishing the chunks first keeps the order a subscriber relied on: a shard's per-publisher order (ADR 0028) put each driver's `driver.moved` before its arrival.
- One event type per shard per tick needs no new subject scheme: `sim.events.<entity>.<verb>` with the entity in plural.
- The live system cares about positions per tick, not per-driver messages; nothing reads a single driver's move from ClickHouse today (analytics counts trip events).

## Alternatives considered

- Keep `driver.moved`, add a batch beside it: doubles traffic during the transition and leaves every consumer reading two shapes.
- One message per shard per tick without chunking: at 45k drivers one shard's batch is about 1.4 MB, over the default `max_payload`; raising it moves the limit, and one huge message delays the shard's other events.
- A binary or columnar payload: smaller decode, but every message is JSON validated with Zod today (CLAUDE.md); revisit only if the batched JSON's decode shows up next.
- Persist one row per move (expand the batch in the persister): keeps per-driver rows but keeps the insert and merge volume that milestone 17 found limiting.

## Consequences

- Every producer and consumer of `driver.moved` changes in one change: driver brain, dispatch, invariant checker, UI, load-test observer, subjects, message schema, domain skill.
- A lost chunk (core NATS, ADR 0028) loses up to 5,000 moves to that subscriber for one tick; positions are corrected by the next tick's chunk, as a lost `driver.moved` was by the next one.
- Querying one driver's path from ClickHouse needs `arrayJoin` over the payload's moves.
- In-process, the message count, the event log's order within a tick (a shard's moves before its arrivals), and the lossy bus's draw sequence in the message-loss test change; trip and driver outcomes must not. The load-test report's event counts per tick change.
