# 0052. Carry driver indexes, not driver IDs, in moves

- Status: Accepted
- Date: 2026-10-07
- Supersedes 0047's and 0049's message shape (`driverIds`); their parallel arrays, one-pass checks, chunks of at most 5,000, order in a shard's tick and per-region routing (ADR 0050) are kept

## Context

Greedy `1x1` keeps up to 400k drivers live; above it settle fails on the runner's 2 physical cores during each tick's burst of moves, and dispatch's slowest instance spends 262-378 ms per tick at 400k, mostly decoding and applying `drivers.moved` ([What fails first](../performance.md#what-fails-first)). The persister decodes every move too. Per move, what costs is the driver ID: JSON.parse building a string, and dispatch's `Map` lookup by that string ([Dispatch moves profile](../performance-history.md#dispatch-moves-profile)).

Driver IDs are already a function of a number: `driverShardService` (`src/sim/services.ts`) names driver i of shard s `d-` + (s × driversPerShard + i), zero-padded to the digits of fleet size − 1, so that plain string order is numeric order ("ordered by ID"). Every process of a run computes the same IDs from `SimConfig`.

Re-measured against master `8ea1925` (one-pass Zod, x and y on dispatch's record, 8-cell buckets): one tick of `drivers.moved`, every driver moving, 2 shards, chunks of 5,000, one region, median of 29 ticks, Bun 1.4.2, unmerged branch `268-exp-index-bench` (`scratch/index-bench.ts`), run [37685252415](https://github.com/kludw/uber-simulator/actions/runs/37685252415): two jobs on AMD EPYC 7763, one on Intel Xeon Platinum 8573C. Dispatch's decode + apply, ms per tick:

| Fleet | Driver IDs (today: JSON.parse + Zod + `decideDispatch`) | Driver indexes (JSON.parse + Zod + records in an array by index) | Less |
| --- | ---: | ---: | ---: |
| 400k | 146.0 / 179.3 (7763), 177.2 (8573C) | 38.6 / 39.0, 45.1 | 74-78% |
| 500k | 202.5 / 255.1 (7763), 239.1 (8573C) | 48.8 / 50.4, 55.9 | 76-80% |

Full table, method and the persister's share in [Driver indexes in moves](../performance-history.md#driver-indexes-in-moves). Payload 23% smaller (7.43 → 5.72 MB per tick at 400k). Readers that want IDs back (UI, invariant checker) pay nothing more: 2.8-3.6 ms per tick reading IDs from a table against 3.5-4.3 today.

## Decision

We will send `drivers.moved` and `drivers.went_online` as `{ type, tick, region, fleetSize, driverIndexes, xs, ys }`: entry i is the driver with **driver index** `driverIndexes[i]` at cell `(xs[i], ys[i])`.

1. **Driver index**: a driver's place in the run's fleet, `0 ≤ index < fleetSize`, global (not per shard or region): shard s's driver i is s × driversPerShard + i. Its driver ID is today's, made from the index by one function: `d-` + index, zero-padded to the digits of fleetSize − 1. IDs, offers' subjects and every other message naming a driver are unchanged.
2. **One module owns the ID format** (`src/shared/fleet.ts`): `driverIdAt(fleetSize, index)`, from a table filled once per index. The shards' ID making (`src/sim/services.ts`) moves there; nothing else formats or parses a driver ID.
3. **Each message stands alone**: `fleetSize` is in every message, so any reader turns an index into an ID with no config, no earlier message and no roster.
4. **Checks** (ADR 0047's one-pass style): `fleetSize` a positive safe integer; `driverIndexes` one pass, every entry a non-negative safe integer; across arrays, equal lengths and every index below `fleetSize`. Branded `DriverIndex`.
5. **Readers**, in `src/shared/messages.ts`: `forEachMove` / `forEachWentOnline` keep visiting `(driverId, cell)`, the ID from `driverIdAt`, so the UI and the invariant checker don't change; `forEachDriverAt` visits `(driverIndex, x, y)` for dispatch. Builders take `{ driverIndex, cell }` entries.
6. **Driver shards** get the fleet size and their first index in config and keep each driver's index on its record.
7. **Dispatch** keeps its driver records in an array by index, sized to the first message's `fleetSize`, for moves; records still carry their ID, and a `Map` by ID, set when a driver is first placed and cleared when dropped, serves the rare messages that name a driver by ID (`driver.went_offline`, offer replies, arrivals, `confirm_trip`). Within one fleet index order is ID order, so tie-breaks and outcomes are unchanged.

## Rationale

- **74-80% less dispatch decode + apply at 400k-500k** on both CPU models, the largest per-move cost left; the persister's decode shrinks the same way (its stringify of the row doesn't). Numbers in Context.
- **Arithmetic, not a mapping message**: IDs are already a pure function of shard config. Putting the size in the message keeps every message self-contained, so late joiners, lost messages, replay and the region handoff behave exactly as today, with no new state or message to lose.
- **Global index**: one number per driver, the same in every shard, region and consumer; per-shard indexes would need the shard sizes too.
- **One reader API for ID consumers** keeps the change in `messages.ts`, `fleet.ts`, the shards' emit and dispatch's index.

## Alternatives considered

- **Index → ID mapping from `drivers.went_online` (IDs and indexes), moves with indexes only**: same decode gain, but a move no longer stands alone. With shifts off, `went_online` is only published at start, so a consumer that joins late (UI mid-run, a restarted dispatch, ADR 0043's start race) or loses a chunk (ADR 0041) can't name those drivers for the rest of the run; replay must start from the mapping. Rejected.
- **A periodic roster message** (index → ID every N ticks): bounds that gap to N ticks, at the cost of a new message, a wait for joiners and state in every consumer. Rejected: arithmetic needs none of it.
- **Per-shard indexes plus a `shard` field**: two fields and the shard sizes to make an ID. Rejected for the global index.
- **Unpadded IDs (`d-<index>`), so no size is needed**: "ordered by ID" (plain string order) would no longer be numeric order, changing every tie-break and every outcome. Rejected: milestone 25 keeps outcomes identical.
- **Indexes only, size from each consumer's config**: the UI and replay have no `SimConfig`, and a stored payload would need its run's config to read. Rejected for one number per message.
- **Keep IDs, decode on a worker**: moves overtake the shard's later messages (ADR 0042, 0045) and the apply cost stays. Not this decision; still open.
- **Change `drivers.moved` only, keep IDs in `drivers.went_online`**: one schema serves both today; two shapes for one fact. Rejected.

## Consequences

- **Every producer and consumer of the two messages changes**, behind the readers: driver shards build with indexes; dispatch applies by index; the UI and the invariant checker read IDs as before; the persister stores the new payload, one row per message, driver ID empty (ADR 0029); the load test's observer reads only the tick and is unaffected. In-process event logs are identical with moves expanded per move.
- **Late joiners** (UI mid-run, a restarted dispatch) learn drivers from their first move, as today (ADR 0043). **Message loss**: a lost chunk loses those moves until the drivers' next, as today (ADR 0041, 0045); nothing else depends on it. **Regions**: routing unchanged (ADR 0050); each instance's array spans the fleet, mostly empty outside its region (8 bytes per slot, 4 MB at 500k).
- **Stored runs** from before this change keep `driverIds` payloads: replay skips their `drivers.moved` and `drivers.went_online` rows (`stored_event_skipped`), as for 0047 and 0049, so a replayed old run shows no driver positions; `bun run report` reads only trip events and is unaffected. Querying a driver's path in ClickHouse zips `driverIndexes` with `xs`, `ys` and filters by index (the ID's number).
- **Driver IDs are now a contract**: every driver in a run must be `driverIdAt(fleetSize, index)`. Tests that hand-build IDs (`d-1`, `d-10`) take them from `driverIdAt` or a fleet that pads them that way.
- A message whose `fleetSize` differs from the first one dispatch saw is a misconfigured run (processes started with different shard sizes); dispatch throws, as for other broken invariants (ADR 0048).
- **Follow-up** ([#269](https://github.com/kludw/uber-simulator/issues/269)), two PRs, each keeping outcomes identical: (a) the message: `fleet.ts`, schema, builders and readers, shards emitting indexes, dispatch still applying by ID through `forEachMove` (decode gain only), persister and replay fixtures, `domain` and `nats` skills, spec; (b) dispatch's records in an array by index (apply gain), then the load test at 450k and 500k.
