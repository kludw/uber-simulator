# Performance baseline

Where wall time and memory go at 1k, 5k, and 10k drivers, measured 2026-10-03 at `0efef1e` ([#108](https://github.com/kludw/uber-simulator/issues/108)). Measurements only, no optimizations. Fixes come after ADR 0033.

## Method

- Command: `bun run bench` ([README](../README.md#benchmark)). One in-process run (`runInProcess`, in-memory bus, full event log kept) on a 500 × 500 grid with 2 driver shards, uniform demand at the spec ratio (10 requests/min per 100 drivers), shifts off, seed 1, and a 5-tick batch window.
- Where: GitHub Actions `bench` workflow (`.github/workflows/bench.yaml`), one `ubuntu-latest` job per case. Not the dev machine, whose load average is often 50-90.
- Machine (`machine.txt` in each artifact): 4 CPUs, 15,989 MiB, 1-minute load average 0.02-0.72 at start, Bun 1.4.2.
- Every run was CPU-profiled (`--cpu-prof --cpu-prof-md`, 1 ms sampling), so wall times include profiler overhead. Shared runners are noisy too: the two 10k greedy runs below differ by 58% in mean ms per tick (779 vs 1,231). Read the numbers as orders of magnitude.
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

- Greedy: at 10k, the mean is close to the 1 s real-time budget and p95 is over it. Cost per tick grows roughly with drivers² (1k to 10k: 107×).
- Batched: the time sits almost entirely in batch ticks (every 5th tick). In the 10-tick runs, p95 (here the slowest tick) is one batch tick: 113.5 s at 2k, 307.6 s at 3k, and 1,695 s (28 min) at 5k. That's about drivers³: 2k to 3k is 1.5³ ≈ 3.4 (measured 2.7), and 3k to 5k is (5/3)³ ≈ 4.6 (measured 5.5). A 600-tick run (120 batch ticks) at 5k or 10k can't finish. Extrapolated, one batch tick at 10k takes about 4 h.
- Batched peak RSS reached 7.6 GiB at 5k after only 10 ticks, while the heap at the end was 14 MiB. Transient allocation in the batch tick is the likely source, but these runs don't break it down.

## Top hot spots (CPU profiles, self time)

| Case | Function | Self share |
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
- Peak RSS is 3-5× the heap at the end: 3.0-3.6 GiB at 10k greedy. The likely cause is garbage from the per-report map copies above: 10k-entry maps allocated about 10k times per tick. This isn't measured separately.
- The `--heap-prof-md` snapshot from run 37147805973 is not useful. Bun takes it on exit, after the run's data is released, so it shows a 3.6 MB heap of modules and functions. Retained-object analysis needs a snapshot taken before exit (`Bun.generateHeapSnapshot()` or `heapStats().objectTypeCounts` at the end of the run), which is a small bench follow-up.

## Candidate fixes, ranked by measured impact

1. **Dispatch: stop copying `driverCells` per driver report** (96-97% of CPU at 5k-10k greedy, 83% at 1k). Options: update in place inside the brain (it already owns its state; immutability across `decide` calls is the contract, copying per message is not), or apply a tick's reports as one batch. Expected effect: greedy per-tick cost drops from O(drivers²) to O(drivers), and most peak RSS goes with it. Needs ADR 0033, because it touches the brains' immutable-state convention.
2. **Batched matching: don't pad to a square of `max(trips, drivers)`** (98.8-99.7% of CPU in every batched run; one batch tick takes 28 min at 5k, and 600 ticks at 5k or 10k don't finish). Run the Hungarian loop over the smaller side only (rows = trips: O(trips² × drivers)), and/or limit candidates to the k nearest idle drivers per trip. Expected effect: a batch tick at 10k goes from hours to roughly the cost of a greedy tick.
3. **Event log held in memory by `runInProcess`** (linear heap growth, about 2 objects per message, 0.6-0.9 GiB after 600 ticks at 10k). Let callers that only need counts or a summary (`bun run bench`, long `bun run sim` runs) consume messages as they come instead of keeping them all. Matters for 1-hour runs at 10k (several GiB); not a CPU cost.
4. **In-memory bus `queue.shift()`** (0.1-1.0% self time). O(queue) per message in the worst case; not worth changing until 1-3 are done.

Re-measure with the same workflow after each fix and add a dated section here.
