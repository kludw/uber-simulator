# 0047. Publish driver moves as parallel arrays

- Status: Accepted
- Supersedes 0045's message shape (chunks of at most 5,000 moves, published first in a shard's tick, are kept)
- Date: 2026-10-06

## Context

At greedy 200k live, decoding is 50.5-52.6% of dispatch's time, 96% of it `drivers.moved`: Zod 26.6-28.2%, JSON.parse 22.7-23.2% ([Dispatch profile](../performance.md#dispatch-profile)). ADR 0045's shape, `moves: [{ driverId, cell: { x, y } }]`, is two objects per move, each walked by JSON.parse and then by Zod, whose per-element schemas (a regex per ID, two `z.int().nonnegative()` checks per cell) run 15,000 times per 5,000-move chunk. Every consumer decodes it: dispatch, the persister, the UI, the load test's observer. CLAUDE.md requires Zod for all validation.

A micro-benchmark (JSON.parse + Zod `parse` of one 5,000-move chunk, Bun 1.4.2, median of 1,000 rounds, twice per runner) on two CI runners ([decode-bench 37535589113](https://github.com/kludw/uber-simulator/actions/runs/37535589113); AMD EPYC 9V45 / 9V74, load average under 0.6), in ms:

| Shape | Bytes | JSON.parse | JSON.parse + Zod |
| --- | ---: | ---: | ---: |
| objects (0045): `moves: [{ driverId, cell: { x, y } }]` | 242,846 | 0.60 / 0.75 | 1.70-1.74 / 2.18-2.19 |
| tuples: `moves: [[driverId, x, y]]` | 102,846 | 0.41 / 0.50 | 1.83-1.86 / 2.37-2.39 |
| flat cells: `driverIds`, `cells: [x0, y0, x1, ...]`, schema per element | 92,860 | 0.33-0.34 / 0.36 | 1.22-1.23 / 1.65 |
| parallel: `driverIds`, `xs`, `ys`, schema per element | 92,864 | 0.32 / 0.35 | 1.14-1.15 / 1.49-1.51 |
| parallel, IDs by schema per element, coordinates by one refine per array | 92,864 | 0.32 / 0.35 | 0.88-0.91 / 1.18 |
| **parallel, one refine per array** | 92,864 | 0.32 / 0.35 | **0.78-0.82 / 1.06-1.07** |

Building a `Cell` object per move from the arrays (what dispatch stores) added nothing measurable. The script is on the unmerged branch `222-exp-decode-bench` (`scratch/decode-moves.ts`).

## Decision

We will publish `drivers.moved { tick, driverIds, xs, ys }`: move i is driver `driverIds[i]` stepping to cell `(xs[i], ys[i])`.

- The schema checks every field, each array with one Zod refine: every ID matches DriverId's pattern, every coordinate is a non-negative safe integer (Cell's rule), and the three arrays have the same length. Any failure rejects the whole message.
- `driversMoved(tick, moves)` builds a message and `forEachMove(message, visit)` reads one, both in `src/shared/messages.ts`; no other module touches the arrays. `forEachMove` brands each ID and cell it hands out.
- Chunks of at most 5,000 moves, none when no driver moved, published before the shard's other events of the tick, one persisted row per message, replay unchanged: as ADR 0045.

## Rationale

- Fastest candidate that keeps Zod validating every field: 0.78-1.07 ms per chunk against 1.70-2.19 for 0045's shape, 52-55% less, on both CPU models. JSON.parse halves (one string and two numbers per move, no objects), and Zod runs three refines instead of 15,000 element schemas.
- Payload 62% smaller (about 19 bytes per move instead of 49), so less for NATS, the persister's rows and replay to carry.
- Keeping the shape behind two functions means the next shape change touches one module, not every consumer.

## Alternatives considered

- Tuples per move: smaller than objects but slowest under Zod (a tuple schema per move).
- Flat cells (`[x0, y0, x1, y1, ...]`): same element count as `xs` / `ys`, no faster, and harder to read.
- Parallel arrays with a schema per element: idiomatic Zod (branded `DriverId` per ID, `z.int().nonnegative()` per coordinate), 30-35% slower than one refine per array. The refines check the same rules.
- Binary or columnar encodings, or skipping Zod: out of scope (CLAUDE.md: Zod for all validation, JSON on the bus).
- Larger chunks: the per-message overhead is small next to per-move work, and 5,000 keeps one message's decode short; no number argued for a change.

## Consequences

- One refine per array reports one issue for the array, not the index of the bad element. Fine for logging a rejected message.
- DriverId's pattern now lives in one constant used by two schemas.
- Every producer and consumer of `drivers.moved` changes in this change. Runs stored before it keep the old payload: replay skips their `drivers.moved` rows (logged `stored_event_skipped`) and replays the rest; `bun run report` reads only trip events and is unaffected.
- Querying one driver's path from ClickHouse zips the payload's arrays (`arrayZip`) instead of `arrayJoin` over move objects.
- In-process event logs are identical with moves expanded per move; only the payload bytes change.
