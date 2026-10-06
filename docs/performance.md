# Performance

Where wall time and memory go at 1k, 5k, and 10k drivers, measured 2026-10-03 at `0efef1e` ([#108](https://github.com/kludw/uber-simulator/issues/108)). The baseline is measurements only; the ADR 0033 fixes and their effect are in [After milestone 9 fixes](#after-milestone-9-fixes), 1-hour runs in [Long runs](#long-runs), 20k-50k in [Toward 50k](#toward-50k), 50k after the ADR 0036 fixes in [After milestone 12](#after-milestone-12), 76k-500k in [Ceiling](#ceiling), and the distributed stack over NATS in [Live limits](#live-limits) (latest: [After milestone 18](#after-milestone-18)); batched dispatch memory in [Batched dispatch memory](#batched-dispatch-memory); the observer's `clock.ticked` deviations in [Clock deviation](#clock-deviation).

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

## Ceiling

How far the in-process run goes past 50k. Measured 2026-10-04 at `e16f94a` (master after [#152](https://github.com/kludw/uber-simulator/pull/152)), [#154](https://github.com/kludw/uber-simulator/issues/154).

### Method

- Same command, scenario, and runner as [After milestone 12](#after-milestone-12): 2 driver shards, demand at the spec ratio, seed 1, 5-tick batch window, unprofiled (`-f cpu_profile=false`), 4 CPUs, 15,989 MiB, 1-minute load average 0.28-1.08 at start.
- 300 ticks, not 600, and **one run per case**. ADR 0036's band rule needs the slower of two runs, so no case here is judged "reliably met"; the 610 ms band is quoted for context only. Single runs varied by up to 32% in mean at 50k ([After milestone 12](#after-milestone-12)).
- Runs ([workflow](https://github.com/kludw/uber-simulator/actions/workflows/bench.yaml)):
  - Greedy, 100k / 200k / 500k: [37204837077](https://github.com/kludw/uber-simulator/actions/runs/37204837077).
  - Batched, 76k / 100k: [37204843377](https://github.com/kludw/uber-simulator/actions/runs/37204843377).

### Results

| Drivers | Matching | Requests/min | Mean ms/tick | p95 ms/tick | Messages | Peak RSS | Heap at end (objects) | Status |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 100,000 | greedy | 10,000 | 73.92 | 90.32 | 30,552,757 | 327.9 MiB | 104.5 MiB (1.77 M) | finished |
| 200,000 | greedy | 20,000 | 134.53 | 163.12 | 61,111,147 | 540.4 MiB | 156.8 MiB (2.51 M) | finished |
| 500,000 | greedy | 50,000 | 507.94 | 612.35 | 152,550,882 | 1,066.6 MiB | 458.2 MiB (8.13 M) | finished |
| 76,000 | batched | 7,600 | 278.56 | 1,290.43 | 23,219,136 | 2,271.9 MiB | 266.9 MiB (0.99 M) | finished |
| 100,000 | batched | 10,000 | 504.60 | 2,472.08 | 30,551,812 | 3,168.6 MiB | 451.3 MiB (1.29 M) | finished |

All single 300-tick runs. "finished" means all 300 ticks ran, not that the run kept real time (1,000 ms per tick).

- **Greedy keeps real time up to 500k** in these runs: p95 612.35 ms, under 1,000 ms (1.63× headroom) but 2.35 ms above the 610 ms band, so by ADR 0036's rule it would not count as reliably met even with a second run this close. Above 500k is not measured.
- **Batched misses at 76k**: p95 1,290.43 ms (mean 278.56 ms); its p95 falls on batch ticks, as at 50k. At 50k it met the target narrowly (p95 566.24-599.53 ms, 600 ticks, two runs). So the batched ceiling lies between 50k and 76k; nothing in between was run.
- **Greedy growth per driver.** Messages grow linearly (305.1-305.6 per driver over 300 ticks). Per-tick time does not: 100k → 200k (2× drivers) mean 1.82×, p95 1.81×; 200k → 500k (2.5×) mean 3.78×, p95 3.75×. Mean ms per tick per 1,000 drivers: 0.74, 0.67, 1.02. Three single runs on a shared runner can't fix an exponent; they show roughly linear cost to 200k and faster-than-linear growth between 200k and 500k, not attributed (no profile). Peak RSS grows about 2.2 KiB per extra driver from 100k to 200k and 1.8 KiB from 200k to 500k.
- Batched, 76k → 100k (1.32× drivers): mean 1.81×, p95 1.92×, peak RSS 1.39×. At 100k, batched peak RSS is 9.7× greedy's (3,168.6 vs 327.9 MiB); what sets it is not measured (see [Batched peak memory](#batched-peak-memory)).
- Not compared directly with the 50k rows: those are 600-tick runs, these 300.
- In process only: one Bun process, in-memory bus. The distributed stack over NATS (`bun run dev`) is not measured here; it is measured separately in [Live limits](#live-limits).

## Live limits

The distributed stack at real time (`bun run loadtest`, [ADR 0037](adr/0037-end-to-end-load-test.md)): every service its own process over NATS, the persister writing to ClickHouse via JetStream. Measured 2026-10-04 at `47d91a0` (master after [#160](https://github.com/kludw/uber-simulator/pull/160)), [#158](https://github.com/kludw/uber-simulator/issues/158). Current limits: [After milestone 18](#after-milestone-18).

### Method

- `loadtest` workflow ([workflow](https://github.com/kludw/uber-simulator/actions/workflows/loadtest.yaml), README [Load test](../README.md#load-test)), one `ubuntu-latest` job per case: 2 driver shards, demand at the spec ratio, seed 1, 5-tick batch window, `SPEED=1`, 600 ticks, drain bound 5 min. 4 CPUs, 15,988-15,993 MiB, 1-minute load average 0.29-1.61 at start.
- Runs, each case on its own runner:
  - [37207500717](https://github.com/kludw/uber-simulator/actions/runs/37207500717): greedy 1k / 5k / 10k / 20k (bracket).
  - [37208486357](https://github.com/kludw/uber-simulator/actions/runs/37208486357): greedy 10k / 11k / 12k / 15k.
  - [37209276002](https://github.com/kludw/uber-simulator/actions/runs/37209276002): greedy 11k / 12k / 13k / 14k.
  - [37210180314](https://github.com/kludw/uber-simulator/actions/runs/37210180314), [37210185179](https://github.com/kludw/uber-simulator/actions/runs/37210185179): batched 9k / 10k, twice.
- Judged per ADR 0037: the slower of two runs must pass every criterion. 13k-20k ran once each and fell behind in that run, so a second run couldn't make them pass.
- Pending slope: least-squares slope of the persister's pending count over the second half of its 5 s samples, in events per second. Computed from the reports' samples, not printed by them. Large and positive = the persister falls further behind every second.
- Peak RSS per service is in bytes, as the report assumes: on Linux (Docker, `oven/bun:1.4.2`) a child holding a 512 MiB buffer had `Subprocess.resourceUsage().maxRSS` 553,668,608 against its own `/proc/self/status` `VmHWM` of 538,084 kB (551.0 MB). In process, `process.resourceUsage().maxRSS` is in kilobytes (13,300 in the same parent), which `bun run bench` already converts.

### Results

| Drivers | Matching | Run | Settle ms mean / p95 / max | Overruns | Events per tick | Pending max | Pending slope /s | Trend (ADR 0037) | Drain | Slow consumers | Peak RSS per service, MiB |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | --- |
| 1,000 | greedy | [37207500717](https://github.com/kludw/uber-simulator/actions/runs/37207500717) | 21.7 / 28.9 / 51.3 | 0 | 1,011 | 740 | 0 | rising | 2.1 s | 0 | 66.5-98.3 |
| 5,000 | greedy | [37207500717](https://github.com/kludw/uber-simulator/actions/runs/37207500717) | 52.1 / 62.4 / 121.4 | 0 | 5,049 | 5,031 | 11 | rising | 2.1 s | 0 | 79.3-114.5 |
| 10,000 | greedy | [37207500717](https://github.com/kludw/uber-simulator/actions/runs/37207500717) | 183.3 / 217.3 / 348.8 | 0 | 10,098 | 9,971 | -7 | rising | 2.1 s | 0 | 86.3-113.9 |
| 10,000 | greedy | [37208486357](https://github.com/kludw/uber-simulator/actions/runs/37208486357) | 181.7 / 216.2 / 413.6 | 0 | 10,098 | 9,971 | -8 | rising | 2.2 s | 0 | 81.6-113.8 |
| 11,000 | greedy | [37208486357](https://github.com/kludw/uber-simulator/actions/runs/37208486357) | 125.6 / 148.9 / 278.6 | 0 | 11,108 | 10,881 | -7 | rising | 2.1 s | 0 | 85.5-114.8 |
| 11,000 | greedy | [37209276002](https://github.com/kludw/uber-simulator/actions/runs/37209276002) | 213.7 / 257.4 / 457.0 | 0 | 11,108 | 173,415 | 337 | rising | 16.2 s | 0 | 82.4-112.9 |
| 12,000 | greedy | [37208486357](https://github.com/kludw/uber-simulator/actions/runs/37208486357) | 160.8 / 191.0 / 317.2 | 0 | 12,118 | 11,233 | -4 | rising | 2.1 s | 0 | 83.2-116.0 |
| 12,000 | greedy | [37209276002](https://github.com/kludw/uber-simulator/actions/runs/37209276002) | 221.9 / 266.6 / 337.0 | 0 | 12,118 | 699,763 | 1,252 | rising | 56.4 s | 0 | 84.9-115.9 |
| 13,000 | greedy | [37209276002](https://github.com/kludw/uber-simulator/actions/runs/37209276002) | 235.5 / 272.5 / 397.1 | 0 | 13,129 | 1,303,973 | 2,260 | rising | 103.4 s | 0 | 79.5-112.0 |
| 14,000 | greedy | [37209276002](https://github.com/kludw/uber-simulator/actions/runs/37209276002) | 261.5 / 302.0 / 376.4 | 0 | 14,138 | 2,127,671 | 3,572 | rising | 170.5 s | 0 | 85.1-112.0 |
| 15,000 | greedy | [37208486357](https://github.com/kludw/uber-simulator/actions/runs/37208486357) | 156.4 / 184.1 / 252.6 | 0 | 15,148 | 1,359,668 | 2,301 | rising | 98.3 s | 0 | 90.3-114.4 |
| 20,000 | greedy | [37207500717](https://github.com/kludw/uber-simulator/actions/runs/37207500717) | 356.7 / 415.0 / 595.8 | 0 | 20,196 | 6,181,278 | 10,388 | rising | did not drain (2,323,486 left) | 0 | 84.6-124.3 |
| 9,000 | batched | [37210180314](https://github.com/kludw/uber-simulator/actions/runs/37210180314) | 107.1 / 134.0 / 229.1 | 0 | 9,088 | 9,017 | 2 | rising | 2.1 s | 0 | 80.9-111.0 |
| 9,000 | batched | [37210185179](https://github.com/kludw/uber-simulator/actions/runs/37210185179) | 166.7 / 207.1 / 262.7 | 0 | 9,088 | 8,960 | 32 | rising | 2.2 s | 0 | 82.7-112.9 |
| 10,000 | batched | [37210180314](https://github.com/kludw/uber-simulator/actions/runs/37210180314) | 184.3 / 237.9 / 308.2 | 0 | 10,098 | 9,293 | 36 | rising | 2.1 s | 0 | 81.1-111.6 |
| 10,000 | batched | [37210185179](https://github.com/kludw/uber-simulator/actions/runs/37210185179) | 154.7 / 196.9 / 247.2 | 0 | 10,098 | 2,789 | -2 | not rising | 2.2 s | 0 | 82.0-112.9 |

Every run finished 600 of 600 ticks and passed `ticks >= 600`, settle p95, overruns, and no slow consumers. `clock.ticked` max deviation 18.8-91.3 ms. A drain of 2.1-2.2 s means empty at the first check: the drain wait starts after the 2 s grace window, so it can't report less.

- **What fails first: the persister.** Settle p95 stays at or under 415 ms up to 20k with no overruns and no slow consumers, so the services keep real time across the whole range measured; host CPU never showed up as a failed criterion. The persister's backlog is the only criterion that separates sizes. In runs that fall behind, it grows linearly from the first sample (slope 337-10,388 events/s). In runs that keep up, it stays under one tick's events (max 740-11,233 against 1,011-12,118 events per tick) with a slope near zero (-8 to 36 events/s).
- **Persister throughput varies between runners.** Intake minus slope gives what the persister wrote while falling behind: 10.6-10.9k events/s in run 37209276002 (11k-14k), 12.8k at 15k in 37208486357, 9.8k at 20k in 37207500717. At 12k, run 37208486357 kept up (at least 12.1k events/s) and run 37209276002 did not (about 10.9k). After the last tick, with the other services stopped, backlogs drained at about 10.7-13.8k events/s (last sample over drain time). The persister fetches, inserts, and acks at most 1,000 events per round, one round at a time (`src/persister/persister.ts`), so 10.8k events/s is about 93 ms per round; which part of the round dominates is measured in [Persister timing](#persister-timing).
- **Greedy, live: 10k** (two runs, both keep up), judged with the backlog criterion proposed below in place of ADR 0037's trend. 11k and 12k each kept up in one run and fell behind in the other. 10k publishes 10.1k events/s, about 5% below the lowest in-run persister throughput seen (10.6k), so the margin is thin.
- **Batched, live: at least 10k** (9k and 10k, two runs each, all keep up), same criterion. Above 10k is not measured. Batched publishes the same event volume as greedy (10,098 per tick at 10k), and its settle p95 (134-238 ms) is in greedy's range.
- **Strictly by ADR 0037, no size passes**: the trend criterion fails in at least one of the two runs at every size, including 1k, where the persister needs about 1k events/s. Of all 16 runs, only one passed every criterion (10k batched, 37210185179).

### The pending-trend rule at T >= 600

Not stable. ADR 0037 compares the mean pending count of the second half of the samples with the first half. It read "rising" in 15 of 16 runs, including 9 of the 10 that kept up. There it is a step, not growth: in the greedy runs that kept up, pending is at or near 0 (at most 2,125) for the first 44-80 samples, then jumps to a plateau just under one tick's events and stays there (10k greedy: 0 until sample 55-60, then about 7,000-10,000 to the end; slopes -7 and -8 events/s). Three of the four batched runs show the same step. The two 10k greedy runs contain the same plateau sub-sequences (e.g. `8888 8387 8889 9434 9971`) at different sample positions. One possible explanation: the sampler waits 5 s after each sample's requests, so its phase drifts against the 1 s ticks, and pending at a given phase of the tick is set by that tick's seeded, identical events. Not verified: the report doesn't record sample times relative to `clock.ticked`.

The drain criterion can't replace it: at 13k-15k the persister fell behind by 2,260-2,301 events/s and still drained in 98-103 s, inside the 5 min bound.

Follow-up: [ADR 0038](adr/0038-persister-backlog-criterion.md) replaces the trend criterion with a backlog bound in ticks of events. The live limits above were judged with a 2-tick version on `num_pending` alone (max over the second half ≤ 2 × events per tick); that criterion passes every run with a slope of -8 to 36 events/s and fails every run with a slope of 337 or more. ADR 0038 adopts 3 ticks of `num_pending + num_ack_pending`, under which the same runs pass and fail.

### Against the in-process ceiling

[After milestone 12](#after-milestone-12) and [Ceiling](#ceiling) time the brains and the in-memory bus in one process (ms of work per tick); the load test times end-to-end settle over NATS and the persister's backlog. Different metrics, so only the limits compare. In process: greedy reliably keeps real time at 50k (two runs) and in single runs up to 500k; batched reliably at 50k, ceiling between 50k and 76k. Live: greedy 10k, batched at least 10k, both limited by the persister, not by settle; 5× below the in-process 50k.

ADR 0037 named ADR 0028's per-service subject subscriptions as the next step if the live limit landed well below the in-process one. These runs don't indicate it: it would cut the traffic each service decodes, but settle, the measure of services keeping up, passes up to 20k. The limit is the persister's write throughput, a single JetStream consumer that already receives only `sim.events.>`. Raising that is the indicated next step (its own ticket, likely an ADR; out of scope for #158).

### Persister timing

Where the persister's round time goes ([#165](https://github.com/kludw/uber-simulator/issues/165)). The persister logs `rounds_timed` every 10 s and on stop: rounds (fetches that returned messages), events persisted, and ms spent in each phase (`src/persister/persister.ts`). Fetch is from requesting a batch until the batch's last message arrives; decode is parsing plus `toRow`; insert is `insertEvents` including retries; ack is calling `ack()` on each message, which only queues the ack on the connection. Measured 2026-10-04 at `aad6fb4`, same method as above (greedy, 600 ticks, `ubuntu-latest`, 4 CPUs, 1-minute load average 0.47-1.64 at start). Totals over every entry of a run, from start to stop, so they include the drain.

- Runs: [37228170040](https://github.com/kludw/uber-simulator/actions/runs/37228170040), [37228177519](https://github.com/kludw/uber-simulator/actions/runs/37228177519), each 10k and 12k greedy.

| Drivers | Run | Backlog second-half max (limit) | Rounds | Events per round | ms per round | Fetch | Decode | Insert | Ack |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | [37228170040](https://github.com/kludw/uber-simulator/actions/runs/37228170040) | 10,940 (30,295), pass | 6,069 | 1,000 | 99.1 | 29.4% (29.1 ms) | 7.4% (7.3 ms) | 62.6% (62.1 ms) | 0.6% (0.6 ms) |
| 10,000 | [37228177519](https://github.com/kludw/uber-simulator/actions/runs/37228177519) | 10,387 (30,295), pass | 6,069 | 1,000 | 99.3 | 22.9% (22.7 ms) | 10.3% (10.2 ms) | 66.0% (65.5 ms) | 0.8% (0.8 ms) |
| 12,000 | [37228170040](https://github.com/kludw/uber-simulator/actions/runs/37228170040) | 683,763 (36,354), fail | 7,283 | 1,000 | 90.1 | 14.5% (13.1 ms) | 9.7% (8.7 ms) | 74.7% (67.3 ms) | 1.1% (1.0 ms) |
| 12,000 | [37228177519](https://github.com/kludw/uber-simulator/actions/runs/37228177519) | 13,068 (36,354), pass | 7,283 | 1,000 | 82.7 | 14.1% (11.7 ms) | 9.3% (7.7 ms) | 75.8% (62.7 ms) | 0.9% (0.7 ms) |

Shares are of the summed phases. Events per round is 999.9 in every run (rounded), and the phases sum to 99-100% of the logged intervals: the persister was in a full round almost all the time, also at 10k, where it kept up.

- **Insert dominates**: 62.6-75.8% of round time, 62-67 ms per 1,000-event round in all four runs. With fetch, decode, and ack at zero, insert alone would cap the persister at about 15-16k events/s.
- **Fetch is the second cost**: 11.7-13.1 ms per round at 12k, 22.7-29.1 ms at 10k. At 10k the persister kept up, so a fetch also waits for events to be published; at 12k, the run that fell behind still spent 13.1 ms per round fetching with hundreds of thousands of events pending. These numbers don't separate the wait for the server to deliver from the wait for the previous round's acks to free the 1,000 max ack pending.
- **Decode**: 7.7-10.2 ms per round, about 8-10 µs per event. **Ack**: under 1.1%, since `ack()` only queues.
- **12k, falling behind or not**: 90.1 ms per round is 11.1k events/s, below the 12.1k published; 82.7 ms is 12.1k, level with it. The two runs differ by 7.4 ms per round, 4.6 ms of it in insert.
- **Ack pending at 1,000**: every round fetched a full 1,000 messages, and the consumer allows 1,000 unacked, so during each round's decode and insert the whole batch is ack pending. That matches the report's ack pending max of 1,000 in all four runs. The 1k smoke run's ack pending climbing to about 958 is not explained by these runs (1k wasn't timed).

### After raising the batch size

The persister after [ADR 0039](adr/0039-persister-batch-size.md) (up to 10,000 events per round, max ack pending 10,000), [#166](https://github.com/kludw/uber-simulator/issues/166). Measured 2026-10-04 at `e122269`, same method as above (greedy, 600 ticks, `ubuntu-latest`, 4 CPUs, 1-minute load average 0.02-0.58 at end). Totals over every `rounds_timed` entry of a run.

- Runs: [37231337122](https://github.com/kludw/uber-simulator/actions/runs/37231337122), [37231342238](https://github.com/kludw/uber-simulator/actions/runs/37231342238), each 12k and 20k greedy.

| Drivers | Run | Settle p95 | Backlog second-half max (limit) | Rounds | Events per round | ms per round | Fetch | Decode | Insert | Ack |
| ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 12,000 | [37231337122](https://github.com/kludw/uber-simulator/actions/runs/37231337122) | 262.4 | 21,790 (36,354), pass | 730 | 9,977 | 825.6 | 80.9% (668.2 ms) | 11.5% (94.8 ms) | 6.5% (53.8 ms) | 1.1% (8.9 ms) |
| 12,000 | [37231342238](https://github.com/kludw/uber-simulator/actions/runs/37231342238) | 190.9 | 21,820 (36,354), pass | 730 | 9,977 | 825.4 | 82.9% (684.3 ms) | 9.6% (79.2 ms) | 6.7% (55.4 ms) | 0.8% (6.5 ms) |
| 20,000 | [37231337122](https://github.com/kludw/uber-simulator/actions/runs/37231337122) | 296.7 | 30,163 (60,587), pass | 1,214 | 9,998 | 495.7 | 64.7% (320.6 ms) | 16.2% (80.4 ms) | 17.8% (88.0 ms) | 1.4% (6.7 ms) |
| 20,000 | [37231342238](https://github.com/kludw/uber-simulator/actions/runs/37231342238) | 433.9 | 30,138 (60,587), pass | 1,214 | 9,998 | 496.6 | 62.2% (308.8 ms) | 21.8% (108.3 ms) | 14.3% (70.9 ms) | 1.7% (8.5 ms) |

All four runs pass every criterion (ADR 0037 with ADR 0038's backlog bound): 0 overruns, 0 slow consumers, drain 2.0-2.2 s (empty at the first check), no failed inserts. **Greedy, live: at least 20k** (two runs), the milestone 14 target; above 20k is not measured here (next ticket).

- **Insert is no longer the cost**: 54-88 ms per 10,000-event insert, against 62-67 ms per 1,000 before, about 8-12x less per event.
- **The persister now waits for events**: ms per round is events per round over the publish rate (10,000 / 12.1k = 825 ms, 10,000 / 20.2k = 495 ms), and fetch, which includes waiting for a full batch, takes 62-83% of it. Without fetch, decode + insert + ack is 142-188 ms per 10,000 events, about 53-70k events/s; how much of fetch is delivery rather than waiting isn't separated, so that is an upper bound on headroom, not a measured limit.
- **Decode is now the largest busy phase at 20k** (80-108 ms, 8-11 µs per event, unchanged per event).
- **Backlog**: ack pending max 10,000 in every run (one full round in flight). The second-half max is 1.8 ticks of events at 12k and 1.5 at 20k, inside the 3-tick bound; why it is higher in ticks at 12k (where a batch takes 825 ms to fill) is not separated by these samples.

## After milestone 14

Live limits with the faster persister ([ADR 0039](adr/0039-persister-batch-size.md)), judged by ADR 0037 with [ADR 0038](adr/0038-persister-backlog-criterion.md)'s backlog bound, [#167](https://github.com/kludw/uber-simulator/issues/167). Measured 2026-10-04 at `7df31d5` (master after [#170](https://github.com/kludw/uber-simulator/pull/170)).

### Method

- Same as [Live limits](#live-limits): `loadtest` workflow, one `ubuntu-latest` job per case, 2 driver shards, demand at the spec ratio, seed 1, 5-tick batch window, 600 ticks, drain bound 5 min. 4 CPUs, 15,988-15,989 MiB, 1-minute load average 0.25-2.11 at start.
- Greedy bracketed upward from 20k (20k passed twice in [After raising the batch size](#after-raising-the-batch-size)), then bisected; batched at the largest greedy-passing size (25k) and one step below (20k). Two runs per size.
- Runs, each case on its own runner:
  - [37232329038](https://github.com/kludw/uber-simulator/actions/runs/37232329038), [37232338451](https://github.com/kludw/uber-simulator/actions/runs/37232338451): greedy 20k / 30k / 40k / 50k.
  - [37233409769](https://github.com/kludw/uber-simulator/actions/runs/37233409769), [37233411419](https://github.com/kludw/uber-simulator/actions/runs/37233411419): greedy 25k.
  - [37234185770](https://github.com/kludw/uber-simulator/actions/runs/37234185770), [37234187405](https://github.com/kludw/uber-simulator/actions/runs/37234187405): greedy 27.5k.
  - [37233432135](https://github.com/kludw/uber-simulator/actions/runs/37233432135), [37233434289](https://github.com/kludw/uber-simulator/actions/runs/37233434289): batched 20k.
  - [37234189292](https://github.com/kludw/uber-simulator/actions/runs/37234189292), [37234190970](https://github.com/kludw/uber-simulator/actions/runs/37234190970): batched 25k.
- Persister ms per round and decode ms per round: totals of the persister's `rounds_timed` entries (services log), start to stop, so they include the drain. Every round fetched 9,994-10,000 events.

### Results

| Drivers | Matching | Run | Settle ms mean / p95 / max | Overruns | Events per tick | Backlog second-half max (limit) | Drain | Slow consumers | Persister ms per round (decode) | Failed |
| ---: | --- | --- | --- | ---: | ---: | --- | --- | ---: | --- | --- |
| 20,000 | greedy | [37232329038](https://github.com/kludw/uber-simulator/actions/runs/37232329038) | 376.8 / 439.6 / 584.8 | 0 | 20,196 | 30,142 (60,587) | 2.4 s | 0 | 496.6 (109.3) | none |
| 20,000 | greedy | [37232338451](https://github.com/kludw/uber-simulator/actions/runs/37232338451) | 245.8 / 283.1 / 490.8 | 0 | 20,196 | 30,163 (60,587) | 2.1 s | 0 | 495.7 (79.6) | none |
| 25,000 | greedy | [37233409769](https://github.com/kludw/uber-simulator/actions/runs/37233409769) | 244.3 / 289.8 / 487.3 | 0 | 25,243 | 34,749 (75,728) | 2.2 s | 0 | 397.0 (66.5) | none |
| 25,000 | greedy | [37233411419](https://github.com/kludw/uber-simulator/actions/runs/37233411419) | 426.1 / 516.2 / 644.0 | 0 | 25,243 | 35,170 (75,728) | 2.3 s | 0 | 397.2 (104.3) | none |
| 27,500 | greedy | [37234185770](https://github.com/kludw/uber-simulator/actions/runs/37234185770) | 555.4 / 681.8 / 901.5 | 0 | 27,766 | 60,028 (83,299) | 2.4 s | 0 | 361.3 (115.8) | settle |
| 27,500 | greedy | [37234187405](https://github.com/kludw/uber-simulator/actions/runs/37234187405) | 513.4 / 616.5 / 759.1 | 0 | 27,766 | 40,604 (83,299) | 2.1 s | 0 | 361.3 (111.0) | settle |
| 30,000 | greedy | [37232329038](https://github.com/kludw/uber-simulator/actions/runs/37232329038) | 307.6 / 364.2 / 471.7 | 0 | 30,290 | 38,711 (90,871) | 2.3 s | 0 | 330.5 (70.9) | none |
| 30,000 | greedy | [37232338451](https://github.com/kludw/uber-simulator/actions/runs/37232338451) | 601.9 / 730.1 / 890.7 | 0 | 30,290 | 1,123,799 (90,871) | 24.3 s | 0 | 343.1 (108.8) | settle, backlog |
| 40,000 | greedy | [37232329038](https://github.com/kludw/uber-simulator/actions/runs/37232329038) | 691.5 / 820.1 / 1,628.0 | 3 (0.5%) | 40,384 | 8,298,805 (121,153) | 164.5 s | 0 | 314.8 (98.0) | settle, backlog |
| 40,000 | greedy | [37232338451](https://github.com/kludw/uber-simulator/actions/runs/37232338451) | 439.3 / 545.1 / 810.2 | 0 | 40,384 | 190,231 (121,153) | 5.4 s | 0 | 249.4 (72.3) | backlog |
| 50,000 | greedy | [37232329038](https://github.com/kludw/uber-simulator/actions/runs/37232329038) | - | - | - | - | - | - | 690.0 (245.8) | stack failed: persister exited |
| 50,000 | greedy | [37232338451](https://github.com/kludw/uber-simulator/actions/runs/37232338451) | 1,035.0 / 1,687.8 / 2,406.1 | 172 (28.7%) | 50,471 | 21,261,915 (151,413) | did not drain (5,782,570 left) | 0 | 367.2 (124.1) | settle, overruns, backlog, drain |
| 20,000 | batched | [37233432135](https://github.com/kludw/uber-simulator/actions/runs/37233432135) | 387.3 / 547.3 / 1,455.2 | 1 (0.2%) | 20,196 | 29,806 (60,587) | 2.4 s | 0 | 496.7 (112.6) | none |
| 20,000 | batched | [37233434289](https://github.com/kludw/uber-simulator/actions/runs/37233434289) | 224.1 / 306.9 / 441.0 | 0 | 20,196 | 29,884 (60,587) | 2.2 s | 0 | 495.6 (73.6) | none |
| 25,000 | batched | [37234189292](https://github.com/kludw/uber-simulator/actions/runs/37234189292) | 501.3 / 707.8 / 1,474.2 | 13 (2.2%) | 25,242 | 37,135 (75,727) | 2.1 s | 0 | 397.3 (111.9) | settle, overruns |
| 25,000 | batched | [37234190970](https://github.com/kludw/uber-simulator/actions/runs/37234190970) | 490.8 / 699.3 / 1,609.5 | 12 (2.0%) | 25,242 | 37,199 (75,727) | 2.1 s | 0 | 397.3 (109.5) | settle, overruns |

Every run that printed a report finished 600 of 600 ticks with 0 slow consumers. Peak RSS per service 83.8-226.0 MiB, except batched dispatch: 193-211 MiB at 20k, 277-293 MiB at 25k.

- **Greedy, live: 25k** (two runs, both pass every criterion). 27.5k fails settle in both runs (p95 616.5 and 681.8 ms); 30k passes in one run and fails in the other, so it isn't supported either. The milestone 14 target (20k) is met: four of four runs pass, counting the two in [After raising the batch size](#after-raising-the-batch-size).
- **Batched, live: 20k** (two runs pass). 25k fails settle (p95 699-708 ms) and overruns (2.0-2.2% of ticks) in both runs, with the persister keeping up.
- **What fails first now: settle.** At the first failing size (greedy 27.5k, batched 25k) only settle, and for batched overruns, fail; the backlog stays within its bound (at most 2.2 ticks of events). The persister fails next: from 30k up it falls behind in 4 of 5 reported runs, writing about 27-40k events/s (events per round over ms per round, averaged over the run including the drain: 29.1k at 30k, 31.8k and 40.1k at 40k, 27.2k at 50k). Overruns follow at 50k (28.7%). Slow consumers: 0 in every run.
- **Runner speed decides near the limit.** Runs fall into two groups by the persister's decode time per 10,000-event round, the same work in every run: 66-80 ms or 98-124 ms. Settle p95 tracks it at every size with a run in each group: 20k 283 vs 440 ms, 25k 290 vs 516 ms, 30k 364 vs 730 ms, 40k 545 vs 820 ms (fast vs slow group); batched 20k 307 vs 547 ms. Both 27.5k runs and both batched 25k runs landed in the slow group, so on two fast runners 27.5k might pass; 30k passed on a fast one. The slow group points at less CPU per unit of work on the whole runner: a slower host or contention from outside the stack. Which one isn't separated: the runner note records CPU count and memory, not CPU model or steal time, and the report has no CPU time per service. The 1-minute load average at start (0.25-2.11) doesn't separate the groups.
- **50k, run 37232329038: the stack failed.** The persister's fetch failed with JetStream `heartbeats missed` and the persister exited, which stopped the run (about tick 343, the last tick in the services log; 660 rounds persisted, far behind). From tick 272 on, dispatch also logged 1,463 `input_rejected` (1,416 `invalid_transition`, 47 `wrong_driver`, all `driver.arrived_at_pickup`); no other run logged any. Not investigated here: 50k fails in the other run on every criterion except slow consumers. Cause (#173): each was a stale arrival by a driver whose offer had expired at dispatch before its accept arrived (the trip queued again: `invalid_transition` from `requested`; or re-matched: `wrong_driver`); dispatch now ignores arrivals from drivers excluded for the trip, as it does their late replies.

### Against milestone 13

| | Milestone 13 ([Live limits](#live-limits)) | Milestone 14 (this section) |
| --- | --- | --- |
| Greedy, live | 10k | 25k |
| Batched, live | at least 10k (above not measured) | 20k |
| Fails first | persister backlog (settle p95 at most 415 ms up to 20k) | settle (greedy 27.5k, batched 25k) |
| Persister write rate while falling behind | 9.8-12.8k events/s | 27-40k events/s |
| Settle p95 at 20k greedy | 415.0 ms (one run, persister falling behind) | 283.1-439.6 ms (four runs, persister keeping up) |

Against the in-process run ([After milestone 12](#after-milestone-12)): greedy reliably keeps real time at 50k there, so the live limit is now 2× below it, down from 5×. Settle is end-to-end over NATS across six processes on 4 CPUs, so this gap can't be attributed without CPU time per service.

Next (proposal, no ADR): settle and the persister now fail one step apart (27.5k and 30k), both sensitive to runner speed. Recording CPU time per service in the load test report and CPU model in the runner note would show which service sets settle and whether the 4 CPUs are saturated; if the services' NATS decode dominates, ADR 0028's per-service subject subscriptions are the candidate fix named in [Against the in-process ceiling](#against-the-in-process-ceiling).

## CPU time per service

Which service's CPU settles the live limit, [#177](https://github.com/kludw/uber-simulator/issues/177). The load test report now gives each service's user + system CPU seconds (`resourceUsage().cpuTime`, microseconds, checked on Linux in `oven/bun:1.4.2`: a 2 s busy loop reads 2,001,611 µs user) with their share of the service's wall time (spawn to exit), and the host's CPU model. Measured 2026-10-04 on branch `177-loadtest-cpu` (master `96de468` plus the report change).

### Method

- `loadtest` workflow as in [After milestone 14](#after-milestone-14): greedy, 2 driver shards, 600 ticks, drain bound 5 min, one `ubuntu-latest` runner (4 CPUs, 15,989 MiB) per case.
- Runs [37241329813](https://github.com/kludw/uber-simulator/actions/runs/37241329813) and [37241331711](https://github.com/kludw/uber-simulator/actions/runs/37241331711), each greedy 25k and 27.5k.
- CPU per tick and per event: a service's CPU over 600 ticks or over the run's events of ticks 1..600; both include startup and, for the persister, the drain (2-3 s).
- The clock's brain publishes one message per tick, but its bus subscribes to `sim.>` like every service (ADR 0028), so its CPU is close to the cost of receiving and decoding all traffic alone.

### Results

CPU seconds, user + system (share of the service's wall time):

| Drivers | Run | CPU model | Settle p95 ms | Persister | Dispatch | Riders | Shard 0 | Shard 1 | Clock | Total (µs per event) |
| ---: | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |
| 25,000 | [37241329813](https://github.com/kludw/uber-simulator/actions/runs/37241329813) | AMD EPYC 7763 | 551.6 | 291.8 (48%) | 123.5 (20%) | 104.9 (17%) | 128.0 (21%) | 126.0 (21%) | 99.9 (17%) | 874.1 (57.7) |
| 25,000 | [37241331711](https://github.com/kludw/uber-simulator/actions/runs/37241331711) | AMD EPYC 7763 | 557.0 | 296.5 (49%) | 126.3 (21%) | 105.9 (18%) | 130.1 (22%) | 129.1 (21%) | 100.5 (17%) | 888.4 (58.7) |
| 27,500 | [37241329813](https://github.com/kludw/uber-simulator/actions/runs/37241329813) | AMD EPYC 9V74 | 432.0 | 267.2 (44%) | 106.1 (18%) | 88.1 (15%) | 108.5 (18%) | 107.1 (18%) | 83.3 (14%) | 760.3 (45.6) |
| 27,500 | [37241331711](https://github.com/kludw/uber-simulator/actions/runs/37241331711) | AMD EPYC 9V74 | 420.0 | 264.0 (44%) | 105.4 (17%) | 85.6 (14%) | 106.4 (18%) | 104.8 (17%) | 81.2 (14%) | 747.4 (44.9) |

All four runs pass every criterion: 600 of 600 ticks, 0 overruns, 0 slow consumers, backlog within its bound, drain 2.0-3.1 s.

- **No core is saturated on average.** The stack uses 1.25-1.48 of 4 cores (total CPU over 600 s); the busiest service, the persister, 44-49% of one. Every other service: 14-22%. These are run averages: they don't show per-tick bursts, and NATS server and the observer aren't counted.
- **Receiving and decoding all `sim.>` traffic is most of each service's CPU.** The clock, which does little else, uses 81-100 s (135-168 ms per tick, 4.9-6.6 µs per event). That is 76-81% of dispatch's and each shard's CPU and 95% of the riders'. Five services each pay it: 5× the clock's CPU is 84-86% of all non-persister CPU and 54-57% of the stack's. Brain work (dispatch, shards over the clock) is 23-30 s per service per run.
- **Which service sets settle: not shown.** Dispatch and the shards each spend 175-217 ms CPU per tick, of which about 135-168 ms is the decode floor; settle p95 (420-557 ms) can span several hops (clock -> shards -> dispatch -> shards), each queued behind its service's decode of the tick's traffic. CPU totals can't tell which hop is longest.
- **The CPU model splits the runners.** Both 25k runs landed on EPYC 7763 and both 27.5k runs on EPYC 9V74, so fleet size and CPU model are confounded here: the 9V74 runs used 21-24% less CPU per event (45-46 vs 58-59 µs) and settled faster at the larger fleet (p95 420-432 vs 552-557 ms), but that alone doesn't separate the model's effect from the fleet's. What carries the attribution to the CPU model is the persister's decode per 10,000-event round, the same work at any fleet size: 109 ms on the 7763 (the slow group in [After milestone 14](#after-milestone-14)), 85-87 ms on the 9V74. So the two 27.5k passes here, after two fails in [After milestone 14](#after-milestone-14), don't change the live limit (greedy 25k): 27.5k passes on the faster CPU.

Next (proposal, no ADR): the decode floor is paid once per service, five times over, and is most of each service's CPU, so ADR 0028's per-service subject subscriptions (each service receives only what its brain consumes; the clock nothing) is the candidate to raise settle's limit. It needs an ADR superseding 0028's `sim.>` subscription. Before that, a per-tick timing of decode vs brain in dispatch and the shards (like the persister's `rounds_timed`) would show whether decode sits on settle's critical path, which these totals can't.

## Service timing

Where each service's time on the bus goes, and which publisher closes each tick, [#189](https://github.com/kludw/uber-simulator/issues/189) (milestone 16). Each service's NATS bus logs `messages_timed` every 10 s and on close (`src/bus/nats.ts`): messages received on `sim.>`, messages delivered to at least one subscriber, ms decoding (JSON parse + Zod) and ms in subscribers (predicates, brain, and the brain's publishes). Both are wall time (`performance.now()`), so they include time the process waited for a CPU. The load test report gives, per event subject, the share of observed ticks whose last event (the one that sets that tick's settle) had it. Measured 2026-10-05 on branch `189-service-timing` (master `46d4b2b` plus this change).

### Method

- `loadtest` workflow as in [CPU time per service](#cpu-time-per-service): greedy, 2 driver shards, 600 ticks, drain bound 5 min, one `ubuntu-latest` runner (4 CPUs) per case.
- Runs [37334746999](https://github.com/kludw/uber-simulator/actions/runs/37334746999) and [37334762772](https://github.com/kludw/uber-simulator/actions/runs/37334762772), each greedy 25k and 27.5k.
- ms per tick: the sum over every `messages_timed` entry of a service (601-604 s, start to stop) over 600 ticks, so startup and stop are included. Run averages: per-tick bursts aren't shown.

### Results

Decode / handle ms per tick (share of received messages delivered to a subscriber):

| Drivers | Run | CPU model | Settle p95 ms | Dispatch | Shard 0 | Shard 1 | Riders | Clock |
| ---: | --- | --- | ---: | --- | --- | --- | --- | --- |
| 25,000 | [37334746999](https://github.com/kludw/uber-simulator/actions/runs/37334746999) | Intel Xeon Platinum 8573C | 382.1 | 151 / 44 (98.9%) | 131 / 98 (0.3%) | 131 / 98 (0.3%) | 175 / 5 (0.2%) | 178 / 3 (0.0%) |
| 25,000 | [37334762772](https://github.com/kludw/uber-simulator/actions/runs/37334762772) | AMD EPYC 9V74 | 528.2 | 207 / 65 (98.9%) | 185 / 138 (0.3%) | 188 / 137 (0.3%) | 251 / 7 (0.2%) | 255 / 4 (0.0%) |
| 27,500 | [37334746999](https://github.com/kludw/uber-simulator/actions/runs/37334746999) | AMD EPYC 7763 | 645.3 | 248 / 79 (98.9%) | 222 / 166 (0.3%) | 222 / 163 (0.3%) | 302 / 8 (0.2%) | 305 / 5 (0.0%) |
| 27,500 | [37334762772](https://github.com/kludw/uber-simulator/actions/runs/37334762772) | AMD EPYC 7763 | 595.0 | 242 / 69 (98.9%) | 211 / 153 (0.3%) | 216 / 150 (0.3%) | 289 / 7 (0.2%) | 288 / 4 (0.0%) |

Messages received per service: 15.25-15.27M at 25k, 16.77-16.80M at 27.5k, every service within 0.2% of the others (the clock, spawned last, about 25k fewer: it misses the shards' start-up `driver.went_online`). Settle passed in three cases and failed in one (27.5k on run 37334746999, p95 645.3 ms); every other criterion passed in all four, 0 overruns. Three CPU models in four cases, and fleet size differs with them, so rows compare across models only with that caveat.

- **Every service decodes all `sim.>` traffic; only dispatch uses most of it.** Dispatch delivers 98.9% of what it receives, the shards 0.3%, the riders 0.2%, the clock none (it subscribes to nothing).
- **Decode vs handle**: decode is 97-99% of the riders' and the clock's timed ms, 76-78% of dispatch's, 57-59% of each shard's. The shards' handle (98-166 ms per tick) is the largest handle cost: on 0.3% of their messages, it includes moving every driver and publishing their `driver.moved` each tick.
- **Decode per message by CPU model**: 5.1-7.0 µs on the Xeon 8573C, 7.3-10.0 µs on the EPYC 9V74, 7.5-10.9 µs on the EPYC 7763 (range over services within a run). Within each run, the riders and the clock decode slowest per message, the shards fastest.
- **No service is busy on average**: decode + handle is 18-23% of the logged interval per service on the Xeon, 26-32% on the 9V74, 29-39% on the 7763. Timed ms exceed CPU time: the clock's decode + handle is 109-186 s per run against 76-114 s CPU (report), 1.4-1.6x.
- **Which publisher closes ticks**: `trip.matched` is the last event of 99.8% of observed ticks in all four cases, `driver.moved` of 0.2%. Only dispatch publishes `trip.*`.

Next (proposal, no ADR, #190): these numbers locate the tick's last event at dispatch's `trip.matched`, which follows the shards' offer replies, and show dispatch and the shards each decoding the whole tick's traffic. Whether cutting decode shortens settle is the change ticket's measurement.

## Subscriptions per service

The change [Service timing](#service-timing) pointed to, [#190](https://github.com/kludw/uber-simulator/issues/190), [ADR 0042](adr/0042-subscribe-to-taken-types.md): each service's NATS bus subscribes only to the message types its brain takes (the clock to none), instead of one `sim.>` subscription each. Messages, subjects, and in-process runs are unchanged. Measured 2026-10-05 on branch `190-cut-service-work` at `a75a25b` (master `541b69c` plus this change).

### Method

- `loadtest` workflow as in [Service timing](#service-timing): greedy, 2 driver shards, 600 ticks, drain bound 5 min, one `ubuntu-latest` runner (4 CPUs) per case.
- Runs [37338720013](https://github.com/kludw/uber-simulator/actions/runs/37338720013) and [37338746533](https://github.com/kludw/uber-simulator/actions/runs/37338746533), each greedy 27.5k and 30k.
- Decode / handle ms per tick as in [Service timing](#service-timing). `received` now counts only subscribed messages.
- Before choosing, locally (M1 Pro, 10 cores, 27.5k greedy, 120 ticks, same NATS and ClickHouse): JSON.parse plus Zod of one `driver.moved` costs ~0.45 µs in a tight loop (0.22 + 0.22), against 5-11 µs per message timed on CI, so CI's decode was mostly waiting for a CPU. Master vs this change: settle p95 242.9 -> 108.7 ms; CPU s clock 10.3 -> 0.4, riders 10.6 -> 0.9, each shard 12.8-13.2 -> 3.9, dispatch 12.8 -> 10.5.

### Results

| Drivers | Run | CPU model | Settle p95 ms | Dispatch | Shard 0 | Shard 1 | Riders | CPU s dispatch / each shard / riders / clock |
| ---: | --- | --- | ---: | --- | --- | --- | --- | --- |
| 27,500 | [37338720013](https://github.com/kludw/uber-simulator/actions/runs/37338720013) | AMD EPYC 9V74 | 313.1 | 117 / 42 | 1 / 84 | 1 / 83 | 1 / 2 | 114.9 / 36.3-37.6 / 4.1 / 1.3 |
| 27,500 | [37338746533](https://github.com/kludw/uber-simulator/actions/runs/37338746533) | AMD EPYC 7763 | 321.8 | 125 / 41 | 1 / 91 | 1 / 92 | 2 / 2 | 121.8 / 37.1-37.9 / 4.1 / 1.2 |
| 30,000 | [37338720013](https://github.com/kludw/uber-simulator/actions/runs/37338720013) | AMD EPYC 9V45 | 197.7 | 78 / 30 | 1 / 56 | 1 / 56 | 1 / 1 | 81.1 / 29.6-29.8 / 3.6 / 1.1 |
| 30,000 | [37338746533](https://github.com/kludw/uber-simulator/actions/runs/37338746533) | AMD EPYC 7763 | 381.0 | 143 / 51 | 2 / 105 | 2 / 101 | 2 / 2 | 134.8 / 40.8-41.9 / 4.4 / 1.2 |

All four cases pass every criterion: 600 of 600 ticks, 0 overruns, 0 slow consumers, persister backlog second-half max 17-40k (limit 83-91k), drain 2.0-2.3 s. Messages received per 600-tick run: dispatch 16.62M at 27.5k and 18.13M at 30k, each shard 67-73k, riders 40-43k, the clock none.

- **Settle**: 27.5k p95 313.1-321.8 ms, against 595.0-645.3 ms in [Service timing](#service-timing) (both EPYC 7763, one failing) and 420.0-432.0 ms in [CPU time per service](#cpu-time-per-service) (both EPYC 9V74). 30k keeps up in both runs (197.7-381.0 ms). Greedy's live limit is now at least 30k.
- **Work cut where unused**: the clock's CPU fell from 76-114 s per run to 1.1-1.3 s, the riders' from 86-106 s to 3.6-4.4 s, each shard's from 105-130 s to 30-42 s.
- **Dispatch decodes faster without the contention**: 4.2-4.7 µs per message on the 9V74 and 7763 (7.3-10.9 µs before), 2.6 µs on the 9V45; 117-143 ms per tick at 27.5-30k, against 242-248 ms at 27.5k on the 7763 before. Decode is still 72-75% of dispatch's timed ms, and `trip.matched` still closes 99.7-99.8% of ticks: dispatch, receiving ~N `driver.moved` per tick, is what remains on settle's path.

Next (proposal, no ADR): dispatch's own per-message cost is the next limit, alongside the persister (41-58% of a core here). Fewer, larger messages (one positions message per shard per tick) would cut it, at the cost of an event shape change for every consumer (ADR 0042's alternatives).

## After milestone 16

Live limits after [ADR 0042](adr/0042-subscribe-to-taken-types.md)'s per-service subscriptions, judged by ADR 0037 with [ADR 0038](adr/0038-persister-backlog-criterion.md)'s backlog bound, [#191](https://github.com/kludw/uber-simulator/issues/191). Measured 2026-10-05 at `22a1029` (master after [#193](https://github.com/kludw/uber-simulator/pull/193)).

### Method

- Same as [After milestone 14](#after-milestone-14): `loadtest` workflow, one `ubuntu-latest` job per case, 2 driver shards, demand at the spec ratio, seed 1, 5-tick batch window, 600 ticks, drain bound 5 min. 4 CPUs, 15,989-15,993 MiB, 1-minute load average 0.30-1.81 at start. CPU model per run from the report's `host` line.
- Greedy bracketed upward from 25k at 30k / 35k / 40k / 50k, then 32.5k and 45k. 35k and 40k ran four times each, since their first runs split by CPU model. Batched at the largest greedy-passing size (32.5k), one step below (30k), and 27.5k. Two runs per size otherwise.
- Every case is its own workflow run:
  - Greedy 30k: [37342300444](https://github.com/kludw/uber-simulator/actions/runs/37342300444), [37342478784](https://github.com/kludw/uber-simulator/actions/runs/37342478784).
  - Greedy 32.5k: [37345911132](https://github.com/kludw/uber-simulator/actions/runs/37345911132), [37345947642](https://github.com/kludw/uber-simulator/actions/runs/37345947642).
  - Greedy 35k: [37342309509](https://github.com/kludw/uber-simulator/actions/runs/37342309509), [37342488300](https://github.com/kludw/uber-simulator/actions/runs/37342488300), [37344034284](https://github.com/kludw/uber-simulator/actions/runs/37344034284), [37344065652](https://github.com/kludw/uber-simulator/actions/runs/37344065652).
  - Greedy 40k: [37342317815](https://github.com/kludw/uber-simulator/actions/runs/37342317815), [37342498844](https://github.com/kludw/uber-simulator/actions/runs/37342498844), [37344044949](https://github.com/kludw/uber-simulator/actions/runs/37344044949), [37344075889](https://github.com/kludw/uber-simulator/actions/runs/37344075889).
  - Greedy 45k: [37344055305](https://github.com/kludw/uber-simulator/actions/runs/37344055305), [37344085772](https://github.com/kludw/uber-simulator/actions/runs/37344085772). Greedy 50k: [37342326038](https://github.com/kludw/uber-simulator/actions/runs/37342326038) (one run: it fails two criteria, and 45k already fails).
  - Batched 27.5k: [37345935290](https://github.com/kludw/uber-simulator/actions/runs/37345935290), [37345970001](https://github.com/kludw/uber-simulator/actions/runs/37345970001). Batched 30k: [37345923121](https://github.com/kludw/uber-simulator/actions/runs/37345923121), [37345958731](https://github.com/kludw/uber-simulator/actions/runs/37345958731). Batched 32.5k: [37347458247](https://github.com/kludw/uber-simulator/actions/runs/37347458247), [37347474168](https://github.com/kludw/uber-simulator/actions/runs/37347474168).
- Backlog slope: least-squares slope of the backlog over the second half of its 5 s samples, events per second, as in [Live limits](#live-limits). Dispatch decode / handle: ms per tick from its `messages_timed` entries, as in [Service timing](#service-timing). Persister write rate and round phases: from its `rounds_timed` entries in log order. "During the run": the entries up to and including the first one at which their summed `intervalMs` reaches 600 s (600-609 s in these runs, counted from the persister's start, so a few seconds before tick 1 are included). "Drain": every later entry. The boundary is approximate: the boundary entry may cover a few seconds after the last tick, and the first drain entry a few seconds before the other services stop.

### Results

| Drivers | Matching | Run | CPU model | Settle ms mean / p95 / max | Overruns | Events per tick | Backlog second-half max (limit) | Backlog slope /s | Drain | Dispatch decode / handle ms per tick | CPU s persister / dispatch | Failed |
| ---: | --- | --- | --- | --- | ---: | ---: | --- | ---: | --- | --- | --- | --- |
| 30,000 | greedy | [37342300444](https://github.com/kludw/uber-simulator/actions/runs/37342300444) | EPYC 9V74 | 251.8 / 341.3 / 409.5 | 0 | 30,290 | 38,794 (90,871) | 7 | 2.4 s | 127 / 46 | 330.6 / 121.3 | none |
| 30,000 | greedy | [37342478784](https://github.com/kludw/uber-simulator/actions/runs/37342478784) | EPYC 7763 | 259.9 / 339.6 / 498.4 | 0 | 30,290 | 39,810 (90,871) | 89 | 2.0 s | 136 / 43 | 321.1 / 125.6 | none |
| 32,500 | greedy | [37345911132](https://github.com/kludw/uber-simulator/actions/runs/37345911132) | EPYC 9V74 | 285.5 / 385.8 / 513.4 | 0 | 32,814 | 41,822 (98,441) | -25 | 2.0 s | 143 / 56 | 377.9 / 135.8 | none |
| 32,500 | greedy | [37345947642](https://github.com/kludw/uber-simulator/actions/runs/37345947642) | EPYC 7763 | 302.1 / 409.7 / 578.6 | 0 | 32,814 | 45,957 (98,441) | 88 | 3.0 s | 157 / 52 | 361.1 / 141.0 | none |
| 35,000 | greedy | [37342309509](https://github.com/kludw/uber-simulator/actions/runs/37342309509) | EPYC 7763 | 352.8 / 479.8 / 644.3 | 0 | 35,336 | 150,433 (106,009) | 168 | 5.5 s | 177 / 70 | 398.6 / 154.9 | backlog |
| 35,000 | greedy | [37342488300](https://github.com/kludw/uber-simulator/actions/runs/37342488300) | EPYC 7763 | 328.0 / 442.6 / 591.8 | 0 | 35,336 | 120,433 (106,009) | 92 | 3.0 s | 167 / 62 | 375.1 / 147.7 | backlog |
| 35,000 | greedy | [37344034284](https://github.com/kludw/uber-simulator/actions/runs/37344034284) | EPYC 7763 | 350.9 / 482.6 / 617.2 | 0 | 35,336 | 140,433 (106,009) | 143 | 4.4 s | 172 / 72 | 397.6 / 156.1 | backlog |
| 35,000 | greedy | [37344065652](https://github.com/kludw/uber-simulator/actions/runs/37344065652) | EPYC 7763 | 342.5 / 449.0 / 571.4 | 0 | 35,336 | 130,433 (106,009) | 115 | 4.1 s | 174 / 65 | 386.7 / 153.0 | backlog |
| 40,000 | greedy | [37342317815](https://github.com/kludw/uber-simulator/actions/runs/37342317815) | EPYC 9V45 | 212.1 / 296.2 / 451.4 | 0 | 40,384 | 50,396 (121,153) | 139 | 2.0 s | 104 / 47 | 320.0 / 107.1 | none |
| 40,000 | greedy | [37342498844](https://github.com/kludw/uber-simulator/actions/runs/37342498844) | EPYC 9V74 | 290.5 / 383.8 / 537.9 | 0 | 40,384 | 61,733 (121,153) | -38 | 3.0 s | 139 / 68 | 390.0 / 136.8 | none |
| 40,000 | greedy | [37344044949](https://github.com/kludw/uber-simulator/actions/runs/37344044949) | EPYC 7763 | 402.4 / 540.2 / 672.8 | 0 | 40,384 | 3,980,231 (121,153) | 7,083 | 83.3 s | 199 / 88 | 457.6 / 177.3 | backlog |
| 40,000 | greedy | [37344075889](https://github.com/kludw/uber-simulator/actions/runs/37344075889) | EPYC 9V74 | 391.7 / 524.7 / 744.9 | 0 | 40,384 | 1,870,231 (121,153) | 3,368 | 39.1 s | 187 / 86 | 454.7 / 164.6 | backlog |
| 45,000 | greedy | [37344055305](https://github.com/kludw/uber-simulator/actions/runs/37344055305) | EPYC 7763 | 440.3 / 572.3 / 717.9 | 0 | 45,431 | 8,438,142 (136,293) | 14,288 | 172.6 s | 219 / 99 | 510.5 / 198.3 | backlog |
| 45,000 | greedy | [37344085772](https://github.com/kludw/uber-simulator/actions/runs/37344085772) | EPYC 9V74 | 457.4 / 609.7 / 790.2 | 0 | 45,431 | 8,258,142 (136,293) | 13,443 | 176.6 s | 220 / 108 | 592.4 / 207.0 | backlog |
| 50,000 | greedy | [37342326038](https://github.com/kludw/uber-simulator/actions/runs/37342326038) | EPYC 7763 | 466.1 / 615.7 / 790.9 | 0 | 50,478 | 11,816,398 (151,435) | 19,891 | 232.8 s | 230 / 101 | 548.0 / 211.2 | settle, backlog |
| 27,500 | batched | [37345935290](https://github.com/kludw/uber-simulator/actions/runs/37345935290) | EPYC 7763 | 259.2 / 432.4 / 768.9 | 0 | 27,766 | 37,518 (83,297) | 126 | 2.1 s | 108 / 81 | 297.1 / 140.1 | none |
| 27,500 | batched | [37345970001](https://github.com/kludw/uber-simulator/actions/runs/37345970001) | EPYC 9V74 | 192.6 / 331.6 / 785.1 | 0 | 27,766 | 36,862 (83,297) | -41 | 2.1 s | 77 / 64 | 247.9 / 109.2 | none |
| 30,000 | batched | [37345923121](https://github.com/kludw/uber-simulator/actions/runs/37345923121) | EPYC 9V45 | 174.7 / 307.5 / 423.8 | 0 | 30,290 | 40,066 (90,869) | -24 | 2.0 s | 70 / 61 | 248.8 / 100.9 | none |
| 30,000 | batched | [37345958731](https://github.com/kludw/uber-simulator/actions/runs/37345958731) | EPYC 9V74 | 229.7 / 419.1 / 555.0 | 0 | 30,290 | 39,849 (90,869) | -39 | 2.4 s | 89 / 81 | 298.3 / 129.0 | none |
| 32,500 | batched | [37347458247](https://github.com/kludw/uber-simulator/actions/runs/37347458247) | EPYC 7763 | 346.8 / 591.5 / 1,297.0 | 4 (0.7%) | 32,813 | 42,039 (98,439) | 121 | 2.3 s | 139 / 112 | 370.2 / 179.1 | none |
| 32,500 | batched | [37347474168](https://github.com/kludw/uber-simulator/actions/runs/37347474168) | EPYC 9V74 | 255.6 / 453.8 / 999.0 | 0 | 32,813 | 41,604 (98,439) | -42 | 3.0 s | 97 / 89 | 324.7 / 140.7 | none |

Every run printed a report, finished 600 of 600 ticks with 0 slow consumers; no infra failure, no rerun. `clock.ticked` max deviation 9.0-118.8 ms. Peak RSS per service 56.8-226.0 MiB, except batched dispatch: 326-403 MiB.

- **Greedy, live: 32.5k** (two runs, EPYC 9V74 and 7763, both pass every criterion). 35k fails the backlog bound in 4 of 4 runs, all on EPYC 7763. 40k splits by runner: it passes on EPYC 9V45 (37342317815) and 9V74 (37342498844) and fails the backlog bound on 7763 (37344044949) and on another 9V74 (37344075889). 45k fails the backlog bound in both runs (7763, 9V74), 50k fails settle and the backlog bound (7763). **The milestone 16 target (40k, two runs) is not met**: 2 of 4 runs pass.
- **Batched, live: 32.5k** (two runs pass; above not measured). The 7763 run is close to two bounds: settle p95 591.5 ms and 4 overruns (0.7%). 27.5k and 30k pass twice each. Batched ticks are closed by `trip.picked_up` (58-60% of ticks), `trip.completed` (19-22%), and `trip.matched` (20%, the batch ticks), not by `trip.matched` alone as in greedy.
- **What fails first now: the persister's backlog.** Every failing greedy size (35k-50k) fails the backlog bound; settle passes every greedy run up to 45k (p95 at most 609.7 ms, 45k on 9V74, 0.3 ms inside the bound) and fails first at 50k (615.7 ms). Overruns are 0 in every greedy run. `trip.matched` still closes 99.8% of greedy ticks; dispatch's decode is 104-230 ms per tick (3.5-5.0 µs per message on the 9V74 and 7763, 2.6 µs on the 9V45).
- **35k: the persister keeps up, then falls behind in the last 25 s.** In all four 35k runs the backlog's max over samples 0-112 of 121 is 49,219-58,145 (at most 1.65 ticks of events), then climbs about 27k per 5 s from sample 113 (about 565 s) to 120-150k at sample 117 (3.4-4.3 ticks), then falls again; second-half slope 92-168 events/s. In those last intervals the persister's rounds per 10 s drop from 35-36 to 30-33 for one or two of its 10 s entries; ack per round about doubles in all four runs, decode or insert per round rises in some. The four runs reach backlog values ending in the same digits at the same samples (peaks 120,433 / 130,433 / 140,433 / 150,433), so the rise is tied to the run's content (same tick, same data volume), not to the runner alone. What costs the persister CPU there is not separated (a ClickHouse background merge at that data volume is one candidate, not verified). 30k and 32.5k show no such rise.
- **The persister writes about a third less while the stack runs.** Falling behind, during the run it wrote 33.8k (40k, 7763), 37.4k (40k, 9V74), 31.3-31.8k (45k), and 30.7k events/s (50k). After the last tick, with every other service stopped, the same persister drained at 47.0-50.8k events/s. Per 10,000-event round: 268-325 ms during the run (fetch 90-151 ms, decode 77-92, insert 80-84, ack 11-16) against 196-211 ms while draining (fetch 53-59, decode 63-76, insert 70-74, ack 8-9). Every phase slows, fetch the most (1.5-2.7x), and the persister's CPU is 66-76% of its wall time in those runs, so its process isn't saturated. That is consistent with the persister losing CPU to the rest of the stack on the runner's 4 CPUs rather than being limited by its own insert; not shown directly, since the NATS server's and ClickHouse's CPU aren't in the report.
- **Runner speed decides near the limit, also within one CPU model.** The two 40k runs on 9V74 differ: dispatch decode / handle 139 / 68 vs 187 / 86 ms per tick, the persister level with the 40.4k events/s published vs falling behind at 37.4k.

### Against milestone 14

| | Milestone 14 ([After milestone 14](#after-milestone-14)) | Milestone 16 (this section) |
| --- | --- | --- |
| Greedy, live | 25k | 32.5k |
| Batched, live | 20k | 32.5k (above not measured) |
| Fails first | settle (greedy 27.5k, batched 25k) | persister backlog (greedy 35k on 7763; 40k on 7763 and one 9V74) |
| Settle first fails (greedy) | 27.5k (p95 616.5-681.8 ms) | 50k (p95 615.7 ms); passes up to 45k |
| Settle p95 at the largest greedy pass | 289.8-516.2 ms (25k) | 385.8-409.7 ms (32.5k) |
| Persister write rate while falling behind | 27-40k events/s (run average, including the drain) | 30.7-37.4k events/s during the run; 47.0-50.8k alone (drain) |

Against the in-process run ([After milestone 12](#after-milestone-12)): greedy reliably keeps real time at 50k there; live greedy at 32.5k is now 1.5× below it, down from 2× (milestone 14) and 5× (milestone 13). Settle alone would put live greedy at 45k: ADR 0042 moved the first limit from the services back to the persister.

Next (proposal, no ADR): the persister writes about 1.5× faster alone than beside the rest of the stack on the same 4 CPUs, and fetch slows most. Before changing it, record the NATS server's and ClickHouse's CPU in the load test report (the services' CPU is already there): that shows where the persister's lost CPU goes and may explain the 35k rise. If other processes' work dominates, cutting per-message work across the stack (one positions message per shard per tick; an event shape change and an ADR, as in [Subscriptions per service](#subscriptions-per-service)) is the candidate; if fetch is mostly waiting for delivery, overlapping the next fetch with the current round's decode and insert in the persister is.

### Start-up race

Why dispatch received fewer messages in some runs above, [#195](https://github.com/kludw/uber-simulator/issues/195). Dispatch's received count: the sum of `received` over its `messages_timed` entries in each run's `services.log` (`gh run download`). Start order: the order of the services' `service_started` lines there (logged once subscriptions are flushed; a shard publishes its `driver.went_online` right after). Lines from different processes interleave through pipes, so the order is approximate.

| Drivers | Matching | Runs | Dispatch received | Shortfall | Dispatch `service_started` |
| ---: | --- | --- | ---: | ---: | --- |
| 40,000 | greedy | [37342317815](https://github.com/kludw/uber-simulator/actions/runs/37342317815), [37342498844](https://github.com/kludw/uber-simulator/actions/runs/37342498844), [37344044949](https://github.com/kludw/uber-simulator/actions/runs/37344044949) | 24,174,270 | 0 | before or between the shards |
| 40,000 | greedy | [37344075889](https://github.com/kludw/uber-simulator/actions/runs/37344075889) | 24,172,862 | 1,408 | after shard 0 |
| 30,000 | batched | [37345923121](https://github.com/kludw/uber-simulator/actions/runs/37345923121) | 18,131,445 | 0 | after shard 0 |
| 30,000 | batched | [37345958731](https://github.com/kludw/uber-simulator/actions/runs/37345958731) | 18,108,877 | 22,568 | after both shards, last |
| 32,500 | batched | [37347474168](https://github.com/kludw/uber-simulator/actions/runs/37347474168) | 19,642,041 | 0 | before shard 0 |
| 32,500 | batched | [37347458247](https://github.com/kludw/uber-simulator/actions/runs/37347458247) | 19,633,873 | 8,168 | after both shards, last |

Every other run of [After milestone 16](#after-milestone-16) and [Subscriptions per service](#subscriptions-per-service) has the same count as the other runs of its size (27.5k greedy 16,620,760 in two runs, 30k greedy 18,131,577 in four, 32.5k greedy 19,642,236 in two, 35k 21,152,555 in four, 45k 27,195,446 in two, 27.5k batched 16,620,562 in two).

- **Cause: dispatch subscribes after a shard starts publishing.** The launchers start dispatch, the riders, the shards and the clock at once once the persister is ready (`src/sim/dev.ts`, `src/loadtest/main.ts`); core NATS doesn't replay (ADR 0028), so `driver.went_online` published before dispatch's subscription exists is not delivered to it. Each shortfall is below the fleet size, and the two largest are the runs where dispatch logged `service_started` last. 22,568 is more than one 15,000-driver shard: all of one and part of the other.
- **No effect on trips seen at 40k greedy and 30k batched.** In those short runs the shards' received counts (offers, `trip_status`) and the riders' (replies, trip events) equal those of the full runs: 96,957 per shard and 57,268 riders at 40k greedy, 72,980 and 43,042 at 30k batched. At 32.5k batched the trip flow differs: the short run's shards and riders each received 20 fewer (78,892 vs 78,912, 46,545 vs 46,565) and the runs' event totals differ by 93. Hypothesis, not verified: the overruns (4, the only run in the table with any) changed offer timing; the race is an unlikely cause, since batched matching first runs on tick 5, after every idle driver has moved. Dispatch learns a missed driver from its tick-1 `driver.moved` and matches the first requests (tick 1) on tick 2 at the earliest. Decision: [ADR 0043](adr/0043-learn-drivers-from-moves.md), no start order change.
- **Comparing counts**: dispatch's received count is exact up to a start-up shortfall of at most one fleet (under 0.2% of a 600-tick run).

## Infra CPU

Where the runner's CPU goes near the live limit, and what the 35k backlog spike of [After milestone 16](#after-milestone-16) coincides with, [#198](https://github.com/kludw/uber-simulator/issues/198) (milestone 17). The load test report now gives, besides each service's CPU: the NATS server's and ClickHouse's CPU from their containers' cgroup v2 `cpu.stat` (cumulative `user_usec` / `system_usec`, read through `docker exec` at the start, with each backlog sample, and at the stop); the load test process's own CPU (`process.cpuUsage()`: observer and sampler); each one's share of the runner's CPUs over the run; and per backlog sample, the NATS server's and ClickHouse's CPU in cores and ClickHouse's merged rows (`system.events` `MergedRows`, every table). Measured 2026-10-05 on branch `198-infra-cpu` at `02c519a` (master `df17330` plus the report change).

### Method

- `loadtest` workflow as in [After milestone 16](#after-milestone-16): greedy, 2 driver shards, 600 ticks, drain bound 5 min, one `ubuntu-latest` runner (4 CPUs, 15,989 MiB) per case.
- Runs: 32.5k [37363362139](https://github.com/kludw/uber-simulator/actions/runs/37363362139), [37365053999](https://github.com/kludw/uber-simulator/actions/runs/37365053999); 35k [37363362139](https://github.com/kludw/uber-simulator/actions/runs/37363362139), [37380566741](https://github.com/kludw/uber-simulator/actions/runs/37380566741). Two other 35k jobs (in 37365053999 and [37368480435](https://github.com/kludw/uber-simulator/actions/runs/37368480435)) and the whole of [37363375565](https://github.com/kludw/uber-simulator/actions/runs/37363375565) were cancelled by GitHub before starting ("The job was not acquired by Runner of type hosted"), no step run.
- Units, checked on Linux (Docker Desktop's VM): a 2 s busy loop in a fresh `nats:2.15.0-alpine` container reads `user_usec 2008831` in its `cpu.stat`; the same loop in `oven/bun:1.4.2` reads `process.cpuUsage().user` 2,010,167. Both microseconds, as documented. On CI, the NATS server's per-sample cores sit at 0.5-0.8 throughout, consistent with that.
- Not used: NATS `/varz` `cpu` is a percentage over the last second (nats-server `server/pse/pse_linux.go`), not cumulative; ClickHouse's own `UserTimeMicroseconds` + `SystemTimeMicroseconds` (`system.events`) were a fifth of its container's `cpu.stat` on the local stack (5,060 vs 23,660 s), since they count only threads with profiling attached.
- Not counted: the runner's other processes (Docker daemon, the Actions runner agent, the `docker exec` calls). The infra reads lengthen each sampler round by about 0.1 s, so these runs have 118-119 backlog samples, not 121; sample indices below are this section's.
- Persister round phases from its `rounds_timed` entries, as in [After milestone 16](#after-milestone-16).

### Results

CPU seconds over the run, start to stop, user + system (share of the runner's 4 CPUs × the run's wall time):

| Drivers | Run | CPU model | Backlog second-half max (limit) | Persister | Dispatch | Shards (both) | Riders + clock | NATS server | ClickHouse | Load test | Total (cores) |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 32,500 | [37363362139](https://github.com/kludw/uber-simulator/actions/runs/37363362139) | AMD EPYC 9V74 | 38,911 (98,441) | 371.2 (15.4%) | 132.7 (5.5%) | 86.5 (3.6%) | 5.6 (0.2%) | 391.7 (16.2%) | 181.7 (7.5%) | 101.8 (4.2%) | 1,271.0 (52.6%, 2.10) |
| 32,500 | [37365053999](https://github.com/kludw/uber-simulator/actions/runs/37365053999) | AMD EPYC 9V74 | 39,610 (98,441) | 391.4 (16.2%) | 136.9 (5.7%) | 92.0 (3.8%) | 5.9 (0.2%) | 381.4 (15.8%) | 176.0 (7.3%) | 106.4 (4.4%) | 1,289.8 (53.4%, 2.13) |
| 35,000 | [37363362139](https://github.com/kludw/uber-simulator/actions/runs/37363362139) | AMD EPYC 7763 | 129,596 (106,009) | 376.3 (15.5%) | 150.1 (6.2%) | 95.1 (3.9%) | 5.3 (0.2%) | 441.9 (18.2%) | 215.2 (8.9%) | 114.5 (4.7%) | 1,398.6 (57.7%, 2.31) |
| 35,000 | [37380566741](https://github.com/kludw/uber-simulator/actions/runs/37380566741) | AMD EPYC 9V74 | 43,913 (106,009) | 331.9 (13.7%) | 116.9 (4.8%) | 77.8 (3.2%) | 4.9 (0.2%) | 321.2 (13.3%) | 149.2 (6.2%) | 87.2 (3.6%) | 1,089.2 (45.1%, 1.80) |

Settle passed every case (p95 307.0-446.5 ms), 0 overruns, 0 slow consumers, drain 2.0-4.0 s. 32.5k passes every criterion in both runs; 35k fails the backlog bound on the EPYC 7763 (37363362139) and passes every criterion on the EPYC 9V74 (37380566741).

- **The runner isn't saturated on average**: the counted processes use 1.8-2.3 of 4 cores. The NATS server is the second largest user after the persister, 0.53-0.73 cores (both are 13-18% of the runner); ClickHouse 0.25-0.36 cores on average, the load test's observer 0.14-0.19.
- **The 35k spike coincides with one large ClickHouse merge** (37363362139, EPYC 7763). Across samples 111-114 (about 565-585 s), ClickHouse merges 4.5-5.6M rows per sample, about 20.7M in all (the run's 21.2M events), at 1.09-1.22 cores, against a median 0.29 cores and 0.6M rows per sample; the persister's backlog rises from 41,542 to 129,596 over the same four samples and starts falling once the merge ends (105,957 at the last sample). The table isn't in `system.events`; the row count matches the events table merging into one part. In the same window the persister's rounds per 10 s fall from 35-37 to 31-34, its decode per round rises from 66-81 to 86-98 ms, insert from 73-75 to 76-88 ms, ack from 9-12 to 12-22 ms.
- **Smaller merges come every 23-27 samples (about 2 min) in every run**: one sample of 2.7-5.0M rows at 0.56-1.04 cores (32.5k: samples 26, 51, 78, 103 in both runs; 35k on the 7763: 24, 48, 73, 97; on the 9V74: 30, 53, 79, 102). The persister absorbs them: no backlog rise above the run's usual 30-54k. In the 35k 7763 run the large merge followed four of them; no other run has one within its 600 ticks. The 35k 9V74 run's merges run later (merged rows over the run 90.0M vs 107.1M), so its large merge presumably falls after tick 600 (inferred, not observed); at 32.5k (19.7M events, 8% fewer) presumably too in both runs. So whether 35k passes depends on whether the large merge lands before tick 600: [After milestone 16](#after-milestone-16)'s four 35k runs, all EPYC 7763, had it at the same samples.
- **Persister rounds, keeping up vs behind**: run averages per 10,000-event round are fetch 123-149 ms, decode 63-81, insert 72-86, ack 7-11, and the persister's CPU is 55-65% of one core. While it keeps up, a round lasts 10,000 events / arrival rate, so fetch is mostly waiting for the batch to fill, not work. Behind (35k on the 7763, the entries at about 568-610 s, during and after the large merge): fetch 89-142 ms, decode + insert + ack 165-200 ms, round 259-336 ms. Fetch, decode, insert and ack run one after another, so the merge's extra cost per round adds straight to the round time.

Next (proposal, no ADR; [#199](https://github.com/kludw/uber-simulator/issues/199)): overlap the persister's next fetch with the current round's decode, insert and ack (acks still after their own insert, FINAL dedupe unchanged). In the behind-state rounds of the 35k 7763 run, a pipelined round would cost about max(fetch, decode + insert + ack) instead of their sum: about 170-200 ms instead of 259-336 ms per 10,000 events, 50-59k events/s against the 35.3k published, while the persister uses under two thirds of a core. That headroom is what the 20 s merge at 35k needs. Cutting other processes' CPU instead (one positions message per shard per tick, a message-shape change for every consumer) would mainly lower the NATS server's 0.53-0.73 cores and the observer's, but the runner has 1.7-2.2 cores idle on average, so CPU elsewhere isn't what the persister waits on. ClickHouse merge settings would likely move the large merge rather than remove it (not measured).

## Persister pipelining

The persister after [ADR 0044](adr/0044-persister-pipelining.md) (next fetch runs while the current batch is decoded, inserted and acked; max ack pending 20,000), [#199](https://github.com/kludw/uber-simulator/issues/199). Measured 2026-10-05 on branch `199-persister-pipelining` at `0f02053` (master `8451d5d` plus the change), same method as [Infra CPU](#infra-cpu): greedy, 2 driver shards, 600 ticks, drain bound 5 min, one `ubuntu-latest` runner (4 CPUs) per case. Runs: [37383732053](https://github.com/kludw/uber-simulator/actions/runs/37383732053), [37383743954](https://github.com/kludw/uber-simulator/actions/runs/37383743954), each 35k and 40k. Sample indices are 0-based within each report.

| Drivers | Run | CPU model | Large merge (samples, rows) | Backlog before merge -> peak over the merge's samples | Backlog second-half max, sample (limit) | Settle p95 ms | Persister CPU s | Failed |
| ---: | --- | --- | --- | --- | --- | ---: | ---: | --- |
| 35,000 | [37383732053](https://github.com/kludw/uber-simulator/actions/runs/37383732053) | AMD EPYC 7763 | 111-114, 19.6M | 33,108 -> 66,535 | 66,535, 114 (106,009) | 523.7 | 409.0 | none |
| 35,000 | [37383743954](https://github.com/kludw/uber-simulator/actions/runs/37383743954) | AMD EPYC 7763 | 113-116, 20.6M | 15,904 -> 47,113 | 47,113, 113 (106,009) | 486.6 | 383.5 | none |
| 40,000 | [37383732053](https://github.com/kludw/uber-simulator/actions/runs/37383732053) | AMD EPYC 9V74 | 108-110, 21.5M | 41,699 -> 34,113 (falls to 27,439) | 48,407, 83 (121,153) | 404.3 | 372.0 | none |
| 40,000 | [37383743954](https://github.com/kludw/uber-simulator/actions/runs/37383743954) | AMD EPYC 7763 | 97-100, 20.9M | 32,105 -> 191,307 | 200,660, 104 (121,153) | 560.0 | 425.8 | backlog |

0 overruns, 0 slow consumers, drain 2.0-5.1 s, ack pending max 20,000 in every case.

- **35k keeps up with the large merge inside the run**, on the EPYC 7763 where it failed in [Infra CPU](#infra-cpu) (42k -> 130k): both runs had the ~20M-row merge before tick 600 (at 1.1-1.3 cores), and the backlog peaked at 47-67k, 44-63% of the limit. In 37383743954 the merge ends at the last samples, so its tail is only partly seen.
- **40k depends on the CPU model**: on the 9V74 the backlog falls during the merge (41,699 -> 27,439), and its second-half max (48,407) is at sample 83, before the merge; on the 7763 it climbs from 32k to 201k, and after the merge the persister recovers at only about 41-42k events/s against 40.4k published.
- **Rounds (per 10,000 events, `rounds_timed`)**: during the run, fetch wait 82-92 ms at 35k (49-82 at 40k; keeping up, so mostly waiting), decode 83-89, insert 99-102, ack 9-10. In the merge (35k, about 579-598 s) the fetch wait drops to 18-27 ms, decode rises to 116-137 and insert to 109-122, so a round is 266-294 ms: 34-37k events/s. Before the change the same window had rounds of 259-336 ms and 31-34 rounds per 10 s; now 34-38.
- **Smaller gain than projected**: ADR 0044 projected 170-200 ms rounds while behind. Fetch is hidden, but decode and insert each grew by about 20 ms on average (decode 63-81 -> 83-89, insert 72-86 -> 99-102), consistent with the NATS client parsing the next batch on the same thread during the insert's await and between decodes (inferred, not profiled). Persister CPU 372-426 s (62-70% of a core), up from 332-391 s.

## After milestone 17

Live limits after [ADR 0044](adr/0044-persister-pipelining.md)'s persister pipelining, judged by ADR 0037 with [ADR 0038](adr/0038-persister-backlog-criterion.md)'s backlog bound, [#200](https://github.com/kludw/uber-simulator/issues/200). Measured 2026-10-05/06 at `f8b4b74` (master after [#202](https://github.com/kludw/uber-simulator/pull/202)).

### Method

- `loadtest` workflow as in [After milestone 16](#after-milestone-16): one `ubuntu-latest` job per case (4 CPUs, 15,988-15,989 MiB, 1-minute load average 0.27-2.25 at start), 2 driver shards, demand at the spec ratio, seed 1, 5-tick batch window, 600 ticks, drain bound 5 min. CPU model per run from the report's `host` line. Events per tick: greedy 35,336 (35k), 37,861 (37.5k), 40,384 (40k), 45,431 (45k); batched 32,813 (32.5k), 35,335 (35k).
- Greedy bracketed upward from 32.5k at 35k / 37.5k / 40k / 45k, then 35k and 37.5k six times each and 40k four times, since 37.5k and 40k split by runner; 45k twice. Batched at the largest greedy-passing size (35k) and one step below (32.5k), twice each.
- Several cases per workflow run, one job each (a row cites its run plus drivers and matching): [37386237720](https://github.com/kludw/uber-simulator/actions/runs/37386237720) and [37386254485](https://github.com/kludw/uber-simulator/actions/runs/37386254485) greedy 35k / 37.5k / 40k / 45k; [37387565997](https://github.com/kludw/uber-simulator/actions/runs/37387565997) and [37387571182](https://github.com/kludw/uber-simulator/actions/runs/37387571182) greedy 35k / 37.5k / 40k; [37388836456](https://github.com/kludw/uber-simulator/actions/runs/37388836456) and [37388839975](https://github.com/kludw/uber-simulator/actions/runs/37388839975) greedy 35k / 37.5k; [37387568422](https://github.com/kludw/uber-simulator/actions/runs/37387568422) and [37387573832](https://github.com/kludw/uber-simulator/actions/runs/37387573832) batched 32.5k / 35k. Every job started.
- Large merge: consecutive backlog samples with at least 3M ClickHouse merged rows each, 10M or more in all (the ~20M-row merge of [Infra CPU](#infra-cpu)); samples 0-based within each report (117-119 per run). "Before -> peak": the backlog at the sample before the merge and its max over the merge's samples. Runner cores: the report's counted total (services, NATS server, ClickHouse, load test) as a share of 4 CPUs over start to stop, drain included (604 s for most runs, up to 684 s for 45k on the 7763), × 4. Backlog slope as in [After milestone 16](#after-milestone-16).

### Results

| Drivers | Matching | Run | CPU model | Settle ms mean / p95 / max | Overruns | Backlog second-half max (limit) | Backlog slope /s | Large merge (samples, rows: before -> peak) | Drain | CPU s persister / dispatch | Runner cores (share) | Failed |
| ---: | --- | --- | --- | --- | ---: | --- | ---: | --- | --- | --- | --- | --- |
| 35,000 | greedy | [37386237720](https://github.com/kludw/uber-simulator/actions/runs/37386237720) | Xeon Platinum 8573C | 249.8 / 331.1 / 449.1 | 0 | 42,708 (106,009) | 0 | none in run | 2.0 s | 328.6 / 124.3 | 1.90 (47.4%) | none |
| 35,000 | greedy | [37386254485](https://github.com/kludw/uber-simulator/actions/runs/37386254485) | EPYC 9V74 | 233.2 / 320.0 / 457.4 | 0 | 42,524 (106,009) | 0 | 114-116, 19.1M: 1,311 -> 32,973 | 2.0 s | 325.0 / 115.3 | 1.82 (45.6%) | none |
| 35,000 | greedy | [37387565997](https://github.com/kludw/uber-simulator/actions/runs/37387565997) | EPYC 9V74 | 241.2 / 306.1 / 405.5 | 0 | 44,109 (106,009) | 9 | none in run | 2.0 s | 342.1 / 120.8 | 1.87 (46.8%) | none |
| 35,000 | greedy | [37387571182](https://github.com/kludw/uber-simulator/actions/runs/37387571182) | EPYC 9V74 | 227.5 / 289.0 / 456.3 | 0 | 44,528 (106,009) | 7 | none in run | 2.0 s | 321.1 / 113.3 | 1.78 (44.6%) | none |
| 35,000 | greedy | [37388836456](https://github.com/kludw/uber-simulator/actions/runs/37388836456) | EPYC 9V74 | 245.5 / 327.6 / 463.2 | 0 | 43,923 (106,009) | -5 | 112-114, 19.8M: 6,592 -> 33,025 | 2.0 s | 344.7 / 120.7 | 1.90 (47.4%) | none |
| 35,000 | greedy | [37388839975](https://github.com/kludw/uber-simulator/actions/runs/37388839975) | EPYC 9V74 | 238.7 / 315.7 / 420.2 | 0 | 43,969 (106,009) | 16 | none in run | 2.0 s | 334.2 / 117.0 | 1.84 (45.9%) | none |
| 37,500 | greedy | [37386237720](https://github.com/kludw/uber-simulator/actions/runs/37386237720) | EPYC 7763 | 467.3 / 631.0 / 746.9 | 0 | 414,426 (113,582) | 1,049 | 104-107, 18.5M: 177,005 -> 349,167 | 10.1 s | 481.7 / 186.1 | 2.86 (71.4%) | settle, backlog |
| 37,500 | greedy | [37386254485](https://github.com/kludw/uber-simulator/actions/runs/37386254485) | EPYC 7763 | 416.3 / 580.4 / 701.7 | 0 | 187,409 (113,582) | 379 | 103-107, 22.0M: 23,648 -> 174,736 | 4.1 s | 438.6 / 171.1 | 2.66 (66.6%) | backlog |
| 37,500 | greedy | [37387565997](https://github.com/kludw/uber-simulator/actions/runs/37387565997) | EPYC 7763 | 372.2 / 515.4 / 720.9 | 0 | 112,689 (113,582) | 93 | 103-107, 22.3M: 29,878 -> 112,689 | 2.3 s | 406.1 / 161.4 | 2.52 (62.9%) | none |
| 37,500 | greedy | [37387571182](https://github.com/kludw/uber-simulator/actions/runs/37387571182) | EPYC 7763 | 374.8 / 529.5 / 761.3 | 0 | 101,524 (113,582) | 85 | 105-109, 23.2M: 14,948 -> 101,524 | 3.0 s | 401.4 / 162.1 | 2.50 (62.5%) | none |
| 37,500 | greedy | [37388836456](https://github.com/kludw/uber-simulator/actions/runs/37388836456) | EPYC 9V45 | 212.5 / 297.6 / 428.3 | 0 | 46,377 (113,582) | 6 | 106-108, 21.6M: 1,624 -> 39,061 | 2.0 s | 314.1 / 106.1 | 1.68 (41.9%) | none |
| 37,500 | greedy | [37388839975](https://github.com/kludw/uber-simulator/actions/runs/37388839975) | EPYC 9V74 | 371.1 / 545.3 / 706.2 | 0 | 134,023 (113,582) | 136 | 105-108, 20.4M: 27,446 -> 134,023 | 2.0 s | 432.4 / 159.3 | 2.54 (63.5%) | backlog |
| 40,000 | greedy | [37386237720](https://github.com/kludw/uber-simulator/actions/runs/37386237720) | EPYC 7763 | 445.6 / 596.3 / 720.8 | 0 | 599,788 (121,153) | 1,828 | 98-102, 22.1M: 275,184 -> 516,644 | 13.1 s | 453.7 / 177.6 | 2.77 (69.2%) | backlog |
| 40,000 | greedy | [37386254485](https://github.com/kludw/uber-simulator/actions/runs/37386254485) | EPYC 9V74 | 381.2 / 547.1 / 738.8 | 0 | 185,246 (121,153) | 301 | 99-102, 19.9M: 46,060 -> 185,246 | 3.3 s | 434.7 / 163.7 | 2.60 (64.9%) | backlog |
| 40,000 | greedy | [37387565997](https://github.com/kludw/uber-simulator/actions/runs/37387565997) | Xeon 6973P-C | 231.0 / 303.5 / 389.7 | 0 | 50,177 (121,153) | 0 | 109-111, 21.7M: 23,144 -> 20,638 | 2.2 s | 341.2 / 118.1 | 1.81 (45.2%) | none |
| 40,000 | greedy | [37387571182](https://github.com/kludw/uber-simulator/actions/runs/37387571182) | EPYC 9V74 | 290.3 / 407.7 / 584.7 | 0 | 48,944 (121,153) | 25 | 108-111, 24.0M: 28,521 -> 35,533 | 2.0 s | 380.5 / 136.1 | 2.13 (53.2%) | none |
| 45,000 | greedy | [37386237720](https://github.com/kludw/uber-simulator/actions/runs/37386237720) | EPYC 7763 | 488.3 / 653.3 / 869.9 | 0 | 4,487,387 (136,293) | 8,515 | 103-106, 18.8M: 3,686,142 -> 4,061,967 | 82.3 s | 505.9 / 199.2 | 2.78 (69.4%) | settle, backlog |
| 45,000 | greedy | [37386254485](https://github.com/kludw/uber-simulator/actions/runs/37386254485) | Xeon Platinum 8573C | 292.0 / 408.4 / 522.8 | 0 | 68,008 (136,293) | 25 | 96-99, 23.8M: 26,449 -> 68,008 | 2.0 s | 370.2 / 141.3 | 2.16 (54.0%) | none |
| 32,500 | batched | [37387568422](https://github.com/kludw/uber-simulator/actions/runs/37387568422) | EPYC 9V45 | 181.7 / 331.3 / 420.3 | 0 | 42,398 (98,439) | -2 | none in run | 2.2 s | 253.1 / 105.5 | 1.38 (34.6%) | none |
| 32,500 | batched | [37387573832](https://github.com/kludw/uber-simulator/actions/runs/37387573832) | Xeon Platinum 8573C | 294.2 / 574.5 / 1,215.9 | 3 (0.5%) | 40,425 (98,439) | 0 | none in run | 2.0 s | 336.2 / 158.3 | 1.94 (48.6%) | none |
| 35,000 | batched | [37387568422](https://github.com/kludw/uber-simulator/actions/runs/37387568422) | EPYC 7763 | 427.4 / 1,204.2 / 1,404.7 | 38 (6.3%) | 42,884 (106,003) | 16 | none in run | 3.0 s | 384.9 / 195.5 | 2.42 (60.5%) | settle, overruns |
| 35,000 | batched | [37387573832](https://github.com/kludw/uber-simulator/actions/runs/37387573832) | EPYC 7763 | 415.9 / 733.1 / 1,558.7 | 25 (4.2%) | 47,224 (106,004) | 30 | 111-114, 19.8M: 47,224 -> 44,188 | 2.0 s | 386.1 / 192.0 | 2.44 (61.1%) | settle, overruns |

Every run printed a report, finished 600 of 600 ticks with 0 slow consumers, ack pending max 20,000; no infra failure, no rerun. `clock.ticked` max deviation 11.3-196.4 ms. Peak RSS at most 242.4 MiB per service, except batched dispatch: 406-459 MiB.

- **Greedy, live: 35k** (six runs, Xeon Platinum 8573C and five EPYC 9V74, all pass every criterion; backlog at most 44,528, 42% of the limit). No 35k run here landed on an EPYC 7763; the two 35k runs of [Persister pipelining](#persister-pipelining) did, at the same code (`src/` at `0f02053` equals master's), and passed with the large merge in the run. 37.5k fails in 3 of 6 runs: the backlog bound on two EPYC 7763 and one 9V74 (one 7763 run also fails settle); it passes on two other 7763 (one at 112,689, 99.2% of the limit) and a 9V45. 40k fails in 2 of 4 (7763, 9V74) and passes on a Xeon 6973P-C and another 9V74. 45k passes on a Xeon Platinum 8573C and fails settle and the backlog bound on a 7763. **The milestone 17 target (40k, two runs) is not met.**
- **Batched, live: 32.5k** (EPYC 9V45 and Xeon Platinum 8573C; the Xeon run is close: settle p95 574.5 ms, 3 overruns). 35k fails settle and overruns in both runs (both EPYC 7763, p95 733.1-1,204.2 ms, 25-38 overruns) with the backlog at 40-45% of its limit: batched fails first on settle, not on the persister.
- **What fails first now (greedy): still the persister's backlog, decided by the run's single large ClickHouse merge on slower runners.** From 37.5k up the ~20M-row merge (18.5-24.0M rows over 3-5 samples, at up to 1.2-1.3 ClickHouse cores) starts within the run in every run, at samples 96-109 (about 480-545 s); at 35k it starts at samples 112-114 or after the last tick. Of the five failing runs at 37.5k-40k, three kept up until the merge (second-half backlog at most 47.9-54.4k before it, 42-47% of the limit) and crossed the limit only during it (23.6k -> 174.7k, 27.4k -> 134.0k, 46.1k -> 185.2k). The other two (37386237720, 7763) were already above the limit before it (second-half max 189k at 37.5k, 283k at 40k) and the merge added to that. Passing runs at 37.5k-45k have the merge in the run too; their backlog rises within the limit (7763, 9V45, 9V74, Xeon 8573C) or falls (Xeon 6973P-C).
- **Settle is close behind on the EPYC 7763**: greedy p95 515.4-653.3 ms there at 37.5k-45k (fails at 37.5k in 37386237720 and at 45k), against 289.0-547.1 ms on the other models up to 45k. At milestone 16 settle passed up to 45k on every model.
- **The runner decides near the limit, within one CPU model too.** The same 37.5k workload costs the counted processes 1.68 cores on the 9V45, 2.50-2.86 on the 7763 and 2.54 on the 9V74, against 1.78-1.90 for 35k. Every failing run at 37.5k-45k counted 2.54-2.86 cores; every passing run there counted 1.68-2.16, except two 7763 runs at 37.5k (2.50-2.52, backlog at 89-99% of the limit). The two 40k runs on 9V74 differ by 0.47 cores (2.13 vs 2.60) and in verdict.

### CPU budget at the limit

Greedy 35k, the six runs above (CPU s, user + system, over the 604 s from start to stop; cores = CPU s / 604): persister 321.1-344.7 (0.53-0.57 cores), NATS server 330.5-345.9 (0.55-0.57), ClickHouse 146.5-167.0 (0.24-0.28), dispatch 113.3-124.3 (0.19-0.21), both shards about 75-85 (0.12-0.14), load test 85.5-92.3 (0.14-0.15), riders + clock about 5; total 1.78-1.90 of 4 cores (44.6-47.4%). The persister and the NATS server each take about 30% of the counted CPU, ClickHouse 14%. The large merge adds about 1 core for 15-25 s. At 37.5k on the slower runners (2.50-2.86 cores counted) the NATS server runs at 0.79-0.90 cores (median per sample) and the persister at 0.66-0.80 over the run; while the merge runs, the counted total is roughly 3.5-3.8 of the 4 cores (the run average less ClickHouse's median plus its 1.0-1.3 merge cores; estimated, since the services' CPU isn't sampled), before the runner's uncounted processes.

### Against milestone 16

| | Milestone 16 ([After milestone 16](#after-milestone-16)) | Milestone 17 (this section) |
| --- | --- | --- |
| Greedy, live | 32.5k | 35k (6 of 6 runs; 2 more on 7763 in [Persister pipelining](#persister-pipelining)) |
| Batched, live | 32.5k (above not measured) | 32.5k (35k fails settle, 2 of 2 on 7763) |
| Greedy 35k | fails the backlog 4 of 4 (7763) | passes 6 of 6 (Xeon 8573C, 9V74) |
| Greedy 40k | 2 of 4 pass | 2 of 4 pass |
| Fails first (greedy) | persister backlog, at the large merge (35k) | persister backlog, at the large merge on slower runners (37.5k) |
| Settle p95, greedy 37.5k-45k | passes up to 45k (at most 609.7 ms) | 297.6-653.3 ms; fails at 37.5k and 45k on 7763 |
| Runner cores counted at the largest greedy pass | 2.10-2.13 (32.5k, [Infra CPU](#infra-cpu)) | 1.78-1.90 (35k) |

Against the in-process run ([After milestone 12](#after-milestone-12)): greedy reliably keeps real time at 50k there; live greedy at 35k is 1.4× below it (1.5× at milestone 16).

Next (proposal, no ADR): 40k misses on slower runners in two ways: the large merge pushes a persister that keeps up past the limit (3 runs), and on the slowest runners the persister is behind before the merge and settle is near its bound (2 runs). Capping ClickHouse's merge CPU (fewer background merge threads, or a setting that defers the large merge) would address only the first, and likely moves the merge rather than removes it ([Infra CPU](#infra-cpu)). Cutting per-message work across the stack addresses both: the NATS server (0.55-0.90 cores), the persister's decode and insert, dispatch's decode, and the observer all scale with messages, and with about one event per driver per tick, `driver.moved` is almost all of them. Candidate: one positions message per shard per tick instead of one `driver.moved` per driver (an event shape change for every consumer, ClickHouse included; needs an ADR), first measuring how much of each process's CPU goes to `driver.moved`.

## Cost of driver moves

How much of each process's work is `driver.moved`, so the message shape of milestone 18's ADR is chosen from numbers, [#205](https://github.com/kludw/uber-simulator/issues/205). `messages_timed` now splits received messages, decode ms and handle ms by message type (`byType`, `src/bus/nats.ts`); the load test report gives events and payload bytes per tick by subject (observer). Measured 2026-10-06 on branch `205-driver-move-cost` at `7309c90` (master `3ad2a14` plus the timing and report change; later commits on the branch are docs only).

### Method

- `loadtest` workflow as in [After milestone 17](#after-milestone-17): greedy 35k, 2 driver shards, seed 1, 600 ticks, drain bound 5 min, one `ubuntu-latest` runner (4 CPUs, 15,989 MiB) per run.
- Runs [37469524072](https://github.com/kludw/uber-simulator/actions/runs/37469524072) and [37469508917](https://github.com/kludw/uber-simulator/actions/runs/37469508917), both on AMD EPYC 7763.
- Messages and bytes: the report's events-by-subject line (observer, ticks 1..600, payload bytes only). Dispatch: the sum of its 61 `messages_timed` entries (603 s, start to stop) over 600 ticks, so startup (`driver.went_online`) is included. Persister rows: `rounds_timed` events (every row it inserts) against dispatch's `driver.moved` received count; `rounds_timed` isn't split by type, so the persister's ms aren't attributed. Infra CPU from the report's runner line.

### Results

Same seed, so both runs carry identical traffic: 21,201,748 events over ticks 1..600 (35,336 per tick), 20,998,008 of them `driver.moved`.

| | [37469524072](https://github.com/kludw/uber-simulator/actions/runs/37469524072) | [37469508917](https://github.com/kludw/uber-simulator/actions/runs/37469508917) |
| --- | --- | --- |
| CPU model | AMD EPYC 7763 | AMD EPYC 7763 |
| Settle p95 ms, backlog second-half max (limit) | 481.3, 59,439 (106,009) | 511.0, 66,352 (106,009) |
| `driver.moved` share of events / payload bytes (all `sim.events`) | 99.0% / 98.9% (34,996.7 per tick, 2,786,231 B per tick of 2,817,526) | same |
| `driver.moved` share of messages dispatch received | 99.3% (20,998,008 of 21,152,555) | same |
| Dispatch decode + handle ms per tick: `driver.moved` / rest | 199.9 (168.6 + 31.3) / 38.8 | 211.7 (177.7 + 34.0) / 40.9 |
| `driver.moved` share of dispatch decode + handle | 83.8% | 83.8% |
| Rest: of which `clock.ticked` handle ms per tick | 33.3 | 35.5 |
| Dispatch CPU s (report) vs timed decode + handle s | 156.0 vs 143.2 | 161.7 vs 151.6 |
| `driver.moved` share of persister rows | 98.9% (20,998,008 of 21,236,748) | same |
| Persister CPU s; decode / insert ms per tick (all types) | 386.8; 293.2 / 354.1 | 404.5; 309.1 / 363.8 |
| NATS server CPU s (cores) | 463.0 (0.77) | 468.6 (0.78) |
| ClickHouse CPU s (cores) | 204.1 (0.34) | 228.5 (0.38) |
| Runner total counted (share of 4 CPUs) | 1,436.1 s (59.4%) | 1,495.9 s (61.9%) |

Both runs pass every criterion: 0 overruns, 0 slow consumers, drain 2.1 s.

- **`driver.moved` is 99% of messages and bytes, and 98.9% of persister rows.** Its payload averages 79.6 B per event.
- **At dispatch it is 84% of decode + handle**, 200-212 ms per tick, mostly decode (168.6-177.7 ms, 4.8-5.1 µs per message). The other types decode at 9.4-10.5 µs per message but are 0.7% of messages. Of the rest's 38.8-40.9 ms per tick, 33.3-35.5 ms is `clock.ticked` handling (the brain's per-tick step, offers included).
- **Persister, NATS server, ClickHouse**: their CPU isn't split by type; they carry 98.9-99.3% `driver.moved` by count. The NATS server uses 0.77-0.78 cores, ClickHouse 0.34-0.38, the persister 386.8-404.5 CPU s (0.64-0.67 cores).

## After milestone 18

Live limits after [ADR 0045](adr/0045-publish-driver-moves-in-batches.md)'s `drivers.moved` (a shard's moves of a tick in messages of at most 5,000), judged by ADR 0037 with [ADR 0038](adr/0038-persister-backlog-criterion.md)'s backlog bound, [#207](https://github.com/kludw/uber-simulator/issues/207). Measured 2026-10-06 at `6909e8a` (master after [#210](https://github.com/kludw/uber-simulator/pull/210)).

### Method

- `loadtest` workflow as in [After milestone 17](#after-milestone-17): one `ubuntu-latest` job per case (4 CPUs, 15,988-15,993 MiB, 1-minute load average 0.24-1.53 at start), 2 driver shards, demand at the spec ratio, seed 1, 5-tick batch window, 600 ticks, drain bound 5 min. CPU model per run from the report's `host` line.
- Greedy bracketed upward from 35k at 50k / 75k / 100k / 150k (two runs each, all pass), then 200k / 250k / 300k (two each), then 225k and 250k twice more since they split, and 200k twice more as the size below. Batched at 50k / 75k / 100k first (all fail), then 35k / 40k / 45k, two runs each; at the largest greedy-passing size (200k) and one step below (150k) once each, since batched already fails every criterion from 75k up.
- Several cases per workflow run, one job each (a row cites its run plus drivers and matching): [37495150556](https://github.com/kludw/uber-simulator/actions/runs/37495150556) and [37495223919](https://github.com/kludw/uber-simulator/actions/runs/37495223919) greedy 50k / 75k / 100k / 150k; [37496753667](https://github.com/kludw/uber-simulator/actions/runs/37496753667) and [37496763902](https://github.com/kludw/uber-simulator/actions/runs/37496763902) greedy 200k / 250k / 300k; [37498291450](https://github.com/kludw/uber-simulator/actions/runs/37498291450) and [37498301955](https://github.com/kludw/uber-simulator/actions/runs/37498301955) greedy 225k / 250k; [37499856966](https://github.com/kludw/uber-simulator/actions/runs/37499856966) and [37499868521](https://github.com/kludw/uber-simulator/actions/runs/37499868521) greedy 200k / 225k; [37496888714](https://github.com/kludw/uber-simulator/actions/runs/37496888714) and [37496899926](https://github.com/kludw/uber-simulator/actions/runs/37496899926) batched 50k / 75k / 100k; [37498494906](https://github.com/kludw/uber-simulator/actions/runs/37498494906) and [37498506054](https://github.com/kludw/uber-simulator/actions/runs/37498506054) batched 35k / 40k / 45k; [37498516823](https://github.com/kludw/uber-simulator/actions/runs/37498516823) batched 150k / 200k. Every job started; no job hit the workflow's time cap.
- Events per tick counts messages: one `drivers.moved` (up to 5,000 moves) is one event, so it is about 1% of a fleet's size (the count of `drivers.moved` per tick in brackets). Backlog in ticks: second-half max over events per tick. Cores: CPU s (user + system) over the run's start-to-stop wall time (603-661 s); runner cores are the report's counted total (services, NATS server, ClickHouse, load test). Dispatch decode / handle ms per tick: its `messages_timed` entries summed over the run, over 600 ticks, as in [Cost of driver moves](#cost-of-driver-moves).

### Results

| Drivers | Matching | Run | CPU model | Settle ms mean / p95 / max | Overruns | Events per tick (`drivers.moved`) | Backlog second-half max (limit) | Backlog in ticks | Drain | Slow consumers | Cores dispatch / persister | Runner cores | Failed |
| ---: | --- | --- | --- | --- | ---: | ---: | --- | ---: | --- | ---: | --- | ---: | --- |
| 50,000 | greedy | [37495150556](https://github.com/kludw/uber-simulator/actions/runs/37495150556) | EPYC 7763 | 86.1 / 109.3 / 154.5 | 0 | 493.8 (10.0) | 642 (1,481) | 1.30 | 2.0 s | 0 | 0.12 / 0.12 | 0.52 | none |
| 50,000 | greedy | [37495223919](https://github.com/kludw/uber-simulator/actions/runs/37495223919) | EPYC 9V74 | 70.1 / 86.1 / 109.7 | 0 | 493.8 (10.0) | 1,016 (1,481) | 2.06 | 2.0 s | 0 | 0.10 / 0.10 | 0.43 | none |
| 75,000 | greedy | [37495150556](https://github.com/kludw/uber-simulator/actions/runs/37495150556) | EPYC 7763 | 128.3 / 159.7 / 229.1 | 0 | 744.2 (16.0) | 1,009 (2,233) | 1.36 | 2.0 s | 0 | 0.17 / 0.15 | 0.68 | none |
| 75,000 | greedy | [37495223919](https://github.com/kludw/uber-simulator/actions/runs/37495223919) | EPYC 7763 | 134.3 / 166.9 / 209.9 | 0 | 744.2 (16.0) | 1,740 (2,233) | 2.34 | 2.0 s | 0 | 0.18 / 0.16 | 0.70 | none |
| 100,000 | greedy | [37495150556](https://github.com/kludw/uber-simulator/actions/runs/37495150556) | EPYC 9V74 | 151.1 / 186.0 / 257.1 | 0 | 991.0 (20.0) | 2,153 (2,973) | 2.17 | 2.0 s | 0 | 0.21 / 0.17 | 0.74 | none |
| 100,000 | greedy | [37495223919](https://github.com/kludw/uber-simulator/actions/runs/37495223919) | EPYC 9V74 | 183.3 / 224.6 / 351.7 | 0 | 991.0 (20.0) | 2,127 (2,973) | 2.15 | 2.0 s | 0 | 0.25 / 0.20 | 0.89 | none |
| 150,000 | greedy | [37495150556](https://github.com/kludw/uber-simulator/actions/runs/37495150556) | EPYC 9V45 | 219.7 / 275.0 / 384.8 | 0 | 1,489.2 (30.0) | 3,550 (4,467) | 2.38 | 2.0 s | 0 | 0.30 / 0.21 | 0.96 | none |
| 150,000 | greedy | [37495223919](https://github.com/kludw/uber-simulator/actions/runs/37495223919) | EPYC 9V45 | 220.2 / 279.0 / 386.0 | 0 | 1,489.2 (30.0) | 3,459 (4,467) | 2.32 | 2.1 s | 0 | 0.30 / 0.21 | 0.96 | none |
| 200,000 | greedy | [37496753667](https://github.com/kludw/uber-simulator/actions/runs/37496753667) | EPYC 9V45 | 307.2 / 395.2 / 872.9 | 0 | 1,988.2 (40.0) | 4,782 (5,965) | 2.41 | 2.0 s | 0 | 0.41 / 0.28 | 1.26 | none |
| 200,000 | greedy | [37496763902](https://github.com/kludw/uber-simulator/actions/runs/37496763902) | EPYC 7763 | 434.6 / 563.5 / 987.8 | 1 (0.2%) | 1,988.2 (40.0) | 4,693 (5,965) | 2.36 | 2.1 s | 0 | 0.54 / 0.38 | 1.74 | none |
| 200,000 | greedy | [37499856966](https://github.com/kludw/uber-simulator/actions/runs/37499856966) | EPYC 9V74 | 341.8 / 419.1 / 612.0 | 0 | 1,988.2 (40.0) | 4,698 (5,965) | 2.36 | 2.0 s | 0 | 0.45 / 0.31 | 1.40 | none |
| 200,000 | greedy | [37499868521](https://github.com/kludw/uber-simulator/actions/runs/37499868521) | EPYC 7763 | 413.3 / 531.1 / 680.9 | 0 | 1,988.2 (40.0) | 4,742 (5,965) | 2.39 | 2.0 s | 0 | 0.52 / 0.37 | 1.68 | none |
| 225,000 | greedy | [37498291450](https://github.com/kludw/uber-simulator/actions/runs/37498291450) | EPYC 7763 | 468.0 / 598.3 / 764.4 | 0 | 2,237.0 (46.0) | 5,306 (6,711) | 2.37 | 2.1 s | 0 | 0.58 / 0.42 | 1.87 | none |
| 225,000 | greedy | [37498301955](https://github.com/kludw/uber-simulator/actions/runs/37498301955) | EPYC 7763 | 485.5 / 618.5 / 857.9 | 0 | 2,237.0 (46.0) | 5,383 (6,711) | 2.41 | 2.0 s | 0 | 0.60 / 0.41 | 1.90 | settle |
| 225,000 | greedy | [37499856966](https://github.com/kludw/uber-simulator/actions/runs/37499856966) | EPYC 7763 | 484.4 / 630.7 / 860.9 | 0 | 2,237.0 (46.0) | 5,706 (6,711) | 2.55 | 2.1 s | 0 | 0.59 / 0.41 | 1.90 | settle |
| 225,000 | greedy | [37499868521](https://github.com/kludw/uber-simulator/actions/runs/37499868521) | Xeon Platinum 8573C | 409.8 / 510.3 / 661.8 | 0 | 2,237.0 (46.0) | 5,274 (6,711) | 2.36 | 2.0 s | 0 | 0.54 / 0.36 | 1.72 | none |
| 250,000 | greedy | [37496753667](https://github.com/kludw/uber-simulator/actions/runs/37496753667) | EPYC 7763 | 572.1 / 762.3 / 1,013.4 | 1 (0.2%) | 2,484.5 (50.0) | 8,458 (7,454) | 3.40 | 2.1 s | 0 | 0.69 / 0.48 | 2.18 | settle, backlog |
| 250,000 | greedy | [37496763902](https://github.com/kludw/uber-simulator/actions/runs/37496763902) | Xeon Platinum 8573C | 416.1 / 525.4 / 699.5 | 0 | 2,484.5 (50.0) | 5,910 (7,454) | 2.38 | 2.1 s | 0 | 0.54 / 0.36 | 1.73 | none |
| 250,000 | greedy | [37498291450](https://github.com/kludw/uber-simulator/actions/runs/37498291450) | EPYC 9V74 | 580.0 / 763.0 / 1,509.8 | 5 (0.8%) | 2,484.5 (50.0) | 8,971 (7,453) | 3.61 | 2.1 s | 0 | 0.70 / 0.52 | 2.24 | settle, backlog |
| 250,000 | greedy | [37498301955](https://github.com/kludw/uber-simulator/actions/runs/37498301955) | Xeon Platinum 8573C | 440.7 / 555.7 / 707.8 | 0 | 2,484.5 (50.0) | 5,831 (7,454) | 2.35 | 2.0 s | 0 | 0.57 / 0.38 | 1.83 | none |
| 300,000 | greedy | [37496753667](https://github.com/kludw/uber-simulator/actions/runs/37496753667) | EPYC 9V45 | 488.8 / 611.2 / 906.4 | 0 | 2,985.5 (60.0) | 7,143 (8,957) | 2.39 | 2.1 s | 0 | 0.62 / 0.40 | 1.84 | settle |
| 300,000 | greedy | [37496763902](https://github.com/kludw/uber-simulator/actions/runs/37496763902) | EPYC 7763 | 787.1 / 1,561.6 / 2,791.1 | 53 (8.8%) | 2,974.7 (60.0) | 13,032 (8,924) | 4.38 | 2.1 s | 2 | 0.83 / 0.61 | 2.64 | settle, overruns, backlog, slow consumers |
| 35,000 | batched | [37498494906](https://github.com/kludw/uber-simulator/actions/runs/37498494906) | EPYC 9V74 | 105.9 / 350.4 / 424.5 | 0 | 346.9 (8.0) | 844 (1,041) | 2.43 | 2.0 s | 0 | 0.13 / 0.09 | 0.47 | none |
| 35,000 | batched | [37498506054](https://github.com/kludw/uber-simulator/actions/runs/37498506054) | EPYC 9V45 | 64.1 / 196.2 / 271.4 | 0 | 346.9 (8.0) | 321 (1,041) | 0.93 | 2.0 s | 0 | 0.08 / 0.07 | 0.32 | none |
| 40,000 | batched | [37498494906](https://github.com/kludw/uber-simulator/actions/runs/37498494906) | Xeon Platinum 8573C | 123.6 / 443.4 / 945.1 | 0 | 395.6 (8.0) | 1,206 (1,187) | 3.05 | 2.0 s | 0 | 0.15 / 0.09 | 0.47 | backlog |
| 40,000 | batched | [37498506054](https://github.com/kludw/uber-simulator/actions/runs/37498506054) | EPYC 7763 | 121.7 / 423.3 / 555.7 | 0 | 395.6 (8.0) | 1,224 (1,187) | 3.09 | 2.0 s | 0 | 0.15 / 0.10 | 0.50 | backlog |
| 45,000 | batched | [37498494906](https://github.com/kludw/uber-simulator/actions/runs/37498494906) | EPYC 9V45 | 95.8 / 325.9 / 395.2 | 0 | 445.1 (10.0) | 550 (1,335) | 1.24 | 2.0 s | 0 | 0.12 / 0.08 | 0.40 | none |
| 45,000 | batched | [37498506054](https://github.com/kludw/uber-simulator/actions/runs/37498506054) | EPYC 7763 | 153.4 / 530.6 / 983.1 | 0 | 445.1 (10.0) | 1,325 (1,335) | 2.98 | 2.0 s | 0 | 0.17 / 0.11 | 0.55 | none |
| 50,000 | batched | [37496888714](https://github.com/kludw/uber-simulator/actions/runs/37496888714) | EPYC 7763 | 213.0 / 990.3 / 1,063.5 | 15 (2.5%) | 492.9 (10.0) | 1,469 (1,479) | 2.98 | 2.0 s | 0 | 0.21 / 0.12 | 0.62 | settle, overruns |
| 50,000 | batched | [37496899926](https://github.com/kludw/uber-simulator/actions/runs/37496899926) | EPYC 7763 | 209.3 / 986.0 / 1,054.4 | 7 (1.2%) | 492.9 (10.0) | 1,556 (1,479) | 3.16 | 2.0 s | 0 | 0.20 / 0.12 | 0.60 | settle, overruns, backlog |
| 75,000 | batched | [37496888714](https://github.com/kludw/uber-simulator/actions/runs/37496888714) | EPYC 9V74 | 508.4 / 1,917.4 / 13,566.6 | 111 (18.5%) | 666.3 (15.9) | 2,334 (1,999) | 3.50 | 2.1 s | 1 | 0.35 / 0.14 | 0.80 | settle, overruns, backlog, slow consumers |
| 75,000 | batched | [37496899926](https://github.com/kludw/uber-simulator/actions/runs/37496899926) | EPYC 7763 | 660.3 / 1,939.2 / 13,775.7 | 164 (27.3%) | 698.8 (16.0) | 3,382 (2,097) | 4.84 | 2.1 s | 1 | 0.41 / 0.17 | 0.96 | settle, overruns, backlog, slow consumers |
| 100,000 | batched | [37496888714](https://github.com/kludw/uber-simulator/actions/runs/37496888714) | EPYC 7763 | 215.7 / 216.6 / 11,311.6 | 19 (3.2%) | 189.9 (20.0) | 9,284 (570) | 48.89 | 37.7 s | 14 | 0.74 / 0.18 | 1.33 | overruns, backlog, slow consumers |
| 100,000 | batched | [37496899926](https://github.com/kludw/uber-simulator/actions/runs/37496899926) | EPYC 9V74 | 532.9 / 2,873.4 / 8,484.0 | 100 (16.7%) | 415.2 (19.5) | 7,699 (1,246) | 18.54 | 23.4 s | 16 | 0.69 / 0.16 | 1.19 | settle, overruns, backlog, slow consumers |
| 150,000 | batched | [37498516823](https://github.com/kludw/uber-simulator/actions/runs/37498516823) | EPYC 7763 | 183.7 / 210.9 / 6,643.3 | 7 (1.2%) | 120.0 (30.0) | 5,222 (360) | 43.52 | 59.2 s | 18 | 0.71 / 0.24 | 1.42 | overruns, backlog, slow consumers |
| 200,000 | batched | [37498516823](https://github.com/kludw/uber-simulator/actions/runs/37498516823) | - | - | - | - | - | - | - | - | stack failed: persister exited |

Every run printed a report and finished 600 of 600 ticks except batched 200k (37498516823): the stack failed when the persister exited, after ClickHouse rejected its inserts with `MEMORY_LIMIT_EXCEEDED` (a server limit of 321.43-436.59 MiB, the errors' `maximum:` values) and its fetch failed with `heartbeats missed`; dispatch had spent 122 s on one `clock.ticked`. Batched dispatch's peak RSS was 12,997-13,302 MiB at 100k and 150k on the 15,989 MiB runner, so the low ClickHouse limit is presumably what the runner had left (inferred, not verified). `clock.ticked` max deviation 12.6-61.2 ms in most runs and 105.0 ms in batched 100k (37496888714), but 278.9-798.0 ms in eight greedy runs at 200k-300k and 551.4 ms in the other batched 100k run (37496899926); two of them are passing 200k runs (614.7 ms in 37496763902, 311.7 ms in 37499868521); whether the clock or the observer was late isn't separated here (the observer, at tick 1: [Clock deviation](#clock-deviation)). Peak RSS at 200k: persister 481-920 MiB, dispatch 416-423 MiB.

- **Greedy, live: 200k** (four runs on EPYC 9V45, 9V74 and two 7763, all pass every criterion; settle p95 395.2-563.5 ms). 225k passes 2 of 4 (7763 at 598.3 ms, Xeon Platinum 8573C at 510.3 ms) and fails settle in the other two (both 7763, 618.5 and 630.7 ms). 250k passes on two Xeon Platinum 8573C and fails settle and the backlog bound on a 7763 and a 9V74. 300k fails settle on a 9V45 (611.2 ms, 1.2 ms over) and settle, overruns (8.8%), backlog and slow consumers (2) on a 7763. **The milestone 18 target (45k, two runs) is met**: every run from 50k to 200k passes (12 of 12), and 45k passed twice in #210's runs (37492551889, 37492568112).
- **What fails first now (greedy): settle, set by dispatch.** `trip.matched` closes 99.8% of ticks. Dispatch's decode + handle per tick is 295-416 ms at 200k, 390-465 ms at 225k (390 on the Xeon, 449-465 on the 7763s), 471-697 ms at 300k, and grows with the fleet in both parts: decoding `drivers.moved` (137-195 ms per tick at 200k, 0.69-0.98 µs per driver per tick, against 4.8-5.1 µs per `driver.moved` message at 35k in [Cost of driver moves](#cost-of-driver-moves)) and the per-tick step (`clock.ticked` handle, 118-165 ms at 200k). Dispatch is one process: 0.41-0.54 cores at 200k, 0.69-0.83 in the failing 250k-300k runs on the 7763 and 9V74, while the counted total is at most 2.64 of the runner's 4 cores in any run. The persister's backlog fails only together with settle (250k on 7763 and 9V74, 300k on 7763: 3.40-4.38 ticks, slope 4-13 messages/s); every other greedy run stays at 1.30-2.55 ticks with slope at most 4.5/s, and every greedy run drains in 2.0-2.1 s.
- **The driver shards are not the bottleneck**: both together use 0.20-0.25 cores at 200k and 0.30-0.39 at 300k (each at most 0.20).
- **The CPU model decides near the limit, as before**: the 7763 fails settle at 225k in 2 of 3 runs and passes the third at 598.3 ms; the Xeon Platinum 8573C passes 225k and 250k (p95 510.3-555.7 ms) where the 7763 and 9V74 fail 250k (762.3-763.0 ms).
- **Batched, live: 45k.** 35k and 45k pass in two runs each (35k: EPYC 9V74 and 9V45, settle p95 350.4 and 196.2 ms); 40k fails only the backlog bound in both runs while the persister keeps up (see [What one unit of backlog now is](#what-one-unit-of-backlog-now-is)), so batched is supported at 45k but not at every size below it. 40k fails the backlog bound in both runs (1,206 and 1,224 against 1,187, 3.05-3.09 ticks) with the persister keeping up: the backlog max equals the ack pending max (every message in it is in the persister's hands, none waiting), slope 1.0-1.4 messages/s, drain 2.0 s; settle passes (p95 423.3-443.4 ms). 45k passes both runs (9V45; 7763 at 1,325 of 1,335, 99% of the limit, settle p95 530.6 ms). 50k fails settle and overruns in both runs (EPYC 7763, p95 986.0-990.3 ms, 1.2-2.5% overruns), one also the backlog bound (3.16 ticks).
- **Batched fails first on its batch ticks.** At 50k dispatch's `clock.ticked` handle averages 112-117 ms per tick, which is the batch matching run every fifth tick (about 560-585 ms per batch tick if the step's other work is small; inferred, not split by tick), and ticks are closed by `trip.picked_up` (57-60%), `trip.completed` and `trip.matched` (20% each, the batch ticks). In process ([After milestone 12](#after-milestone-12)) batched 50k already has p95 566-600 ms of work per tick, so live batched is now limited by its matching brain, not by messaging. From 75k it falls apart: p95 1.9-2.9 s, 17-27% overruns, slow consumers, and fewer events per tick as trips go unmatched (190-415 at 100k against 991 greedy); `clock.ticked` handle 623-717 ms per tick on average at 100k-150k.

### What one unit of backlog now is

ADR 0038 bounds the persister's backlog at 3 × events per tick, both counted in messages on `sim.events.>`. A `drivers.moved` message (up to 5,000 moves) counts as one event, like one `trip.matched`, so the limit is now about 3% of the fleet in messages (1,481 at 50k, 5,965 at 200k) where it was about 3 × the fleet (106-136k messages at 35-45k at milestone 17); at 40-45k, about 1.2-1.3k messages. A tick is still one second of published messages at `SPEED=1`, so the bound still means the persister is at most about 3 s of events behind.

What changed is how much of it the persister holds by design. It fetches up to 10,000 messages or until 1 s passes; below 10,000 messages per second every fetch waits the full second (fetch 799-982 ms per round and 445-586 rounds per run, greedy 50k-225k and batched 35k-50k), so a batch is about one tick of messages, and with [ADR 0044](adr/0044-persister-pipelining.md) the batch being inserted and the one being fetched are both ack pending. A persister that keeps up therefore shows about 1-2.5 ticks of backlog (greedy passing runs: 1.30-2.41), leaving about half a tick to a tick of margin regardless of its speed. Batched publishes in bursts on batch ticks, so a one-second batch can hold more than an average tick: that is how 40k batched crosses 3.05-3.09 ticks while keeping up. At milestone 17 a batch held 10,000 of 35-45k events per second, under a third of a tick, so the in-flight part was small against the bound.

### Under ADR 0046

[ADR 0046](adr/0046-persister-pending-criterion.md) (#212) replaces ADR 0038's bound: only consumer `num_pending` (published, not yet delivered to the persister) counts against 3 ticks of events; ack pending (its in-flight batches) doesn't. Reports before #212 record the sum per sample and only the run's ack pending max, so each sample's `num_pending` is known to lie in [sum - ack pending max, sum], exactly where one sample alone reaches the ack pending max. Reclassified from the reports' samples (runs of this section, [After milestone 17](#after-milestone-17) and [Persister pipelining](#persister-pipelining)):

- **Milestone 17: every verdict stands.** The seven runs that failed the backlog bound still fail it (`num_pending` at least 3.01-98.3 ticks: 37383743954 40k; 37386237720 37.5k / 40k / 45k; 37386254485 37.5k / 40k; 37388839975 37.5k); the 19 that passed still pass. Live limits: greedy 35k, batched 32.5k.
- **Milestone 18: four runs change from fail to pass on the persister bound.** Batched 40k in 37498494906 and 37498506054 (`num_pending` at most 2.46 and 2.47 ticks), batched 50k in 37496899926 (2.79; still fails settle and overruns), batched 100k in 37496888714 (1.42; still fails overruns and slow consumers). **Batched is now live at 35k, 40k and 45k** (limit unchanged, 45k); greedy stays 200k.
- **Not reclassifiable** (no sample pins `num_pending` above 0 or under the limit): greedy 250k in 37496753667 and 37498291450, 300k in 37496763902; batched 75k in 37496888714 and 37496899926, 100k in 37496899926, 150k in 37498516823 (batched 200k printed no report). Each also fails settle, overruns or slow consumers, so its overall verdict stands.

### CPU budget at the limit

Greedy 200k, the four runs above (604 s from start to stop): dispatch 0.41-0.54 cores, persister 0.28-0.38, both shards 0.20-0.25, ClickHouse 0.16-0.25, load test 0.14-0.18, NATS server 0.07-0.11, riders + clock 0.02; counted total 1.26-1.74 of 4 cores (31.5-43.5%), lowest on the 9V45 and highest on the 7763s. At milestone 17's limit (35k) the counted total was 1.78-1.90, with the NATS server at 0.55-0.57 and the persister at 0.53-0.57: the stack now runs 5.7× the fleet on less CPU. The runner has cores to spare; the limit is dispatch's per-tick work on one thread, busy 295-416 ms of each 1,000 ms tick on average at 200k.

### Against milestone 17

| | Milestone 17 ([After milestone 17](#after-milestone-17)) | Milestone 18 (this section) |
| --- | --- | --- |
| Greedy, live | 35k | 200k (4 of 4 runs); 225k 2 of 4 |
| Batched, live | 32.5k (35k fails settle) | 45k (35k and 45k pass twice; 40k fails only the backlog bound while keeping up; 50k fails settle) |
| Events per tick, greedy 200k / 35k | 35,336 at 35k | 1,988 at 200k (347 at 35k batched) |
| Fails first (greedy) | persister backlog, at the large ClickHouse merge on slower runners | settle (dispatch's per-tick work), on EPYC 7763 at 225k |
| Runner cores counted at the largest greedy pass | 1.78-1.90 (35k) | 1.26-1.74 (200k) |
| NATS server at the largest greedy pass | 0.55-0.57 cores | 0.07-0.11 cores |

Against the in-process run ([After milestone 12](#after-milestone-12), [Ceiling](#ceiling)): greedy reliably keeps real time at 50k there, in single runs up to 500k (one 200k run: p95 163 ms of work per tick). Live greedy at 200k is now 4× the in-process "reliably" size, where it was 1.4× below it at milestone 17; live settle at 200k (p95 395-564 ms) is end-to-end and includes dispatch's decode, so it doesn't compare with in-process ms of work. Batched live (45k) stays below in process (reliably 50k, ceiling between 50k and 76k), limited by the same batch matching work.

Next (proposal, no ADR): the 45k target is met. Two things set the next limits. (1) ADR 0038's bound now leaves about a tick of margin over the persister's own in-flight batches and fails batched 40k while the persister keeps up; a successor ADR could bound what isn't in flight (consumer pending only) or the age of the oldest unpersisted event, keeping the ~3 s lag meaning. (2) Greedy above 200k is limited by dispatch's single-threaded per-tick work, about half decoding `drivers.moved` and half the per-tick step; a CPU profile of dispatch at 200k would show which part to cut first. Batched needs its matching step made cheaper, in process first; its dispatch memory at 100k+ (about 12.7 GiB) is worth a look on its own.

## Batched dispatch memory

Why batched dispatch reached about 13 GiB peak RSS live at 100k-150k ([After milestone 18](#after-milestone-18)) and 3.1 GiB in process at 100k ([Ceiling](#ceiling)), and the fix, [#213](https://github.com/kludw/uber-simulator/issues/213). Measured 2026-10-06.

### Cause

- **Every batch tick built the whole queued × idle cost matrix**, as nested JS arrays (8 bytes a cell), and the Hungarian solver allocated a fresh slack and visited array of idle + 1 entries for each queued trip. Both were garbage after the tick, so the heap at the end stays small (448.7 MiB at 100k in [Ceiling](#ceiling)) while peak RSS is the high-water mark of one batch tick. Not a leak: memory O(queued × idle) per batch tick, all of it avoidable since the solver reads one row at a time.
- **In process, 100k** (local run with a temporary log line in `batchedPairs`, not committed): 613-885 queued trips against 91,082-100,000 idle drivers per batch tick, about 80 M cells, 640 MB for the matrix plus about 1.3 GB of per-row arrays per batch tick; RSS rose from 190 MiB at the first batch tick to 3,157 MiB by the sixth and stayed there.
- **Live it grows with the queue.** Dispatch falls behind on batch ticks (a `clock.ticked` takes up to 18.5 s to handle at 100k), so drivers' offer replies arrive after the offers expired: `trip.offer_expired` is 60.8-61.9% of events in the 100k runs ([37496888714](https://github.com/kludw/uber-simulator/actions/runs/37496888714), 117.6 per tick) and every expired trip goes back in the queue. 13 GiB of 8-byte cells against about 95k idle drivers is about 17k queued trips per batch tick (inferred from RSS, not logged). The kernel side of that allocation shows in dispatch's system CPU: 88.3-99.1 s per run before, 2.5-5.3 s after.

### Fix

`minCostMatching` asks the caller to fill one row of costs at a time (one column when trips outnumber drivers) and never stores the matrix; the solver allocates its per-row arrays once and tracks whether each matched pair is allowed itself. Dispatch fills a trip's row in a tight loop over drivers' cells kept as flat coordinates. Memory is O(queued + idle). Outcomes are unchanged: the batched event logs of every README `--compare` scenario (3,600 ticks, seed 42) plus a 5k picky run and a 10-driver run where trips outnumber drivers hash identically before and after.

A first version asked for one cell at a time; in paired runs ([37508820698](https://github.com/kludw/uber-simulator/actions/runs/37508820698), EPYC 9V45 and Xeon Platinum 8370C) it had the same memory but p95 +2-14% at 50k and +33-52% at 100k against master (each cell computed twice, through a call), so it was replaced by the row version.

### In process

Paired runs: master and the branch alternately on one runner, `bun run bench --matching batched`, 300 ticks, unprofiled, two rounds per size per job, two jobs, both EPYC 7763 ([37510863320](https://github.com/kludw/uber-simulator/actions/runs/37510863320), an experiment workflow on branch `213-exp-js-arrays`, same `src/` as this change).

| Drivers | Code | Peak RSS | Mean ms/tick | p95 ms/tick |
| ---: | --- | ---: | ---: | ---: |
| 50,000 | master | 908.6-980.0 MiB | 132.33-135.14 | 617.77-637.54 |
| 50,000 | #213 | 211.9-225.7 MiB | 103.02-109.80 | 481.47-511.58 |
| 100,000 | master | 3,132.0-3,719.1 MiB | 578.37-600.96 | 2,881.68-3,017.47 |
| 100,000 | #213 | 286.4-310.6 MiB | 492.94-506.77 | 2,816.06-2,925.36 |

Pair by pair, peak RSS drops 4.0-4.4× at 50k and 10.1-12.9× at 100k, and batch ticks get no slower: p95 −18% to −22% at 50k, −6% to +0% at 100k; mean −13% to −22%. Single (unpaired) master runs on other runners: 782.3-992.0 MiB at 50k and 3,118.4-3,406.5 MiB at 100k ([37505224229](https://github.com/kludw/uber-simulator/actions/runs/37505224229), [37506726656](https://github.com/kludw/uber-simulator/actions/runs/37506726656), [37508142023](https://github.com/kludw/uber-simulator/actions/runs/37508142023)).

### Live

`loadtest` workflow as in [After milestone 18](#after-milestone-18), batched, 600 ticks.

| Drivers | Code | Run | Dispatch peak RSS | Dispatch CPU s (user + system) |
| ---: | --- | --- | ---: | --- |
| 100,000 | master | [37496888714](https://github.com/kludw/uber-simulator/actions/runs/37496888714) | 13,008.6 MiB | 382.9 + 92.1 |
| 100,000 | master | [37496899926](https://github.com/kludw/uber-simulator/actions/runs/37496899926) | 12,997.4 MiB | 332.8 + 99.1 |
| 150,000 | master | [37498516823](https://github.com/kludw/uber-simulator/actions/runs/37498516823) | 13,301.9 MiB | 378.4 + 88.3 |
| 100,000 | #213 | [37512695124](https://github.com/kludw/uber-simulator/actions/runs/37512695124) | 211.2 MiB | 416.7 + 5.1 |
| 100,000 | #213 | [37512705957](https://github.com/kludw/uber-simulator/actions/runs/37512705957) | 201.9 MiB | 424.0 + 5.3 |
| 150,000 | #213 | [37512695124](https://github.com/kludw/uber-simulator/actions/runs/37512695124) | 218.5 MiB | 411.2 + 2.5 |
| 200,000 | #213 | [37514222927](https://github.com/kludw/uber-simulator/actions/runs/37514222927) | 315.6 MiB | 422.8 + 2.9 |

Dispatch peak RSS drops about 60× and no longer competes with ClickHouse for the runner's memory: batched 200k, where the stack failed at master (ClickHouse `MEMORY_LIMIT_EXCEEDED`, persister exited, [37498516823](https://github.com/kludw/uber-simulator/actions/runs/37498516823)), now runs all 600 ticks and prints a report (EPYC 9V45; fails overruns, 2.3%, and slow consumers). The verdicts don't change: batched 100k and 150k still fail overruns and slow consumers (100k also settle), because the batch matching work is still O(queued² × idle) on one thread; the batched live limit stays 45k. Making batched matching cheaper (fewer candidates per trip, or sharding dispatch, ADR 0036's follow-up) is the next step for batched, not memory.

## Clock deviation

Why `clock.ticked` inter-arrival at the load test's observer deviated by 279-798 ms in eight greedy runs at 200k-300k ([After milestone 18](#after-milestone-18)), clock or observer, [#214](https://github.com/kludw/uber-simulator/issues/214). Measured 2026-10-06.

### Method

Same `loadtest` workflow and scenario as [After milestone 18](#after-milestone-18) (greedy, 600 ticks), on a branch with temporary logging, not merged (`214-exp-clock-timing`): the clock logged each tick's due time and how late after it it published (`Date.now()`); the observer logged each `clock.ticked` receipt (`Date.now()`) and its own decode time and message count since the previous one. Same host, so both read one wall clock. Runs: [37517737209](https://github.com/kludw/uber-simulator/actions/runs/37517737209) and [37517741455](https://github.com/kludw/uber-simulator/actions/runs/37517741455), 200k / 250k / 300k each.

### Results

| Drivers | Run | CPU model | Max deviation (report) | Clock published late, max | Observer received tick 1 late | Before tick 1: messages (incl. `clock.ticked` 1), MB, observer decode ms | Observer late, ticks 3-600, max |
| ---: | --- | --- | ---: | ---: | ---: | --- | ---: |
| 200,000 | [37517737209](https://github.com/kludw/uber-simulator/actions/runs/37517737209) | Xeon 6973P-C | 6.8 ms | 5 ms | 8 ms | 200,001, 16.9, 515 | 9 ms |
| 250,000 | [37517737209](https://github.com/kludw/uber-simulator/actions/runs/37517737209) | EPYC 7763 | 767.7 ms | 30 ms | 1,162 ms | 250,001, 21.1, 1,174 | 33 ms |
| 300,000 | [37517737209](https://github.com/kludw/uber-simulator/actions/runs/37517737209) | EPYC 9V74 | 746.9 ms | 22 ms | 750 ms | 300,001, 25.4, 1,145 | 46 ms |
| 200,000 | [37517741455](https://github.com/kludw/uber-simulator/actions/runs/37517741455) | EPYC 9V74 | 12.2 ms | 12 ms | 5 ms | 200,001, 16.9, 733 | 14 ms |
| 250,000 | [37517741455](https://github.com/kludw/uber-simulator/actions/runs/37517741455) | EPYC 9V45 | 13.4 ms | 13 ms | 1 ms | 250,001, 21.1, 477 | 15 ms |
| 300,000 | [37517741455](https://github.com/kludw/uber-simulator/actions/runs/37517741455) | Xeon 6973P-C | 210.9 ms | 28 ms | 212 ms | 300,001, 25.4, 876 | 29 ms |

- **The observer was late, not the clock.** The clock published every one of the 3,600 ticks within 30 ms of its schedule (median 1 ms). The three large deviations (210.9-767.7 ms, the same range as milestone 18's 279-798 ms) are all the gap between ticks 1 and 2: the observer received tick 1 212-1,162 ms late (and tick 2 395 ms late in one run), then every later tick within 46 ms.
- **Cause: the drivers' startup burst.** Every driver publishes `driver.went_online` (tick 0) when its shard starts, one message each: 200k-300k messages (the table's count is every message the observer received up to and including `clock.ticked` 1; subjects weren't logged, so these being `driver.went_online` is inferred from the count, fleet size + 1, and about 84 B per message), 16.9-25.4 MB, all before tick 1 (the clock starts 2 s after it is spawned, alongside the shards). The observer decodes each message to read its tick, 477-1,174 ms of work, and receives `clock.ticked` 1 only after the messages ahead of it. Whether that ends before tick 1 is due depends on when the shards finish starting and on the runner, hence 3 of 6 runs.
- **Effect on the verdicts: bounded, and it didn't change these.** A late receipt of `clock.ticked` t understates tick t's settle (measured from the late receipt) and can hide an overrun of tick t - 1 (none for tick 0, which isn't counted). With ticks 1 and 2 late, that is up to two settle values and one hidden overrun (tick 1): it moves settle p95 by at most two ranks and the overrun share by at most 1/600 (0.17%); both passing 200k runs with large deviations ([37496763902](https://github.com/kludw/uber-simulator/actions/runs/37496763902): 1 overrun, p95 563.5 ms; [37499868521](https://github.com/kludw/uber-simulator/actions/runs/37499868521): 0, 531.1 ms) have far more margin, so the milestone 18 verdicts stand. A run near a limit (6 of 600 overruns, or p95 within a few ms of 610) could flip. Its batched 100k run with 551.4 ms ([37496899926](https://github.com/kludw/uber-simulator/actions/runs/37496899926), 100k `driver.went_online`) fits the same mechanism; not re-measured.
- **The observer keeps up in steady state** at 200k-300k: 108-241 ms of decoding per tick (median; p95 150-329 ms, mostly `drivers.moved`), and receipts after tick 2 within 9-46 ms of schedule.

### Report

The report now states the observer's own lateness: the most late `clock.ticked` receipt against the clock's absolute schedule ([ADR 0037](adr/0037-end-to-end-load-test.md)), anchored at the receipt closest to it, with its tick, and a `warning:` line when that is 100 ms or more (after tick 2, receipts were at most 46 ms late in these runs). It is a warning, not a criterion: a late tick 1 or 2 moves the verdicts' inputs only by the bound above, so the warning says when to check a run near a limit. The schedule is anchored at the observer's earliest receipt rather than the clock's start time, so the lateness counts from the best-case delivery, not from publish.

With it, [37519709345](https://github.com/kludw/uber-simulator/actions/runs/37519709345) (greedy, EPYC 9V74 at 200k, EPYC 7763 at 250k) reported deviations of 126.2 and 671.0 ms and named the observer's receipt of tick 1 as 132.7 and 672.6 ms late, both with the warning.
