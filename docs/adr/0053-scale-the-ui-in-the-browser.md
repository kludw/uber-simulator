# 0053. Scale the UI in the browser: drivers by index, tile heatmap above 10k

- Status: Accepted
- Date: 2026-10-08
- Extends 0020 (canvas, direct NATS subscription and watch-only page kept; above 10,000 drivers the canvas draws a tile heatmap instead of dots, trip lines and interpolation)

## Context

The UI ([ADR 0020](0020-browser-ui-canvas-nats-websocket.md)) was built for 100 drivers: the page subscribes to `sim.events.>` over the NATS websocket, `applyEvent` builds a new view per event (copy-on-write maps), and the canvas draws every driver as a dot each frame. Milestone 26 needs a demo that stays responsive at 100k and shows something meaningful at 400k ([#271](https://github.com/kludw/uber-simulator/issues/271)).

Measured locally, headless Chromium, one run per row ([UI at scale](../ui.md)):

| Fleet | Feed (msg/s, KB/s) | Today: frames/s, decode + apply ms/s, share of feed applied | Spiked (D): frames/s, apply ms/s, share applied | Heap today / spiked |
| --- | --- | --- | --- | --- |
| 10k | 88, 130 | 59.3, 26.6, all | (dots, as today) | 22-25 MB |
| 100k | 838-858, 1,398-1,414 | 5.0, 503, 19% | 60, 7.7, all | 36-38 MB growing / 7-19 MB |
| 400k | 3,419-3,943, 5,858-6,062 | 1.7, 457, about 2%; NATS cut the page as a slow consumer | 60, 25.5, all | 167-169 MB growing / 15-25 MB |

Two costs make today's page fall behind, neither of them the feed itself: the view copies whole maps on every event (drivers per `drivers.moved` message and per driver state event, riders and trips per trip event), and the canvas draws one arc per driver per frame (75 ms at 100k, 354 ms at 400k) plus one line per active trip (about 18k at 400k). NATS CPU with a page open is within noise of without it (10.5-11.6% against 10.5-13.5% at 400k); the page is one more copy of the feed (6 MB/s at 400k).

At 400k the grid's 250k cells hold 1.6 drivers each: dots, or one pixel per cell, are a grey carpet. Dots were measured at 10k and 100k only (60 and 5 frames per second); sizes between are unmeasured. A tile heatmap (5 × 5 cells) with `city` demand shows downtown and the airport as tiles full of busy drivers and waiting riders.

## Decision

We will keep the browser's direct NATS subscription and make the page's own work proportional to what arrives, with a level of detail by fleet size.

1. **Feed unchanged**: the page subscribes to `sim.events.>` (live) or `replay.<runId>.sim.events.>` (ADR 0034) as today, and reads every event. No gateway, no new subjects, no sampling.
2. **View by driver index, updated in place**: the view keeps drivers in typed arrays indexed by driver index (ADR 0052), sized from the messages' `fleetSize`: cell x and y, previous cell, tick moved, state (0 = not shown). `drivers.moved` / `drivers.went_online` are read with `forEachDriverAt`, without a driver ID or `Cell` per entry. Events naming a driver by ID map it to its index with `driverIndexOf` in `src/shared/fleet.ts`, which stays the one module owning the ID format. Counts per state are kept as drivers change, as today. Waiting riders and active trips stay maps by trip ID. The page owns its view and `applyEvent` updates it in place (as brains own their state, ADR 0033), so applying a message costs its own size, never the view's. Edge cases:
   - **No fleet size yet** (the page joined, no `drivers.*` message seen): events naming a driver by ID change no driver, as an unknown driver's events do today; trip, rider and counter changes still apply. Arrivals no longer place an unknown driver (today's mid-run join case): the driver appears with its next move, within a tick.
   - **Index outside the arrays** (an ID whose index is at or above the current fleet size): ignored like an unknown driver, never written.
   - **`driverIndexOf(driverId)`**: the number after `d-` for an ID in `driverIdAt`'s format; any other `DriverId` (the schema allows other tokens) returns null and the event is ignored like an unknown driver. It doesn't need the fleet size: the padding only orders IDs.
   - **Fleet size changes** (a new run, or a replay, while the page is open): the whole view resets to empty (drivers, counts, waiting riders, active trips, trip counters, mean ticks to pickup), then the message applies, so nothing of the old run lingers. Trip events of the new run arriving before its first `drivers.*` message apply to the old view and are cleared with it; a same-size new run is not detected (as today).
3. **Level of detail by fleet size** (the `fleetSize` of the latest driver message):
   - **At most 10,000 drivers** (dots): as today: a dot per driver colored by state, sliding between cells, waiting riders as squares, active trips as lines.
   - **Above 10,000** (heatmap): the city as tiles of 5 × 5 cells (100 × 100 tiles on the spec grid), recomputed once per tick, not per frame, drawn as one image scaled to the canvas: brightness by drivers in the tile against the mean, color by the tile's share of busy (non-idle) drivers, waiting riders as a red overlay per tile. No trip lines, no per-driver motion. The side panel keeps every count and says which mode is drawn, as the legend.
4. **Measured target** (for #273, headless Chromium as in [UI at scale](../ui.md)): every event applied (page's bytes per second = feed's), 60 frames per second with frame p95 at most 33 ms, and JS heap not growing, at 10k, 100k and 400k.

**Demo shape** (`bun run demo`, #275): one command that runs `docker compose up -d --wait`, then the `bun run dev` stack (its persister migrates ClickHouse on start, so no separate `db:migrate`) and the UI server together, prints the UI URL, and stops everything on Ctrl+C. Defaults: 100,000 drivers (2 shards × 50,000), 10,000 requests per minute (spec ratio), `DEMAND=city`, `SHIFTS=on`, `PREFERENCES=off`, `MATCHING=greedy`, `REGIONS=1x1`, `SPEED=1`, `SEED=1`, `UI_PORT=3000`; any of these set in the environment wins (`DRIVERS_PER_SHARD=200000` for 400k). Defaults live in one pure function, tested like `serviceProcesses`.

## Rationale

- **The measured costs are in the page, not the feed**: copy-on-write maps and per-driver drawing. Fixing them took 400k from 2% of the feed applied to all of it at 60 frames per second, main thread 19% busy (spikes A-D, [UI at scale](../ui.md)).
- **Direct subscription stays simplest**: no new process, protocol or ADR 0020 reversal; live and replay keep one path (ADR 0034). 6 MB/s over a local websocket is cheap; the demo is local.
- **Driver index is already the fleet's key** (ADR 0052): arrays by index make a move two stores, and `forEachDriverAt` already exists for dispatch.
- **A heatmap is what 400k can show**: more drivers than cells, so per-driver marks carry no more information; tiles keep the hotspots and the busy share visible. The 10,000 threshold is chosen, not found: dots kept 60 frames per second at 10k and 5 at 100k, nothing between was measured, and 10k is the safe side. It is one constant, to move if #273 measures more.
- **City demand with shifts** makes the demo's picture move: hotspots and drivers coming and going; greedy `1x1` at 100k is well inside the live limit (600k, [performance.md](../performance.md)).

## Alternatives considered

- **Server-side aggregation (a Bun gateway subscribing to NATS, pushing tiles over its own websocket)**: the browser receives kilobytes instead of megabytes and a remote viewer would work. But it adds a process, a protocol, and a second view of the world to keep equal to the browser's, and moves the same decode cost to the server, for a local demo the page now handles. Rejected; the way to go if the UI is ever watched over a network (would supersede Decision 1).
- **Sampling** (subscribe to some regions or every n-th driver message): cuts bytes but shows a partial, flickering city and wrong counts. Rejected.
- **Fixes in the view only, dots at every size**: 400k dots are a carpet and cost 354 ms per frame. Rejected.
- **One pixel per cell above the threshold** (spikes A2-C): cheap, but grey noise at 100k uniform. Rejected for tiles.
- **Level of detail by zoom** (pan and zoom into dots): interactive state the watch-only page doesn't have (ADR 0020 Consequences); later, if wanted.
- **Keep copy-on-write, batch events per tick**: still one copy per tick of a 400k-entry map and per-driver strings and objects. Rejected.

## Consequences

- `applyEvent` no longer returns a new view: tests that compare a view before and after take a snapshot first; `src/ui/view.test.ts`'s identity test ("offer events leave the view unchanged", `toBe(view)`) becomes a snapshot comparison, and `docs/architecture.md`'s listing of the UI view among pure modules changes to "owned state, updated in place" (#273). The renderer reads the arrays, not a map of `DriverView`s.
- Above 10,000 drivers the canvas shows no per-driver motion or trip lines; the panel's counts are exact at every size.
- Each open page is one more copy of the feed from NATS (6 MB/s at 400k); a page over a slow network still falls behind.
- Pre-ADR 0052 stored runs replay without driver positions, as today (ADR 0034); a fresh run replays like live, through the same view.
- **Slicing for #273**, each PR measured as in Decision 4 on its branch's instrumentation, numbers in `docs/ui.md`:
  1. **View by index, in place**: `driverIndexOf` in `src/shared/fleet.ts`; `src/ui/view.ts` typed arrays and in-place maps; renderer and panel read the new view (dots at every size for now, so 100k and 400k still draw too slowly to keep up). Tests at the `applyEvent` / `panelRows` seams, including the edge cases of Decision 2. Target: decode + apply at most about 35 ms per wall second at 400k (spike C: 34.2), measured as in [UI at scale](../ui.md) with the canvas idle (no drawing), since dots at 400k still fall behind and grow the heap by construction; JS heap flat at 10k. The 400k heap is slice 2's.
  2. **Heatmap above 10,000**: pure tile aggregation (view + grid -> tile counts and colors) tested alone; renderer chooses the mode; panel shows it. Target: Decision 4 in full (all of the feed applied, 60 frames per second, frame p95 at most 33 ms, flat heap) at 100k and 400k, dots unchanged at 10k.

  Two slices, not one: slice 1's target is backed by spike C's apply cost alone, and keeping up with the whole feed needs slice 2's drawing too (spikes A3 and B applied faster yet still fell behind while drawing), so only slice 2 carries it. Updates `docs/architecture.md`, spec UI section, README UI section.
- **#274 (replay)** then tests a fresh stored run replayed into this view against the live view at chosen ticks; **#275 (demo)** implements the demo shape above.
