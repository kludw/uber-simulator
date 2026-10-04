# Performance

Where wall time and memory go at 1k, 5k, and 10k drivers, measured 2026-10-03 at `0efef1e` ([#108](https://github.com/kludw/uber-simulator/issues/108)). The baseline is measurements only; the ADR 0033 fixes and their effect are in [After milestone 9 fixes](#after-milestone-9-fixes), 1-hour runs in [Long runs](#long-runs), 20k-50k in [Toward 50k](#toward-50k), and 50k after the ADR 0036 fixes in [After milestone 12](#after-milestone-12).

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

## Toward 50k

Measured 2026-10-04 at `1bc3a92` ([#143](https://github.com/kludw/uber-simulator/issues/143), milestone [#142](https://github.com/kludw/uber-simulator/issues/142)): 20k and 50k drivers, measurements only. Targets (#142): 50k drivers, greedy and batched, p95 < 1,000 ms per tick on the CI runner; memory grows with trips, not messages.

### Method

- Same command, scenario, runner, and Bun version as [Method](#method): 2 driver shards (10,000 or 25,000 drivers each), demand at the spec ratio (2,000 requests/min at 20k, 5,000 at 50k), 600 ticks. 4 CPUs, 15,989 MiB, 1-minute load average 0.14-1.59 at start.
- Runs ([workflow](https://github.com/kludw/uber-simulator/actions/workflows/bench.yaml)), all finished 600 ticks inside the 60 min cap:
  - [37197242785](https://github.com/kludw/uber-simulator/actions/runs/37197242785): 20k / 50k × greedy / batched, CPU-profiled.
  - [37197252026](https://github.com/kludw/uber-simulator/actions/runs/37197252026): 50k greedy and batched, no profiler (`-f cpu_profile=false`).
- One run per case; runner noise (up to 64% between same-case runs above) applies.
- Hot-spot shares come from each run's `--cpu-prof-md` summary (self time; `file:line` as the profile reports it). The grouped shares under Candidate fixes are computed from the same `.cpuprofile` files by assigning each sample to its nearest named caller in `src/` (so a native `map` / `find` / `filter` counts toward the brain function that called it); each sample counts once.

### Results

| Drivers | Matching | Profiled | Mean ms/tick | p95 ms/tick | Messages | Peak RSS | Heap at end (objects) | Status |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 20,000 | greedy | yes | 58.84 | 78.13 | 12,218,108 | 230.7 MiB | 43.0 MiB (0.67 M) | finished |
| 20,000 | batched | yes | 71.21 | 208.14 | 12,217,967 | 363.4 MiB | 61.7 MiB (0.50 M) | finished |
| 50,000 | greedy | yes | 340.41 | 477.96 | 30,534,879 | 729.9 MiB | 52.8 MiB (0.86 M) | finished |
| 50,000 | batched | yes | 447.11 | 1,317.96 | 30,534,210 | 1,677.6 MiB | 477.5 MiB (1.60 M) | finished |
| 50,000 | greedy | no | 194.36 | 267.24 | 30,534,879 | 254.9 MiB | 78.8 MiB (1.11 M) | finished |
| 50,000 | batched | no | 336.23 | 972.13 | 30,534,210 | 1,236.8 MiB | 122.1 MiB (0.83 M) | finished |

- p95 target at 50k, unprofiled: greedy 267.24 ms, met with 3.7× headroom. Batched 972.13 ms, under 1,000 by 2.8%, less than run-to-run noise, so not reliably met; profiled it is 1,317.96 ms.
- Messages are 2.50× from 20k to 50k and 5.00× from 10k (6,109,043 greedy, [After milestone 9 fixes](#after-milestone-9-fixes)), proportional to fleet and demand.
- Per-tick cost grows faster than the fleet. Profiled, 20k → 50k (2.5×): greedy mean 5.8×, batched mean 6.3× (p95 6.1×, 6.3×), close to 2.5² = 6.25. Unprofiled, 10k → 50k (5×; 10k from run 37156733825 at `424942c`, two milestones earlier): greedy mean 8.7×, batched 12.4×. Two or three points per case and one run each don't pin down an exponent.
- The profiler costs more here than at 10k (where profiled and unprofiled means were within 3%): at 50k profiled / unprofiled is 1.75× (greedy) and 1.33× (batched) in mean ms per tick, 1.79× and 1.36× at p95. Shares below are from profiled runs; whether they hold unprofiled is not measured.

### Top hot spots (CPU profiles, self time)

| Case | Function | Share (self) |
| --- | --- | ---: |
| 50k greedy | `map` (native), called from driver-shard `replaceDriver`, rider `onPickedUp`, driver-shard `onOffer` (copies of `state.drivers` / `state.riders` per event) | 15.4% |
| 50k greedy | `greedyPairs` (`src/dispatch/brain.ts:239`) | 13.9% |
| 50k greedy | `cellOf` (`src/dispatch/brain.ts:275`), called from `greedyPairs` | 9.4% |
| 50k greedy | driver-shard `onPickedUp` (`src/driver/brain.ts:337`, `state.drivers.find`) | 7.9% |
| 50k greedy | `map` callbacks: rider brain / `src/driver/brain.ts:391` (`replaceDriver`) / driver brain | 7.3% / 5.7% / 4.7% |
| 50k greedy | `find` (native), from driver-shard `onCompleted`, `onPickedUp`, `onOffer` | 6.6% |
| 50k greedy | `filter` (native), from rider `removeRider` (`src/rider/brain.ts:197`) | 5.8% |
| 50k batched | `cellOf` (`src/dispatch/brain.ts:275`), called from the `batchedPairs` cost matrix | 18.6% |
| 50k batched | `map` (native), from `batchedPairs` and the driver-shard and rider brains | 13.6% |
| 50k batched | `solve` (Hungarian loop, `src/dispatch/matching.ts:58`) | 8.9% (+1.5% at :57) |
| 50k batched | `map` callbacks: driver brain / rider brain | 7.8% / 5.9% |
| 50k batched | `filter` (native), rider `removeRider` | 5.0% |
| 50k batched | `flat` (native), from `solve` (`src/dispatch/matching.ts:48`, the sentinel sum over the whole cost matrix) | 2.7% |
| 20k greedy | `map` / `greedyPairs` / driver-shard `onPickedUp` | 12.8% / 12.6% / 7.6% |
| 20k batched | `cellOf` / `map` / `solve` (`:58`) | 15.7% / 14.2% / 7.6% |

- No single function dominates. The costs sit in two places: brains that scan and copy a whole array per event (driver shards: `state.drivers`, 25,000 per shard at 50k; riders: `state.riders`), and dispatch matching that does work per (queued trip, idle driver) pair every tick (greedy) or every batch tick (batched).
- Everything else measured is small at 50k: bus `drain` + `shift` 1.0% total (greedy), `onDriverReported` 0.7-1.0% self.

### Memory (unprofiled)

- 50k batched peaks at 1,236.8 MiB RSS against 254.9 MiB for 50k greedy, with the same message count (30.5 M) and a heap at the end of 122.1 vs 78.8 MiB. Heap still live at the end does not explain the batched peak. Not attributed: no heap snapshot was taken during a batch tick. A candidate in the code: each batch tick builds a queued × idle cost matrix in `batchedPairs` and `solve` copies all of it once more (`costs.flat()`); `flat` is 2.7% self in the 50k batched profile. Unmeasured.
- Against 10k unprofiled at 600 ticks (run 37156733825, `424942c`): heap at end 14.9 → 78.8 MiB greedy (5.3×), 18.5 → 122.1 MiB batched (6.6×), for 5× drivers and 5× messages; peak RSS 131.4 → 254.9 MiB greedy (1.9×), 143.4 → 1,236.8 MiB batched (8.6×).
- Memory over run length at 50k (the #142 target: two run lengths, unprofiled) is not measured; only 600 ticks were run.

### Candidate fixes, ranked by measured impact

Shares are grouped by owning `src/` function (see Method), at 50k greedy / 50k batched (20k in brackets).

| # | Hot spot | 50k greedy | 50k batched | 20k greedy / batched |
| ---: | --- | ---: | ---: | ---: |
| 1 | Driver-shard brain, `state.drivers` scan + copy per event: `replaceDriver`, `onOffer`, `onPickedUp`, `onCompleted` | 44.0% | 35.5% | 44.0% / 35.7% |
| 2 | Dispatch matching per (trip, idle driver) pair: greedy `greedyPairs` + `cellOf`; batched cost matrix (`batchedPairs` + `cellOf`) + Hungarian (`solve`, `minCostMatching`) | 23.6% | 37.0% (21.9 + 15.1) | 17.6% / 33.0% |
| 3 | Rider brain, `state.riders` scan + copy per event: `onPickedUp`, `removeRider`, `onCompleted` | 20.0% | 17.4% | 16.2% / 13.1% |
| 4 | Dispatch `offerPairs`: walks every live trip and sorts every driver ID each tick | 3.8% | 3.0% | 6.6% / 5.2% |
| 5 | In-memory bus `drain` / `publish` | 1.9% | 1.5% | 4.5% / 3.5% |

1. **Driver shards: keep drivers by ID and update in place** (44.0% / 35.5%). Each event does `state.drivers.find` (O(drivers per shard)) and most then `state.drivers.map` to copy the array; with events proportional to the fleet that is O(drivers²) per shard per tick. Owned state (ADR 0033) applies; tracked in [#123](https://github.com/kludw/uber-simulator/issues/123). Iteration order must stay the same so event logs stay byte-identical (checked by hashing, as for the [Long runs](#long-runs) fix).
2. **Dispatch matching: less work per (trip, driver) pair** (23.6% greedy, 37.0% batched). Options, each needing its own measurement: read each idle driver's cell once per tick instead of once per pair (`cellOf` alone is 9.5% greedy, 18.7% batched); compute the Hungarian sentinel without `costs.flat()` (`flat` 2.7% self); a spatial index for greedy's nearest-driver search (exact); k-nearest candidates for batched (not exact; ADR 0033 rejected it while not needed, so a new ADR).
3. **Rider brain: keep riders by trip ID and update in place** (20.0% / 17.4%). Same pattern as 1, sized by riders in flight rather than drivers; tracked in [#146](https://github.com/kludw/uber-simulator/issues/146).
4. **`offerPairs`** (3.8% / 3.0%): not worth changing before 1-3.
5. **Bus** (1.9% / 1.5%): not worth changing.

Upper bounds only: each share is what removing that work entirely would save in a profiled run; the actual saving, and the shares in unprofiled runs, are not measured. Batched p95 is the case closest to the target (972.13 ms unprofiled); there, fixes 1-3 cover 89.9% of profiled CPU.

### Grid index tuning

Dispatch's idle driver index ([#147](https://github.com/kludw/uber-simulator/issues/147), `src/dispatch/idle-drivers.ts`) has two tuning knobs: cells per bucket side and the number of drivers left below which a linear scan replaces the ring search (ADR 0036). Measured 2026-10-04 on a local dev machine (load average ~4), a microbenchmark outside the simulation: index one tick's idle drivers, uniform on the 500 × 500 grid, then take the nearest for uniform pickups; mean of 20 seeds.

| Cells per bucket side | 50k drivers, 100 trips: ms per tick | 1k drivers, 100 trips: ms per tick |
| ---: | ---: | ---: |
| 2 | 5.54 | |
| 4 | 1.69 | 0.277 |
| 8 | 1.33 | 0.107 |
| 16 | 1.19 | 0.072 |
| 32 | 1.30 | 0.070 |
| 64 | 2.18 | |

| n drivers, n trips (all taken), 16 cells per bucket side | linear scan, ms | ring search, ms |
| ---: | ---: | ---: |
| 32 | 0.028 | 0.068 |
| 64 | 0.080 | 0.088 |
| 128 | 0.164 | 0.132 |
| 256 | 0.460 | 0.191 |

Chosen: 16 cells per bucket side (fastest at 50k, close to best at 1k), linear scan below 64 drivers left (the crossover lies between 64 and 128). Either way the result is the same driver; only time changes.

Effect at 50k, local and relative only (`bun run bench -- --drivers 50000 --ticks 300`, master `3e1c221` and the branch alternated, two rounds, load average 3.7-4.5):

| | master mean / p95 (ms) | branch mean / p95 (ms) |
| --- | ---: | ---: |
| greedy, round 1 | 78.46 / 111.79 | 17.39 / 20.50 |
| greedy, round 2 | 75.64 / 92.49 | 18.83 / 24.00 |
| batched, round 1 | 121.43 / 573.70 | 74.84 / 333.77 |
| batched, round 2 | 126.23 / 598.24 | 75.85 / 332.80 |

Peak RSS, batched: master 1,549 / 1,581 MiB, branch 2,223 / 1,946 MiB (greedy unchanged, 385-415 MiB). Not attributed; the branch allocates no more per batch tick than master (same cost matrix, no flattened copy), so GC timing is a candidate, unmeasured. CI runs judge the milestone (ADR 0036).

## After milestone 12

Measured 2026-10-04 at `15e5039` ([#148](https://github.com/kludw/uber-simulator/issues/148), milestone [#142](https://github.com/kludw/uber-simulator/issues/142)), after the three ADR 0036 fixes: driver shard state by driver ID ([#149](https://github.com/kludw/uber-simulator/pull/149)), rider state by trip ID ([#150](https://github.com/kludw/uber-simulator/pull/150)), and a grid index for greedy's nearest idle driver plus one idle-driver snapshot per tick ([#151](https://github.com/kludw/uber-simulator/pull/151)).

### Method

- Same command, scenario, and runner as [Toward 50k](#toward-50k): 50,000 drivers in 2 shards, 5,000 requests/min, seed 1, 5-tick batch window. 4 CPUs, 15,988-15,989 MiB, 1-minute load average 0.00-1.33 at start.
- Runs ([workflow](https://github.com/kludw/uber-simulator/actions/workflows/bench.yaml)), each 50k greedy and batched, all `finished`:
  - Unprofiled (`-f cpu_profile=false`), 600 ticks: run A [37200961616](https://github.com/kludw/uber-simulator/actions/runs/37200961616), run B [37200967308](https://github.com/kludw/uber-simulator/actions/runs/37200967308).
  - Unprofiled, 1,800 ticks: [37200973973](https://github.com/kludw/uber-simulator/actions/runs/37200973973).
  - CPU-profiled, 600 ticks: [37200980196](https://github.com/kludw/uber-simulator/actions/runs/37200980196).
- Judged per ADR 0036: unprofiled only; p95 < 1,000 ms counts as reliably met only if the slower of the two 600-tick runs has p95 <= 610 ms.

### Results

| Matching | Ticks | Profiled | Run | Mean ms/tick | p95 ms/tick | Messages | Peak RSS | Heap at end (objects) | Status |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| greedy | 600 | no | A | 32.39 | 42.41 | 30,534,879 | 267.4 MiB | 80.8 MiB (1.31 M) | finished |
| greedy | 600 | no | B | 24.50 | 30.75 | 30,534,879 | 269.3 MiB | 81.3 MiB (1.27 M) | finished |
| greedy | 1,800 | no | | 36.27 | 46.80 | 91,631,180 | 389.5 MiB | 103.0 MiB (1.80 M) | finished |
| greedy | 600 | yes | | 32.67 | 42.85 | 30,534,879 | 304.2 MiB | 103.9 MiB (1.74 M) | finished |
| batched | 600 | no | A | 121.36 | 566.24 | 30,534,210 | 926.8 MiB | 126.4 MiB (0.85 M) | finished |
| batched | 600 | no | B | 123.85 | 599.53 | 30,534,210 | 934.2 MiB | 126.1 MiB (0.85 M) | finished |
| batched | 1,800 | no | | 110.33 | 437.78 | 91,630,393 | 933.1 MiB | 158.7 MiB (1.67 M) | finished |
| batched | 600 | yes | | 132.21 | 623.21 | 30,534,210 | 2,218.1 MiB | 959.6 MiB (9.45 M) | finished |

- Message counts at 600 ticks match [Toward 50k](#toward-50k) exactly (30,534,879 greedy, 30,534,210 batched), as ADR 0036 requires.
- Against Toward 50k (unprofiled, 600 ticks, one run at `1bc3a92`): greedy mean 194.36 → 24.50-32.39 ms, p95 267.24 → 30.75-42.41 ms (6-9×); batched mean 336.23 → 121.36-123.85 ms (2.7-2.8×), p95 972.13 → 566.24-599.53 ms (1.6-1.7×).
- The two unprofiled 600-tick runs differ by 32% in greedy mean (24.50 vs 32.39) and 6% in batched p95 (566.24 vs 599.53).

### Targets (ADR 0036)

- **50k greedy, p95 < 1,000 ms: reliably met.** Slower unprofiled 600-tick run: 42.41 ms, under the 610 ms band (23.6× headroom against 1,000 ms). 1,800 ticks: 46.80 ms.
- **50k batched, p95 < 1,000 ms: reliably met, narrowly.** Slower unprofiled 600-tick run: 599.53 ms, 10.47 ms under the 610 ms band (1.67× headroom against 1,000 ms, against the 1.64× ADR 0036 asks for). That margin is smaller than the 33 ms p95 spread between runs A and B. 1,800 ticks: 437.78 ms. The profiled run is 623.21 ms, inside the band; profiles explain, they don't judge.
- **Memory grows with trips, not messages: met.** Unprofiled, 600 → 1,800 ticks (600-tick values are the mean of runs A and B): messages 3.00× (30.53 M → 91.63 M) and requested trips about 3× (5,000 requests/min: about 50,000 → 150,000). Heap objects at the end 1.39× greedy (1.29 M → 1.80 M) and 1.96× batched (0.85 M → 1.67 M); heap bytes 1.27× greedy (81.1 → 103.0 MiB) and 1.26× batched (126.3 → 158.7 MiB); peak RSS 1.45× greedy (268.4 → 389.5 MiB) and 1.00× batched (930.5 → 933.1 MiB). As at 10k ([After milestone 9 fixes](#after-milestone-9-fixes)), messages and trips both triple, so ratios alone can't separate them; the magnitude can. The extra 61.1 M messages came with 0.50 M (greedy) and 0.82 M (batched) more heap objects: 0.008-0.013 per extra message, or about 5-8 per extra trip, in line with the 7 per trip at 10k (dispatch keeps each ended trip). Heap bytes depend on GC timing and RSS on the runtime and allocator, so neither is attributed further from these runs. Batched peak RSS doesn't grow with run length (930.5 → 933.1 MiB); what sets it is not measured.

### Batched peak memory

[#151](https://github.com/kludw/uber-simulator/pull/151) saw higher batched peak RSS on the branch than on master in local runs ([Grid index tuning](#grid-index-tuning): 1,946-2,223 vs 1,549-1,581 MiB, 300 ticks, busy dev machine). CI unprofiled does not show it: 926.8 and 934.2 MiB at `15e5039` against 1,236.8 MiB at `1bc3a92` (one run; #149 and #150 also landed in between), a 25% drop. Profiled CI does show a rise, 1,677.6 → 2,218.1 MiB (heap at end 477.5 → 959.6 MiB), but the profiler inflates memory (2.4× the unprofiled peak here), so it isn't read as a regression. Why local and CI disagree is not measured.

### Top hot spots (CPU profiles)

Grouped by nearest named `src/` caller, as in [Toward 50k](#toward-50k) (self-time `file:line` from the `--cpu-prof-md` summary in brackets).

| Case | Owner | Share |
| --- | --- | ---: |
| 50k greedy | Bus delivery and the service shell (`drain`, `publish`, `accepts`; native `shift` 5.8% self, service callback `src/bus/service.ts:27` 4.7% self) | 21.0% |
| 50k greedy | Driver-shard per-tick movement: `onTick`, `wander`, `driveToDropoff`, `stepToward` (native `cloneObject` 7.7% self, from `wander` / `stepToward` / `driveToDropoff` copying a driver per step) | 36.3% |
| 50k greedy | Dispatch `offerPairs`: walks every live trip each tick (`src/dispatch/brain.ts:210`) | 13.7% |
| 50k greedy | Dispatch `onDriverReported` (`src/dispatch/brain.ts:355`, one `Map.set` per driver report) | 11.7% |
| 50k greedy | Dispatch `idleDrivers` snapshot + sort by ID, then `indexIdleDrivers`, `searchRings`, `closer` | 7.8% + 3.9% |
| 50k batched | Hungarian `solve` (`src/dispatch/matching.ts:60-61` 36.2% self) + `minCostMatching` + `at` | 42.0% |
| 50k batched | `batchedPairs` building the queued × idle cost matrix (native `map` 18.7% self; callback `src/dispatch/brain.ts:266` 6.0% self) | 32.2% |
| 50k batched | Bus and driver-shard movement, as greedy | 5.5% + 10.2% |
| 50k batched | Dispatch `offerPairs` / `onDriverReported` | 4.3% / 3.6% |

- The ADR 0036 targets are gone from the top: driver-shard event handlers (44.0% / 35.5% before; now `onPickedUp` + `onOffer` + `onCompleted`) are 0.30% / 0.09%, the rider brain (20.0% / 17.4%) is 1.3% / 0.4%, and greedy's nearest-driver search (`indexIdleDrivers` + `searchRings` + `closer`) is 3.9%.
- Greedy has no dominant hot spot left: per-tick work proportional to the fleet (moving every driver, every driver report, every message through the bus) and dispatch's per-tick walk of live trips and idle drivers.
- Batched is now 74% matching: the exact Hungarian solve, O(queued² × idle) per batch tick, and the dense cost matrix it reads. One tick in 5 is a batch tick, so its p95 falls on one. This is where ADR 0036's follow-up (k-nearest pruning vs dispatch sharding) would act if batched ever misses the target.
