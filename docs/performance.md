# Performance

How many drivers the simulation keeps at real time today, how that is measured, and what fails first. Every number here cites its CI run or the section of [performance-history.md](performance-history.md) that holds the full table, method and reasoning; that file keeps every measurement since milestone 9, oldest first. Last updated after milestone 25 (2026-10-07); batched `2x1` and `2x2` after milestone 22.

## Current live limits

The distributed stack over NATS (`bun run loadtest`, one process per service, the persister writing to ClickHouse), at the spec ratio of demand (10 requests/min per 100 drivers), uniform demand, 2 driver shards, seed 1, 5-tick batch window, 600 ticks. A size counts when every run of it passes every criterion ([How to measure](#how-to-measure)). One dispatch process per region: `1x1` one, `2x1` two, `2x2` four ([ADR 0050](adr/0050-split-dispatch-by-region.md)).

| Matching | Regions | Limit | Runs at the limit (all pass) | Settle p95 at the limit | Next size up | Source |
| --- | --- | ---: | --- | --- | --- | --- |
| greedy | `1x1` | 600k | [37695300688](https://github.com/kludw/uber-simulator/actions/runs/37695300688), [37695312723](https://github.com/kludw/uber-simulator/actions/runs/37695312723), [37696636144](https://github.com/kludw/uber-simulator/actions/runs/37696636144), [37696642754](https://github.com/kludw/uber-simulator/actions/runs/37696642754) (two EPYC 7763, two 9V45) | 344.5-572.0 ms | 650k passes 4 of 5; 700k 4 of 7 (fails on every EPYC 7763) | [After milestone 25](performance-history.md#after-milestone-25) |
| greedy | `2x1` | 600k (spot-check) | [37696671993](https://github.com/kludw/uber-simulator/actions/runs/37696671993), [37696675334](https://github.com/kludw/uber-simulator/actions/runs/37696675334) | 450.2-584.0 ms | 700k passes 0 of 2 | [After milestone 25](performance-history.md#after-milestone-25) |
| greedy | `2x2` | 500k (spot-check) | [37696671993](https://github.com/kludw/uber-simulator/actions/runs/37696671993), [37696675334](https://github.com/kludw/uber-simulator/actions/runs/37696675334) | 471.9-472.9 ms | 600k passes 1 of 2 | [After milestone 25](performance-history.md#after-milestone-25) |
| batched | `1x1` | 150k | [37695303649](https://github.com/kludw/uber-simulator/actions/runs/37695303649), [37695315799](https://github.com/kludw/uber-simulator/actions/runs/37695315799), [37697995190](https://github.com/kludw/uber-simulator/actions/runs/37697995190), [37698001536](https://github.com/kludw/uber-simulator/actions/runs/37698001536) | 274.9-406.6 ms | 175k passes 3 of 4; 200k 2 of 2 (no EPYC 7763) | [After milestone 25](performance-history.md#after-milestone-25) |
| batched | `2x1`, before [ADR 0052](adr/0052-driver-indexes-in-moves.md) | 225k | [37640705407](https://github.com/kludw/uber-simulator/actions/runs/37640705407), [37640714153](https://github.com/kludw/uber-simulator/actions/runs/37640714153) | 404.3-477.1 ms | 250k passes 3 of 4 | [After milestone 22](performance-history.md#after-milestone-22) |
| batched | `2x2`, before [ADR 0052](adr/0052-driver-indexes-in-moves.md) | 250k | [37634222904](https://github.com/kludw/uber-simulator/actions/runs/37634222904), [37634242503](https://github.com/kludw/uber-simulator/actions/runs/37634242503), [37640709376](https://github.com/kludw/uber-simulator/actions/runs/37640709376), [37640719606](https://github.com/kludw/uber-simulator/actions/runs/37640719606) | 321.4-436.0 ms | 275k passes 1 of 2; 300k-350k 2 of 4 each | [After milestone 22](performance-history.md#after-milestone-22) |

- **Greedy is highest with one dispatch process, and splitting no longer costs much.** Since [ADR 0052](adr/0052-driver-indexes-in-moves.md) every layout gained (`1x1` 400k to 600k, `2x1` 375k to at least 600k, `2x2` 350k to at least 500k); `2x1` fails 700k on an EPYC 9V74 where `1x1` passes it. Split layouts are spot-checks (two runs per size, sizes between not run) ([After milestone 25](performance-history.md#after-milestone-25)).
- **Batched gains from regions**: its matching runs per region and gets cheaper as regions shrink. Batched matching is exact ([ADR 0051](adr/0051-search-untouched-drivers-in-batched-matching.md)), the same total pickup distance per batch as the dense solver ([Cheaper batched matching](performance-history.md#cheaper-batched-matching)). Batched split layouts are not re-measured since ADR 0052.
- **Near the limit the verdict depends on the CPU model** of the runner a job lands on: greedy `1x1` 700k passes on EPYC 9V45, 9V74 and Xeon 8573C runs and fails on all three EPYC 7763 runs ([After milestone 25](performance-history.md#after-milestone-25)); batched `2x2` passes 350k on both EPYC 9V45 runs and fails 300k on both EPYC 7763 runs ([After milestone 22](performance-history.md#after-milestone-22)). Hence several runs per size, with the CPU model recorded per run.
- Every run at a limit finished 600 of 600 ticks with no NATS slow consumers; the persister drained in 2.0-3.1 s ([After milestone 22](performance-history.md#after-milestone-22), [After milestone 25](performance-history.md#after-milestone-25)).
- Dispatch peak RSS at the limits: greedy `1x1` 600k 593.3-614.7 MiB, `2x1` 600k 368.6-386.7 MiB per instance, `2x2` 500k 212.5-222.5 MiB, batched `1x1` 150k 208.6-213.0 MiB ([After milestone 25](performance-history.md#after-milestone-25)); batched `2x1` 225k 182.0-187.1 MiB, `2x2` 250k 129.2-135.3 MiB ([After milestone 22](performance-history.md#after-milestone-22)).

Runner CPU at the limits (CPU s of every process, NATS server and ClickHouse included, over the run's wall time; the runner has 4 CPUs, i.e. 2 cores):

| Matching | `1x1` | `2x1` | `2x2` | Source |
| --- | --- | --- | --- | --- |
| greedy | 1.31-1.96 (600k) | 1.59-2.09 (600k) | 1.74-1.75 (500k) | [After milestone 25](performance-history.md#after-milestone-25) |
| batched | 0.57-0.60 (150k) | 1.04-1.23 (225k, before ADR 0052) | 1.11-1.32 (250k, before ADR 0052) | [After milestone 25](performance-history.md#after-milestone-25), [After milestone 22](performance-history.md#after-milestone-22) |

## In-process ceiling

One Bun process, in-memory bus, no NATS or ClickHouse (`bun run bench`): the brains' cost alone. Single unprofiled 300-tick runs, 2 driver shards, spec ratio, seed 1 ([Ceiling](performance-history.md#ceiling)):

- **Greedy keeps real time up to 500k**: p95 612.35 ms per tick, mean 507.94 ms ([37204837077](https://github.com/kludw/uber-simulator/actions/runs/37204837077)). One run, 2.35 ms above ADR 0036's 610 ms band, so not "reliably met". Its demand was about 11% below the spec ratio, a bug since fixed ([Request draw cap](performance-history.md#request-draw-cap)); not re-measured. Above 500k not measured.
- **Batched, before ADR 0051: between 50k and 76k.** 50k met the target in two 600-tick runs (p95 566.24-599.53 ms, [After milestone 12](performance-history.md#after-milestone-12)); 76k missed it (p95 1,290.43 ms, [37204843377](https://github.com/kludw/uber-simulator/actions/runs/37204843377)). Not re-measured on master since the cheaper solver. The spike of that solver, one 600-tick run per size, had tick p95 21.0 ms at 50k, 195.5 ms at 100k, 459.3 ms at 150k and 1,385.8 ms at 200k ([37625005993](https://github.com/kludw/uber-simulator/actions/runs/37625005993), [Cheaper batched matching](performance-history.md#cheaper-batched-matching)).

These in-process numbers are older than the live ones and no longer bound them: live greedy `1x1` keeps up at 600k, above the 500k largest in-process size, and live batched at 150k, above the pre-ADR 0051 in-process range (next step 4 re-measures them).

## Runner

Both CI workflows run each case on its own GitHub `ubuntu-latest` runner: 4 CPUs, about 15,990 MiB. **The 4 CPUs are 2 physical cores with 2 SMT threads each** (`lscpu` on EPYC 7763, 9V45 and Xeon 6973P-C runners, [Runner topology](performance-history.md#runner-topology)):

- A thread whose SMT sibling is busy does about 60% of the work per CPU second: one 5,000-move message decoded on two siblings at once costs 1.64-1.76× the time of one copy alone ([After milestone 21](performance-history.md#after-milestone-21), section "Why splitting dispatch doesn't help greedy here").
- Each tick's work arrives in one burst (the shards publish their moves at the start of the tick, and every service handles them), so a run average well under 4 cores doesn't mean cores to spare: at greedy `1x1` 400k every CPU is 49-50% busy on average ([After milestone 21](performance-history.md#after-milestone-21)).
- CPU models vary by job: EPYC 7763, 9V45, 9V74, Xeon Platinum 8370C, 8573C, Xeon 6973P-C. Most failures near a limit are on the EPYC 7763: greedy `1x1` 700k fails on all three 7763 runs and passes on the other models ([After milestone 21](performance-history.md#after-milestone-21), [After milestone 22](performance-history.md#after-milestone-22), [After milestone 25](performance-history.md#after-milestone-25)).
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

Not a criterion: the observer warns when its latest `clock.ticked` receipt is 100 ms or more late, which means settle around that tick was measured late ([Clock deviation](performance-history.md#clock-deviation), [Observer lateness](performance-history.md#observer-lateness)). In every passing run of milestone 22 it stayed at 12.2-71.8 ms ([After milestone 22](performance-history.md#after-milestone-22)); in milestone 25's passing runs 8.3-100.5 ms, one 700k run reaching the warning ([After milestone 25](performance-history.md#after-milestone-25)).

How the limits were found: bracket upward from the last limit, two runs per size per round, then repeat sizes whose runs disagree (often split by CPU model) ([After milestone 22](performance-history.md#after-milestone-22), Method).

### In process (`bench`)

Command and report: README [Benchmark](../README.md#benchmark). In CI, unprofiled:

```bash
gh workflow run bench.yaml --ref master -f drivers=100000 -f matching=batched -f cpu_profile=false
```

Target per ADR 0036: p95 under 1,000 ms per tick, counted as reliably met only when the slower of two runs is at most 610 ms. CPU profiles (`cpu_profile=true`, the default) inflate wall time and peak RSS: they explain, they don't judge ([Method](performance-history.md#method)).

## What fails first

- **Greedy: settle, in every layout, set by CPU contention on the runner's 2 cores** ([After milestone 25](performance-history.md#after-milestone-25)). Failing `1x1` runs (650k-800k) count 2.10-2.82 runner cores against 1.31-1.96 for passing 600k runs, and most failing runs (7 of 10, one passing 700k run too) see the observer's `clock.ticked` arrive 100 ms or more late: the runner as a whole looks saturated rather than one service (inferred, not profiled per CPU). The driver shards are the largest CPU user, as at 400k-500k (0.50-0.67 cores together at 600k, dispatch 0.19-0.30, persister 0.18-0.27). Dispatch's tick is split about evenly: at 600k on the EPYC 7763, `drivers.moved` decode + handle 136.5-137.6 ms, the `clock.ticked` step (greedy matching) 123.6-128.6 ms; to 800k the moves grow 1.4x, the `clock.ticked` step 2x (wall time, including waiting for a CPU). Persister backlog at most 29% of its limit up to 800k; no slow consumers in any run.
- **Batched: settle, with overruns, on batch ticks.** At `1x1` it is dispatch's batch step on the slowest CPU model: 175k fails on an EPYC 7763 run whose `clock.ticked` step took 86.7 ms per tick against 49.8-54.6 in the passing 7763 runs, while moves at 150k-175k fell to 22-36 ms per tick and the runner counts 0.50-0.70 cores ([After milestone 25](performance-history.md#after-milestone-25)). Split layouts (before ADR 0052) fail on the runner's 2 cores, as greedy does: failing `2x2` runs count 1.70-2.44 cores against 1.11-1.56 for passing ones ([After milestone 22](performance-history.md#after-milestone-22)).
- Not limiting at today's sizes: the persister (pipelined, [ADR 0044](adr/0044-persister-pipelining.md); [Persister pipelining](performance-history.md#persister-pipelining)), NATS slow consumers (drivers going online are published in batches, [ADR 0049](adr/0049-publish-drivers-going-online-in-batches.md); [After milestone 20](performance-history.md#after-milestone-20)).

## Next steps

Proposals from the last re-measurements, no ADR yet:

1. **More physical cores, or less CPU per tick in every service.** Greedy in every layout and batched split layouts are bound by the runner's 2 cores ([After milestone 25](performance-history.md#after-milestone-25), [After milestone 22](performance-history.md#after-milestone-22)). The driver shards are the largest CPU user: profile them at 600k-700k, and greedy dispatch's `clock.ticked` step, which grows faster than the moves. A larger GitHub runner needs the repo in an organization with larger runners set up ([Larger runner](performance-history.md#larger-runner)); otherwise a self-hosted runner, passed with `-f runner=<label>`.
2. **Profile batched `1x1` at 175k**: its batch step now dominates dispatch's thread (moves fell to 22-36 ms per tick at 150k-175k); the batch step's cost follows how far idle drivers are from pickups ([Cheaper batched matching](performance-history.md#cheaper-batched-matching), [After milestone 25](performance-history.md#after-milestone-25)).
3. **Re-measure batched `2x1` and `2x2`**, last measured before ADR 0052, and bracket greedy `2x1` / `2x2` between their spot-checks ([After milestone 25](performance-history.md#after-milestone-25)).
4. **Re-measure the in-process ceiling**: greedy 500k ran with capped demand, batched predates ADR 0051 ([In-process ceiling](#in-process-ceiling)).

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
