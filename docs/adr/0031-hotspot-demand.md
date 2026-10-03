# 0031. Hotspot demand as a selectable rider demand model

- Status: Accepted
- Date: 2026-10-03

## Context

Riders spawn uniformly over the grid (ADR 0016). Real demand clusters (downtown, airport), and the milestone 6 comparison (`bun run sim -- --compare`) showed batched matching losing slightly to greedy under uniform, light demand (~10 requests/min, 100 drivers). The spec lists hotspot demand as a later feature. The rider brain draws per-tick child streams (`demand:<tick>`, `patience:<tick>`), so runs are deterministic per seed.

## Decision

We will:

- Add a rider `demand` config: `{ type: "uniform" }` (default, unchanged) or `{ type: "hotspots", hotspotShare, hotspots: [{ center, radius, weight }] }`.
- In hotspot mode, each spawned rider's pickup comes from a hotspot with probability `hotspotShare`, else uniformly. A hotspot is chosen with probability proportional to `weight`; the pickup is uniform over cells within Manhattan `radius` of `center`, clipped to the grid. Dropoffs stay uniform (distinct from pickup). Spawn count (Poisson) and patience are unchanged.
- Draw hotspot choices from a separate per-tick child stream (`hotspot:<tick>`), so uniform mode consumes exactly the same random draws as before and stays byte-identical.
- Define one named preset (`city`: a downtown hotspot at the grid center and an airport hotspot near a corner) next to the spec defaults, used by the CLI and services.
- Make the in-process comparison configurable: `bun run sim` (incl. `--compare`) gains `--demand uniform|city`, `--requests-per-minute`, `--drivers-per-shard`; services read `DEMAND` from env.

## Rationale

- A mixture of uniform background plus weighted hotspots is the simplest model that produces clustered demand while keeping every rider reachable.
- Uniform-within-radius is easy to test exactly (every pickup inside its hotspot) and needs no floating-point distributions.
- A separate stream keeps existing seeded results and tests unchanged.
- Exposing demand rate and fleet size lets `--compare` test the batching hypothesis under heavier, clustered load in one command.

## Alternatives considered

- Gaussian hotspots: more realistic falloff, needs float sampling and clamping; no benefit for the comparison yet.
- Hotspot-biased dropoffs too: realistic for commutes, but doubles the parameters; later if needed.
- Time-of-day demand curves: separate feature (spec "Later").
- Arbitrary hotspot lists from the CLI: a preset covers the experiment; free-form config can come later.

## Consequences

- Rider brain config grows; dispatch, drivers, UI, persistence, and the invariant checker are unchanged (riders still send `request_trip`).
- Comparisons can now show where batched matching pays off, or that it doesn't.
