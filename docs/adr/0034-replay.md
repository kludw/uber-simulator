# 0034. Replay a stored run through NATS to the UI

- Status: Accepted
- Date: 2026-10-03

## Context

Every event of a distributed run is stored in ClickHouse with its run id, tick, JetStream sequence, and full JSON payload (ADR 0029). The UI is watch-only and live-only: it subscribes to `sim.events.>` over WebSocket and builds its view from events (ADR 0020, 0028). The spec lists replay as a later feature. The persister's JetStream stream captures `sim.events.>` (ADR 0029), so republishing stored events on `sim.events.*` would store them again.

## Decision

We will:

- Read a run's events back from ClickHouse ordered by `tick, stream_seq` (`FINAL` so redelivered duplicates collapse), page by page with keyset pagination on `(tick, stream_seq)` (not `OFFSET`), parsing each payload with `parseMessage` (ADR 0005); unparseable rows are logged and skipped.
- Add a replay command, `bun run replay -- --run <runId> [--speed N] [--from-tick T]`, that republishes those events on NATS under `replay.<runId>.<subject>` (the live subject from `subjectFor`, e.g. `replay.<runId>.sim.events.driver.moved`), paced by tick: events of tick t are published at `(t - startTick) / speed` seconds after start, where `startTick` is the first replayed tick (the run's first tick, or the first tick >= `--from-tick`); 1 tick = 1 s sim time. It publishes only, never touches live subjects, and exits when the run's events are exhausted. `--run` and the UI's `?replay=` value are parsed as `RunId` (valid subject token) before any subject is built.
- Let the UI watch a replay with `?replay=<runId>`: it subscribes to `replay.<runId>.sim.events.>` instead of `sim.events.>` and labels the status "replay <runId>". Everything else in the UI is unchanged.
- Verify fidelity on full replays (not `--from-tick`, which starts with trips in flight): the replayed events pass the invariant checker with no violations, and trips requested / completed / cancelled and mean ticks to pickup computed from them equal `bun run report` for that run. This needs grid-only entry points for the incremental checker and the trip-count part of the summary (no `RunConfig`).

## Rationale

- Reusing NATS keeps one path into the UI; the view code can't tell live from replay.
- A distinct `replay.` prefix stays outside the persister's `sim.events.>` stream, so replays are never re-persisted and can't mix with live runs on the same server.
- Pacing by tick in the replay command (not the UI) keeps the UI unchanged and makes speed a replay concern, like the clock's speed for live runs (ADR 0017).
- `tick, stream_seq` is not exact arrival order (a slow publisher's tick-t events can arrive after another's tick-t+1 events), but it is a valid causal order: each publisher's ticks never decrease and its events keep their relative order (ADR 0028), and an event caused by another has a tick >= its cause's and, if the same tick, a larger stream sequence. Pacing also needs ticks to be monotone, which arrival order doesn't guarantee.

## Alternatives considered

- HTTP/SSE endpoint on the UI server streaming from ClickHouse: second transport into the UI.
- Re-simulating from the seed: not equivalent for distributed runs (nondeterministic, ADR 0017).
- Replaying onto `sim.events.*`: would be re-persisted and confuse live consumers.
- Scrubbing/seeking in the UI: needs UI controls and server state; later, `--from-tick` covers a start point.

## Consequences

- Watching a replay takes two commands (`bun run replay`, then open the UI with `?replay=`), documented in the README.
- In-memory (`bun run sim`) runs aren't persisted, so only distributed runs can be replayed.
