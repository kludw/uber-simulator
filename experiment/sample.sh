#!/usr/bin/env bash
# Experiment only (#238, not merged): every 10 s, each bun process's
# /proc/<pid>/schedstat (ns on CPU, ns waiting on a run queue, timeslices)
# and the per-CPU lines of /proc/stat. Also the nats-server and clickhouse
# processes.
while true; do
	now=$(date +%s)
	for p in $(pgrep -x bun; pgrep -x nats-server; pgrep -f clickhouse-server | head -1); do
		[ -r "/proc/$p/schedstat" ] || continue
		cmd=$(tr '\0' ' ' < "/proc/$p/cmdline" | cut -c1-60)
		idx=$(tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -E '^(REGION_INDEX|SHARD_INDEX)=' | tr '\n' ' ')
		echo "proc $now $p [$cmd] [$idx] $(cat "/proc/$p/schedstat")"
	done
	grep '^cpu' /proc/stat | sed "s/^/stat $now /"
	sleep 10
done
