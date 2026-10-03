# Performance

Where wall time and memory go at 1k, 5k, and 10k drivers, measured 2026-10-03 at `0efef1e` ([#108](https://github.com/kludw/uber-simulator/issues/108)). The baseline is measurements only; the ADR 0033 fixes and their effect are in [After milestone 9 fixes](#after-milestone-9-fixes), and 1-hour runs in [Long runs](#long-runs).

## Method

- Command: `bun run bench` ([README](../README.md#benchmark)). One in-process run (`runInProcess`, in-memory bus; the baseline kept the full event log, which runs no longer do since [#118](https://github.com/kludw/uber-simulator/pull/118)) on a 500 × 500 grid with 2 driver shards, uniform demand at the spec ratio (10 requests/min per 100 drivers), shifts off, seed 1, and a 5-tick batch window.
- Where: GitHub Actions `bench` workflow (`.github/workflows/bench.yaml`), one `ubuntu-latest` job per case. Not the dev machine, whose load average is often 50-90.
- Machine (`machine.txt` in each artifact): 4 CPUs, 15,989 MiB, 1-minute load average 0.02-0.72 at start, Bun 1.4.2.
- Every baseline run was CPU-profiled (`--cpu-prof --cpu-prof-md`, 1 ms sampling), so wall times include profiler overhead. Shared runners are noisy too: the two 10k greedy runs below differ by 58% in mean ms per tick (779 vs 1,231). Read the numbers as orders of magnitude.
- Cap: 30 min per run (`--max-minutes`, checked between ticks), with `timeout` 5 min later as the backstop. One batch tick can outlast both, which kills the run with no report or profile.
- Real time at speed 1 is 1,000 ms per tick (1 tick = 1 simulated second).
- Runs ([workflow](https://github.com/kludw/uber-simulator/actions/workflows/bench.yaml)):
  - [37147796738](https://github.com/kludw/uber-simulator/actions/runs/37147796738): full matrix, 1k / 5k / 10k × greedy / batched, 600 ticks.
  - [37147805973](https://github.com/kludw/uber-simulator/actions/runs/37147805973): 10k greedy, 600 ticks, plus `--heap-prof-md`.
  - [37150061471](https://github.com/kludw/uber-simulator/actions/runs/37150061471): batched at 2k / 3k / 5k for 10 ticks (2 batch ticks), 90 min cap. Run because 5k and 10k batched did not finish 600 ticks and left no profile.

## Results

| Drivers | Matching | Ticks | Mean ms/tick | p95 ms/tick | Messages | Peak RSS | Heap at end (objects) | Status |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1,000 | greedy | 600 | 7.3 | 10.1 | 611,514 | 276 MiB | 58 MiB (1.26 M) | finished |
| 5,000 | greedy | 600 | 499.9 | 584.1 | 3,054,315 | 1,691 MiB | 410 MiB (6.16 M) | finished |
| 10,000 | greedy | 600 | 778.7 | 1,047.6 | 6,109,043 | 3,031 MiB | 888 MiB (12.33 M) | finished |
| 10,000 | greedy (heap run) | 600 | 1,231.2 | 1,685.0 | 6,109,043 | 3,641 MiB | 587 MiB (12.28 M) | finished |
| 1,000 | batched | 600 | 839.5 | 6,020.7 | 611,489 | 1,354 MiB | 91 MiB (1.36 M) | finished |
| 2,000 | batched | 10 | 22,546.7 | 113,502.2 | 22,163 | 606 MiB | 8 MiB (0.08 M) | finished |
| 3,000 | batched | 10 | 61,428.9 | 307,564.5 | 33,258 | 1,511 MiB | 15 MiB (0.11 M) | finished |
| 5,000 | batched | 10 | 337,365.3 | 1,695,353.2 | 55,480 | 7,763 MiB | 14 MiB (0.16 M) | finished |
| 5,000 | batched | 600 | | | | | | did not finish in 35 min (killed, no profile) |
| 10,000 | batched | 600 | | | | | | did not finish in 35 min (killed, no profile) |

- Greedy: at 10k, the mean is close to the 1 s real-time budget and p95 is over it. Mean cost per tick grows superlinearly but noisily with fleet size: 1k to 5k is 68×, 5k to 10k is 1.56×, and 1k to 10k is 107×. These three points don't pin down an exponent. The mechanism (below) is O(drivers) work per driver report.
- Batched: the time sits almost entirely in batch ticks (every 5th tick). In the 10-tick runs, p95 (here the slowest tick) is one batch tick: 113.5 s at 2k, 307.6 s at 3k, and 1,695 s (28 min) at 5k. That's about drivers³: 2k to 3k is 1.5³ ≈ 3.4 (measured 2.7), and 3k to 5k is (5/3)³ ≈ 4.6 (measured 5.5). A 600-tick run (120 batch ticks) at 5k or 10k can't finish. Extrapolated, one batch tick at 10k takes about 4 h.
- Peak RSS in this table is confounded by the profiler. Across the 8 finished runs it largely tracks the CPU profiler's sample count (4 k samples: 276 MiB; 0.2-0.65 M: 0.6-3.6 GiB; 3.0 M: 7.6 GiB), not the simulation's heap: 5k batched has a 14 MiB heap at the end but 7.6 GiB peak RSS. Don't read RSS as simulation memory; see Memory.

## Top hot spots (CPU profiles, self time)

| Case | Function | Share (self unless marked) |
| --- | --- | ---: |
| 10k greedy | `Map` constructor (native), called from `onDriverReported` (`src/dispatch/brain.ts:352`) | 96.0% |
| 10k greedy | `onDriverReported` itself | 0.5% (+0.2% at :356) |
| 10k greedy | `cloneObject` (native) | 0.3% |
| 10k greedy | `drain` (`src/bus/in-memory.ts:21`) + `shift` (native) | 0.2% + 0.1% |
| 10k greedy | `greedyPairs` (`src/dispatch/brain.ts:233`) | 0.1% |
| 5k greedy | `Map` from `onDriverReported` | 96.7% |
| 1k greedy | `Map` from `onDriverReported` | 82.8% |
| 1k batched | `cost` (`src/dispatch/matching.ts:31`, inner loop of `minCostMatching`) | 98.8% |
| 2k / 3k / 5k batched | `cost` | 99.5% / 99.6% / 99.7% |

- **Dispatch copies its whole driver-position map on every driver report.** `onDriverReported` (and `onDriverWentOffline`) does `new Map(state.driverCells)` for every `driver.went_online` / `driver.moved`. Every driver reports most ticks, so each tick costs O(drivers) copies of an O(drivers) map, O(drivers²) in all. This is the greedy bottleneck at every fleet size.
- **`minCostMatching` pads the cost matrix to a square of `max(trips, drivers)`.** It then runs the O(size³) Hungarian loop over every padding row. With a few dozen queued trips and thousands of idle drivers, almost all of that work is on padding rows that only ever cost `sentinel`.
- Everything else (bus `drain` / `queue.shift()`, driver and rider brains, greedy matching, Zod) is under 1% at 10k.

## Memory

- Heap object count at the end is about 2 objects per message in every 600-tick run: 1.26 M / 611 k, 6.16 M / 3.05 M, 12.33 M / 6.11 M. Messages such as `driver.moved` are one object plus a `cell` object. So the retained heap grows linearly with the event log `runInProcess` keeps, at roughly 100-150 B per message. Heap bytes vary with GC timing: 587 vs 888 MiB for the same 10k run. Extrapolating, a 1-hour run (3,600 ticks) at 10k drivers would hold about 37 M messages, roughly 3.5-5 GiB of heap for the log alone.
- Peak RSS can't be attributed from these runs: every run had `--cpu-prof` on, and RSS tracks the profiler's sample count (see Results). Process memory needs an unprofiled run (`bun run bench` without the profile flags). Done after the fixes: see [After milestone 9 fixes](#after-milestone-9-fixes).
- The `--heap-prof-md` snapshot from run 37147805973 is not useful. Bun takes it on exit, after the run's data is released, so it shows a 3.6 MB heap of modules and functions. Retained-object analysis needs a snapshot taken before exit (`Bun.generateHeapSnapshot()` or `heapStats().objectTypeCounts` at the end of the run), which is a small bench follow-up.

## Candidate fixes, ranked by measured impact

1. **Dispatch: stop copying `driverCells` per driver report** (96-97% of CPU at 5k-10k greedy, 83% at 1k). Options: update in place inside the brain (it already owns its state; immutability across `decide` calls is the contract, copying per message is not), or apply a tick's reports as one batch. Expected effect: greedy per-tick cost drops from O(drivers²) to O(drivers). Needs ADR 0033, because it touches the brains' immutable-state convention.
2. **Batched matching: don't pad to a square of `max(trips, drivers)`** (98.8-99.7% of CPU in every batched run; one batch tick takes 28 min at 5k, and 600 ticks at 5k or 10k don't finish). Run the Hungarian loop over the smaller side only (rows = trips: O(trips² × drivers)), and/or limit candidates to the k nearest idle drivers per trip. Expected effect: a batch tick at 10k goes from hours to roughly the cost of a greedy tick.
3. **Event log held in memory by `runInProcess`** (linear heap growth, about 2 objects per message, 0.6-0.9 GiB after 600 ticks at 10k). Let callers that only need counts or a summary (`bun run bench`, long `bun run sim` runs) consume messages as they come instead of keeping them all. Matters for 1-hour runs at 10k (several GiB); not a CPU cost.
4. **In-memory bus `queue.shift()`** (0.1-1.0% self time). O(queue) per message in the worst case; not worth changing until 1-3 are done.

Re-measure with the same workflow after each fix and add a dated section here.

## After milestone 9 fixes

Measured 2026-10-03 at `424942c` ([#115](https://github.com/kludw/uber-simulator/issues/115)), after the three ADR 0033 fixes: dispatch updates driver positions in place ([#116](https://github.com/kludw/uber-simulator/pull/116)), batched matching runs on the rectangular cost matrix ([#117](https://github.com/kludw/uber-simulator/pull/117)), and runs check invariants and summarize without keeping the event log ([#118](https://github.com/kludw/uber-simulator/pull/118)).

### Method

- Same command, scenario, runner, and Bun version as the baseline ([Method](#method)); 4 CPUs, 15,989 MiB, 1-minute load average 0.00-0.51 at start. The event log is no longer kept.
- Runs ([workflow](https://github.com/kludw/uber-simulator/actions/workflows/bench.yaml)):
  - [37156726282](https://github.com/kludw/uber-simulator/actions/runs/37156726282): full matrix, 1k / 5k / 10k × greedy / batched, 600 ticks, CPU-profiled (as the baseline).
  - [37156733825](https://github.com/kludw/uber-simulator/actions/runs/37156733825): 10k greedy and batched, 600 ticks, no profiler (`-f cpu_profile=false`).
  - [37156740963](https://github.com/kludw/uber-simulator/actions/runs/37156740963): 10k greedy and batched, 1,800 ticks, no profiler.
- One run per case, so runner noise (58% between two identical baseline runs) applies here too.

### Results

| Drivers | Matching | Ticks | Profiled | Mean ms/tick | p95 ms/tick | Messages | Peak RSS | Heap at end (objects) | Status |
| ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1,000 | greedy | 600 | yes | 0.38 | 0.73 | 611,514 | 86.4 MiB | 14.9 MiB (0.21 M) | finished |
| 5,000 | greedy | 600 | yes | 3.53 | 6.08 | 3,054,315 | 161.9 MiB | 16.3 MiB (0.13 M) | finished |
| 10,000 | greedy | 600 | yes | 21.80 | 32.76 | 6,109,043 | 158.1 MiB | 14.4 MiB (0.18 M) | finished |
| 1,000 | batched | 600 | yes | 0.77 | 1.60 | 611,489 | 89.6 MiB | 7.4 MiB (0.08 M) | finished |
| 5,000 | batched | 600 | yes | 4.05 | 9.73 | 3,054,234 | 223.7 MiB | 44.9 MiB (0.18 M) | finished |
| 10,000 | batched | 600 | yes | 27.74 | 68.91 | 6,108,929 | 377.9 MiB | 131.1 MiB (0.60 M) | finished |
| 10,000 | greedy | 600 | no | 22.29 | 33.08 | 6,109,043 | 131.4 MiB | 14.9 MiB (0.17 M) | finished |
| 10,000 | batched | 600 | no | 27.04 | 65.73 | 6,108,929 | 143.4 MiB | 18.5 MiB (0.18 M) | finished |
| 10,000 | greedy | 1,800 | no | 27.85 | 53.69 | 18,329,698 | 202.8 MiB | 39.1 MiB (0.31 M) | finished |
| 10,000 | batched | 1,800 | no | 44.13 | 127.65 | 18,329,532 | 240.8 MiB | 35.5 MiB (0.31 M) | finished |

- Against the baseline (both profiled, 600 ticks): 10k greedy p95 1,047.6 → 32.8 ms (32×), mean 778.7 → 21.8 ms (36×). 1k batched p95 6,020.7 → 1.6 ms. 5k and 10k batched, which did not finish in 35 min, now take under 70 ms at p95. Message counts match the baseline for greedy at every size and for 1k batched, the only batched case that finished 600 ticks at baseline.
- Per-tick cost rises with run length at 10k (unprofiled, 600 → 1,800 ticks): greedy mean 1.25×, p95 1.62×; batched mean 1.63×, p95 1.94×. Not profiled at 1,800 ticks, so the cause isn't measured. One candidate in the code: dispatch never drops a trip from `trips`, copies that map on every trip event (`new Map(state.trips)`, the top hot spot below), and walks every trip each tick (`onTick`, `offerPairs`), so that work grows with the number of trips so far. Runs longer than 1,800 ticks are unmeasured.
- The profiler still inflates memory: the profiled 10k batched run has 2.6× the peak RSS and 7.1× the heap of the unprofiled one. Read memory from the unprofiled rows only.

### Top hot spots (10k CPU profiles)

| Case | Function | Share (self unless marked) |
| --- | --- | ---: |
| 10k greedy | `Map` constructor (native), called from dispatch `onArrival`, `onRequestTrip`, `onOfferReply`: `new Map(state.trips)` per trip event | 17.5% |
| 10k greedy | `map` / `find` / `filter` (native), called from the driver-shard brain (`replaceDriver`, `onOffer`, `onPickedUp`) and the rider brain (`onPickedUp`, `onCompleted`, `removeRider`): scans and copies of `state.drivers` / `state.riders` per event | 14.9% / 12.5% / 3.4% |
| 10k greedy | `greedyPairs` + `cellOf` (`src/dispatch/brain.ts:234`, `:270`): nearest idle driver per queued trip | 7.7% + 4.8% |
| 10k greedy | `onDriverReported` (`src/dispatch/brain.ts:353`, `:354`) | 2.8% + 1.7% |
| 10k batched | `Map` constructor, same dispatch callers | 16.3% |
| 10k batched | `batchedPairs` building the cost matrix (`src/dispatch/brain.ts:252`; total time, includes `cellOf` at 10.1% self) | 12.3% total |
| 10k batched | `map` / `find` / `filter`, same driver-shard and rider callers plus the cost matrix | 8.2% / 4.6% / 3.0% |
| 10k batched | `minCostMatching` called from `batchedPairs` (`src/dispatch/brain.ts:259`; total time, includes `solve`, the Hungarian loop at `src/dispatch/matching.ts:58`, at 4.3% self) | 7.5% total |

- No single hot spot dominates any more (baseline: 96% in one `Map` copy at 10k greedy, 99.7% in `cost` at 5k batched). The largest remaining costs are copy-on-update containers sized by trips (dispatch `trips`) or by drivers or riders per shard (driver and rider arrays), the pattern ADR 0033 lets a brain drop where a profile shows its cost.
- 5k profiles show the same functions with smaller shares (`Map` 8.8-10.5%, `map` 6.5-13.1%, `find` 9.4-12.2%). The 1k profiles hold 232-423 samples, too few to rank.

### Targets (ADR 0033)

- **10k, greedy and batched, p95 < 1,000 ms per tick on the CI runner: met.** Highest p95 at 10k: 127.65 ms (batched, 1,800 ticks, unprofiled); at 600 ticks 33.08 ms greedy and 65.73 ms batched unprofiled, 32.76 and 68.91 ms profiled. Every 10k run is at least 7.8× under the target, more than the 58% run-to-run noise seen at baseline.
- **Memory grows with trips, not with messages: met.** Unprofiled 10k, 600 → 1,800 ticks: messages 3.00× (6.11 M → 18.33 M) and requested trips about 3× (1,000 requests/min: about 10,000 → 30,000). Heap objects at the end grow 1.81× greedy (172,719 → 311,790) and 1.74× batched (179,501 → 311,768); heap bytes 2.62× greedy (14.9 → 39.1 MiB) and 1.92× batched (18.5 → 35.5 MiB); peak RSS 1.54× greedy (131.4 → 202.8 MiB) and 1.68× batched (143.4 → 240.8 MiB). Because messages and trips both triple, the ratios alone can't tell them apart; the magnitude can. The extra 12.2 M messages added about 0.13-0.14 M heap objects (0.011 per message, about 7 per extra trip), against about 2 objects per message at baseline, which would have meant about 37 M objects at 1,800 ticks. Heap bytes vary with GC timing, and RSS includes the runtime and allocator slack, so neither is attributed further from two runs.

### Follow-up

- Run length: per-tick cost and heap still grow over a run (above). If 1-hour runs at 10k matter, measure 3,600 ticks with a profile, then decide on the dispatch `trips` copy (owned state, ADR 0033) and pruning finished trips from dispatch state (needs a look at what still reads them).

## Long runs

Measured 2026-10-03 ([#121](https://github.com/kludw/uber-simulator/issues/121)): 10k drivers, 3,600 ticks (1 simulated hour), same scenario and runner as above.

### Before: master at `bac7159`

[37157254136](https://github.com/kludw/uber-simulator/actions/runs/37157254136), CPU-profiled: greedy mean 65.04 ms/tick (p95 99.91), batched 74.42 (p95 218.52), 3.0× and 2.7× the profiled 600-tick means above (21.80, 27.74). Peak RSS 728 MiB greedy, 5,344 MiB batched (profiled).

| Case | Function | Share (self) |
| --- | --- | ---: |
| 10k greedy | `Map` constructor: `new Map(state.trips)` in dispatch `onArrival`, `onRequestTrip`, `onOfferReply` | 48.7% |
| 10k greedy | `onDriverReported` (`src/dispatch/brain.ts:353-354`, one `Map.set`; likely GC from the copies above, 1.9% after the fix) | 11.6% |
| 10k greedy | `map` (driver-shard brain arrays) | 7.5% |
| 10k greedy | `offerPairs` walking every trip ever requested | 3.9% |
| 10k batched | `Map` constructor, same dispatch callers | 62.2% |

Dispatch copied a map of every trip ever requested on each trip event and walked it every tick, so both grew with run length.

### Fix

Dispatch updates `trips` in place (owned state, ADR 0033) and moves completed and cancelled trips to `endedTrips`, kept to answer late and duplicate inputs for them (duplicate trip IDs, late offer replies, arrivals, cancels) exactly as before but out of the per-tick scan. Event logs of every README `bun run sim` command (greedy and batched) hash identically before and after.

### After

Two runs per case, 10k drivers, at `50d8d45`:

- CPU-profiled: 3,600 ticks [37157658520](https://github.com/kludw/uber-simulator/actions/runs/37157658520), [37157841889](https://github.com/kludw/uber-simulator/actions/runs/37157841889); 600 ticks [37157660094](https://github.com/kludw/uber-simulator/actions/runs/37157660094), [37157843461](https://github.com/kludw/uber-simulator/actions/runs/37157843461).
- Unprofiled (`-f cpu_profile=false`): 3,600 ticks [37157661438](https://github.com/kludw/uber-simulator/actions/runs/37157661438), [37157845226](https://github.com/kludw/uber-simulator/actions/runs/37157845226); 600 ticks [37157662709](https://github.com/kludw/uber-simulator/actions/runs/37157662709), [37157846979](https://github.com/kludw/uber-simulator/actions/runs/37157846979).

| Matching | Profiled | Mean ms/tick, 600 ticks | Mean ms/tick, 3,600 ticks | 3,600 / 600 | p95 ms/tick, 3,600 ticks | Peak RSS, 3,600 ticks |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| greedy | no | 17.68, 16.38 | 19.41, 14.98 | 1.01× | 24.17, 18.98 | 163 MiB, 159 MiB |
| batched | no | 20.64, 15.74 | 13.34, 21.91 | 0.97× | 28.00, 47.95 | 175 MiB, 179 MiB |
| greedy | yes | 13.25, 13.64 | 20.37, 16.05 | 1.35× | 25.64, 20.10 | 321 MiB, 292 MiB |
| batched | yes | 20.78, 20.58 | 18.53, 17.94 | 0.88× | 39.33, 37.90 | 447 MiB, 436 MiB |

- Ratios are of the two-run averages. Message counts at 3,600 ticks match the before run exactly (36,660,795 greedy, 36,660,653 batched).
- Against before (profiled, 3,600 ticks): greedy mean 65.04 → 18.2 ms (3.6×), batched 74.42 → 18.2 ms (4.1×); p95 99.91 → 20-26 ms and 218.52 → 38-39 ms.
- Unprofiled, per-tick cost at 3,600 ticks is flat against 600 (1.01×, 0.97×); same-case runs differ by up to 64%, more than any growth left. Profiled greedy is 1.35×; its 3,600-tick profile has no hot spot sized by trips (no `Map` copy; `offerPairs` now walks only trips not yet ended), and profiled runs differ from unprofiled ones in both directions (600-tick greedy is faster profiled), so that gap isn't attributed further.
- Top hot spots at 3,600 ticks are now the driver-shard and rider brains' copy-on-update arrays (`map` 21.8% from `replaceDriver` / `onPickedUp` / `onOffer`, `filter` 9.0% from rider `removeRider`, `find` 5.6% at greedy; `map` 12.0% self at batched), sized by drivers or riders per shard, not by run length; then dispatch's per-tick matching (`greedyPairs`, `offerPairs`, `cellOf`). Owned state (ADR 0033) would apply to those arrays if a profile ever makes them the bottleneck.
- Heap at the end (unprofiled, 3,600 ticks) is 33-44 MiB, still growing with trips: dispatch keeps each ended trip.
