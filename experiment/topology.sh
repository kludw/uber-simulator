#!/usr/bin/env bash
# Experiment only (#238, not merged): runner topology and SMT contention.
set -u
echo "== lscpu"
lscpu
echo "== lscpu -e"
lscpu -e
echo "== siblings"
for c in /sys/devices/system/cpu/cpu[0-9]*; do
	echo "$(basename "$c"): siblings $(cat "$c/topology/thread_siblings_list"), core $(cat "$c/topology/core_id")"
done
n=${BENCH_ITERATIONS:-2000}
run() {
	echo "== $1"
	shift
	for cpu in "$@"; do
		taskset -c "$cpu" bun experiment/decode-bench.ts "$n" | sed "s/^/cpu $cpu: /" &
	done
	wait
}
sib=$(tr ',-' '  ' < /sys/devices/system/cpu/cpu0/topology/thread_siblings_list | awk '{print $2}')
core0=$(cat /sys/devices/system/cpu/cpu0/topology/core_id)
other=""
for c in 1 2 3; do
	if [ "$(cat /sys/devices/system/cpu/cpu$c/topology/core_id)" != "$core0" ]; then other=$c; break; fi
done
run "one copy" 0
if [ -n "$sib" ]; then run "two copies, SMT siblings" 0 "$sib"; fi
if [ -n "$other" ]; then run "two copies, separate cores" 0 "$other"; fi
run "four copies, every cpu" 0 1 2 3
