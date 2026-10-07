# Performance

How many drivers the simulation keeps at real time today, how that is measured, and what fails first. Every number here cites its CI run or the section of [performance-history.md](performance-history.md) that holds the full table, method and reasoning; that file keeps every measurement since milestone 9, oldest first. Last updated after milestone 22 (2026-10-07); greedy `1x1` after [#280](https://github.com/kludw/uber-simulator/issues/280) (2026-10-07).

## Current live limits

The distributed stack over NATS (`bun run loadtest`, one process per service, the persister writing to ClickHouse), at the spec ratio of demand (10 requests/min per 100 drivers), uniform demand, 2 driver shards, seed 1, 5-tick batch window, 600 ticks. A size counts when every run of it passes every criterion ([How to measure](#how-to-measure)). One dispatch process per region: `1x1` one, `2x1` two, `2x2` four ([ADR 0050](adr/0050-split-dispatch-by-region.md)).

| Matching | Regions | Limit | Runs at the limit (all pass) | Settle p95 at the limit | Next size up | Source |
| --- | --- | ---: | --- | --- | --- | --- |
| greedy | `1x1` | 500k (nothing above measured) | [37691796420](https://github.com/kludw/uber-simulator/actions/runs/37691796420), [37691799800](https://github.com/kludw/uber-simulator/actions/runs/37691799800) (one EPYC 7763, one 9V74 each); 450k passes both | 336.4-461.9 ms | not measured | [Dispatch drivers by index](performance-history.md#dispatch-drivers-by-index) |
| greedy | `1x1`, before [ADR 0052](adr/0052-driver-indexes-in-moves.md) | 400k | [37615500459](https://github.com/kludw/uber-simulator/actions/runs/37615500459), [37615511343](https://github.com/kludw/uber-simulator/actions/runs/37615511343), [37619603235](https://github.com/kludw/uber-simulator/actions/runs/37619603235), [37619610496](https://github.com/kludw/uber-simulator/actions/runs/37619610496); spot-check [37634227385](https://github.com/kludw/uber-simulator/actions/runs/37634227385), [37634246377](https://github.com/kludw/uber-simulator/actions/runs/37634246377) | 389.4-572.7 ms | 425k passes 5 of 6 (milestone 20) | [After milestone 21](performance-history.md#after-milestone-21), [After milestone 22](performance-history.md#after-milestone-22) |
| greedy | `2x1` | 375k | [37618225129](https://github.com/kludw/uber-simulator/actions/runs/37618225129), [37618229344](https://github.com/kludw/uber-simulator/actions/runs/37618229344), [37619606955](https://github.com/kludw/uber-simulator/actions/runs/37619606955), [37619614183](https://github.com/kludw/uber-simulator/actions/runs/37619614183) | 402.1-573.9 ms | 400k passes 3 of 4 | [After milestone 21](performance-history.md#after-milestone-21) |
| greedy | `2x2` | 350k | [37617113967](https://github.com/kludw/uber-simulator/actions/runs/37617113967), [37617120488](https://github.com/kludw/uber-simulator/actions/runs/37617120488) | 475.3-500.3 ms | 375k passes 1 of 2 | [After milestone 21](performance-history.md#after-milestone-21) |
| batched | `1x1` | 150k | [37634214340](https://github.com/kludw/uber-simulator/actions/runs/37634214340), [37634232557](https://github.com/kludw/uber-simulator/actions/runs/37634232557), [37638987729](https://github.com/kludw/uber-simulator/actions/runs/37638987729), [37639004246](https://github.com/kludw/uber-simulator/actions/runs/37639004246) | 317.5-503.8 ms | 175k passes 2 of 4 | [After milestone 22](performance-history.md#after-milestone-22) |
| batched | `2x1` | 225k | [37640705407](https://github.com/kludw/uber-simulator/actions/runs/37640705407), [37640714153](https://github.com/kludw/uber-simulator/actions/runs/37640714153) | 404.3-477.1 ms | 250k passes 3 of 4 | [After milestone 22](performance-history.md#after-milestone-22) |
| batched | `2x2` | 250k | [37634222904](https://github.com/kludw/uber-simulator/actions/runs/37634222904), [37634242503](https://github.com/kludw/uber-simulator/actions/runs/37634242503), [37640709376](https://github.com/kludw/uber-simulator/actions/runs/37640709376), [37640719606](https://github.com/kludw/uber-simulator/actions/runs/37640719606) | 321.4-436.0 ms | 275k passes 1 of 2; 300k-350k 2 of 4 each | [After milestone 22](performance-history.md#after-milestone-22) |

- **Greedy is highest with one dispatch process.** Splitting dispatch by region lowers its limit on this runner (400k, 375k, 350k before [ADR 0052](adr/0052-driver-indexes-in-moves.md); `1x1` now 500k, split layouts not re-measured), because every service handles each tick's moves at once on 2 physical cores ([Runner](#runner)). `2x1` 350k fails one of four runs, on a slow host, below its 375k limit ([After milestone 21](performance-history.md#after-milestone-21)).
- **Batched gains from regions**: its matching runs per region and gets cheaper as regions shrink. Batched matching is exact ([ADR 0051](adr/0051-search-untouched-drivers-in-batched-matching.md)), the same total pickup distance per batch as the dense solver ([Cheaper batched matching](performance-history.md#cheaper-batched-matching)).
- **Near the limit the verdict depends on the CPU model** of the runner a job lands on: batched `2x2` passes 350k on both EPYC 9V45 runs and fails 300k on both EPYC 7763 runs ([After milestone 22](performance-history.md#after-milestone-22)). Hence several runs per size, with the CPU model recorded per run.
- Every run at a limit finished 600 of 600 ticks with no NATS slow consumers; the persister drained in 2.0-3.1 s ([After milestone 21](performance-history.md#after-milestone-21), [After milestone 22](performance-history.md#after-milestone-22)).
- Dispatch peak RSS at the limits: greedy `1x1` 500k 519.6-534.9 MiB ([Dispatch drivers by index](performance-history.md#dispatch-drivers-by-index); 400k before ADR 0052: 418.0-422.3 MiB), `2x1` 375k 237.3-246.3 MiB per instance, `2x2` 350k 151.4-155.1 MiB ([After milestone 21](performance-history.md#after-milestone-21)); batched `1x1` 150k 200.1-202.3 MiB, `2x1` 225k 182.0-187.1 MiB, `2x2` 250k 129.2-135.3 MiB ([After milestone 22](performance-history.md#after-milestone-22)).

Runner CPU at the limits (CPU s of every process, NATS server and ClickHouse included, over the run's wall time; the runner has 4 CPUs, i.e. 2 cores):

| Matching | `1x1` | `2x1` | `2x2` | Source |
| --- | --- | --- | --- | --- |
| greedy | 1.28-1.68 (500k; 1.27-1.88 at 400k before ADR 0052) | 1.44-2.03 (375k) | 1.62-1.83 (350k) | [Dispatch drivers by index](performance-history.md#dispatch-drivers-by-index), [After milestone 21](performance-history.md#after-milestone-21), [After milestone 22](performance-history.md#after-milestone-22) |
| batched | 0.75-0.87 (150k) | 1.04-1.23 (225k) | 1.11-1.32 (250k) | [After milestone 22](performance-history.md#after-milestone-22) |

## In-process ceiling

One Bun process, in-memory bus, no NATS or ClickHouse (`bun run bench`): the brains' cost alone. Single unprofiled 300-tick runs, 2 driver shards, spec ratio, seed 1 ([Ceiling](performance-history.md#ceiling)):

- **Greedy keeps real time up to 500k**: p95 612.35 ms per tick, mean 507.94 ms ([37204837077](https://github.com/kludw/uber-simulator/actions/runs/37204837077)). One run, 2.35 ms above ADR 0036's 610 ms band, so not "reliably met". Its demand was about 11% below the spec ratio, a bug since fixed ([Request draw cap](performance-history.md#request-draw-cap)); not re-measured. Above 500k not measured.
- **Batched, before ADR 0051: between 50k and 76k.** 50k met the target in two 600-tick runs (p95 566.24-599.53 ms, [After milestone 12](performance-history.md#after-milestone-12)); 76k missed it (p95 1,290.43 ms, [37204843377](https://github.com/kludw/uber-simulator/actions/runs/37204843377)). Not re-measured on master since the cheaper solver. The spike of that solver, one 600-tick run per size, had tick p95 21.0 ms at 50k, 195.5 ms at 100k, 459.3 ms at 150k and 1,385.8 ms at 200k ([37625005993](https://github.com/kludw/uber-simulator/actions/runs/37625005993), [Cheaper batched matching](performance-history.md#cheaper-batched-matching)).

The live limits sit below the in-process ones because every service decodes its messages and all of them share the runner's CPU.

## Runner

Both CI workflows run each case on its own GitHub `ubuntu-latest` runner: 4 CPUs, about 15,990 MiB. **The 4 CPUs are 2 physical cores with 2 SMT threads each** (`lscpu` on EPYC 7763, 9V45 and Xeon 6973P-C runners, [Runner topology](performance-history.md#runner-topology)):

- A thread whose SMT sibling is busy does about 60% of the work per CPU second: one 5,000-move message decoded on two siblings at once costs 1.64-1.76× the time of one copy alone ([After milestone 21](performance-history.md#after-milestone-21), section "Why splitting dispatch doesn't help greedy here").
- Each tick's work arrives in one burst (the shards publish their moves at the start of the tick, and every service handles them), so a run average well under 4 cores doesn't mean cores to spare: at greedy `1x1` 400k every CPU is 49-50% busy on average ([After milestone 21](performance-history.md#after-milestone-21)).
- CPU models vary by job: EPYC 7763, 9V45, 9V74, Xeon Platinum 8370C, 8573C, Xeon 6973P-C. Most failures near a limit are on the EPYC 7763 ([After milestone 21](performance-history.md#after-milestone-21), [After milestone 22](performance-history.md#after-milestone-22)).
- The dev machine's load average is often 50-90: local timings only show a command works ([Method](performance-history.md#method)).
- **No larger runner is available to this repo.** It belongs to a personal account (`kludw`), and GitHub's larger runners are added by organization or enterprise owners, in a runner group ([Managing larger runners](https://docs.github.com/en/actions/how-tos/manage-runners/larger-runners/manage-larger-runners)). Load test jobs asking for `ubuntu-latest-4-cores`, `-8-cores` and `-16-cores` stayed queued for 5 min with no runner and were cancelled, while a `ubuntu-latest` job ran ([Larger runner](performance-history.md#larger-runner)).

## How to measure

### Live (`loadtest`)

Command and report: README [Load test](../README.md#load-test). In CI (one job per case, each with its own NATS and ClickHouse):

```bash
gh workflow run loadtest.yaml --ref master -f drivers="350000 400000" -f matching="greedy" -f regions="1x1 2x1"
```

`-f runner=<label>` runs the jobs on another runner (default `ubuntu-latest`). Each job's report is uploaded as an artifact (`gh run download <run id>`); its `host` line names the CPU model, and `machine.txt` adds the `lscpu` topology (cores per socket, threads per core). A size counts as supported when the slower of two runs (at least two workflow runs, so two runners) passes every criterion ([ADR 0037](adr/0037-end-to-end-load-test.md), with [ADR 0046](adr/0046-persister-pending-criterion.md)'s backlog bound in place of 0037's pending trend). The report prints a `pass` / `FAIL` line per criterion:

- at least 600 ticks at `SPEED=1`;
- settle p95 at most 610 ms (settle of tick t = last event of tick t minus `clock.ticked` t, as the observer receives them);
- overruns (an event of tick t after `clock.ticked` t+1) at most 1% of ticks;
- persister backlog: consumer `num_pending`, maximum over the second half of the 5 s samples, at most 3 ticks of events;
- the persister drains within the bound (`--drain-minutes`, default 5);
- no NATS slow consumers.

Not a criterion: the observer warns when its latest `clock.ticked` receipt is 100 ms or more late, which means settle around that tick was measured late ([Clock deviation](performance-history.md#clock-deviation), [Observer lateness](performance-history.md#observer-lateness)). In every passing run of milestone 22 it stayed at 12.2-71.8 ms ([After milestone 22](performance-history.md#after-milestone-22)).

How the limits were found: bracket upward from the last limit, two runs per size per round, then repeat sizes whose runs disagree (often split by CPU model) ([After milestone 22](performance-history.md#after-milestone-22), Method).

### In process (`bench`)

Command and report: README [Benchmark](../README.md#benchmark). In CI, unprofiled:

```bash
gh workflow run bench.yaml --ref master -f drivers=100000 -f matching=batched -f cpu_profile=false
```

Target per ADR 0036: p95 under 1,000 ms per tick, counted as reliably met only when the slower of two runs is at most 610 ms. CPU profiles (`cpu_profile=true`, the default) inflate wall time and peak RSS: they explain, they don't judge ([Method](performance-history.md#method)).

## What fails first

- **Greedy: settle, in every layout, set by CPU contention on the runner's 2 cores** during each tick's burst of moves ([After milestone 21](performance-history.md#after-milestone-21)). Since [ADR 0052](adr/0052-driver-indexes-in-moves.md), `1x1` passes 500k, the largest size measured; what fails first above it is not measured yet ([Dispatch drivers by index](performance-history.md#dispatch-drivers-by-index)). There dispatch takes 166-263 ms per tick at 450k-500k, 45-49% of it decoding and handling `drivers.moved`, the rest mostly its `clock.ticked` step (55.7-96.6 ms). Before ADR 0052 (split layouts not re-measured since): dispatch's slowest instance took 262-378 ms per tick at `1x1` 400k, mostly decoding and applying `drivers.moved`; more instances add threads to the burst, so each move costs more CPU (EPYC 7763: 0.88-0.92 µs per move at `1x1`, 1.15-1.36 at `2x1`, 1.33-1.39 at `2x2`) and every service waits longer for a CPU. Persister backlog stays at most 32% of its limit up to 475k; no slow consumers until a run falls behind (600k).
- **Batched: settle, with overruns, on batch ticks** ([After milestone 22](performance-history.md#after-milestone-22)). At `1x1` it is dispatch's one thread: its `clock.ticked` step, where the batch is solved, rises from 36.6-61.2 ms per tick at 150k to 104.8-106.4 at 200k (EPYC 7763), on top of 84.3-117.9 ms of moves, while the runner counts only 0.98-1.03 cores. Split layouts fail on the runner's 2 cores, as greedy does: failing `2x2` runs count 1.70-2.44 cores against 1.11-1.56 for passing ones. Persister backlog at most 59% of its limit.
- Not limiting at today's sizes: the persister (pipelined, [ADR 0044](adr/0044-persister-pipelining.md); [Persister pipelining](performance-history.md#persister-pipelining)), NATS slow consumers (drivers going online are published in batches, [ADR 0049](adr/0049-publish-drivers-going-online-in-batches.md); [After milestone 20](performance-history.md#after-milestone-20)).

## Next steps

Proposals from the last two re-measurements; item 1's cut of `drivers.moved` is decided in [ADR 0052](adr/0052-driver-indexes-in-moves.md), the rest has no ADR yet:

1. **More physical cores, or less CPU per tick's moves in every service.** Both greedy and batched split layouts are bound by the runner's 2 cores. Re-measure the layouts on a runner with more cores, or cut what every service spends on `drivers.moved` (the persister decodes and stores every one too; driver indexes instead of IDs, [ADR 0052](adr/0052-driver-indexes-in-moves.md), cut dispatch's decode + apply 74-80% in a micro-benchmark, [Driver indexes in moves](performance-history.md#driver-indexes-in-moves)) ([After milestone 21](performance-history.md#after-milestone-21), [After milestone 22](performance-history.md#after-milestone-22)). A larger GitHub runner needs the repo in an organization with larger runners set up ([Larger runner](performance-history.md#larger-runner)); otherwise a self-hosted runner, passed with `-f runner=<label>`.
2. **Profile batched `1x1` at 175k** to see whether the solver or the moves now dominate dispatch's thread; the batch step's cost follows how far idle drivers are from pickups ([Cheaper batched matching](performance-history.md#cheaper-batched-matching), [After milestone 22](performance-history.md#after-milestone-22)).
3. **Re-measure the in-process ceiling**: greedy 500k ran with capped demand, batched predates ADR 0051 ([In-process ceiling](#in-process-ceiling)).

## Moved sections

These sections moved to [performance-history.md](performance-history.md); accepted ADRs link to them here. Each heading links to the section.

### [Live limits](performance-history.md#live-limits)
### [The pending-trend rule at T >= 600](performance-history.md#the-pending-trend-rule-at-t--600)
### [Persister timing](performance-history.md#persister-timing)
### [After raising the batch size](performance-history.md#after-raising-the-batch-size)
### [CPU time per service](performance-history.md#cpu-time-per-service)
### [Service timing](performance-history.md#service-timing)
### [Subscriptions per service](performance-history.md#subscriptions-per-service)
### [Start-up race](performance-history.md#start-up-race)
### [Infra CPU](performance-history.md#infra-cpu)
### [Persister pipelining](performance-history.md#persister-pipelining)
### [After milestone 17](performance-history.md#after-milestone-17)
### [Cost of driver moves](performance-history.md#cost-of-driver-moves)
### [After milestone 18](performance-history.md#after-milestone-18)
### [What one unit of backlog now is](performance-history.md#what-one-unit-of-backlog-now-is)
### [Grid index tuning](performance-history.md#grid-index-tuning)
### [Dispatch profile](performance-history.md#dispatch-profile)
### [Idle drivers across ticks](performance-history.md#idle-drivers-across-ticks)
### [After milestone 19](performance-history.md#after-milestone-19)
### [Dispatch moves profile](performance-history.md#dispatch-moves-profile)
### [After milestone 20](performance-history.md#after-milestone-20)
### [After milestone 21](performance-history.md#after-milestone-21)
### [Cheaper batched matching](performance-history.md#cheaper-batched-matching)
