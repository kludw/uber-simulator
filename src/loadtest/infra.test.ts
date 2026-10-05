import { describe, expect, test } from "bun:test";
import { parseCpuStat } from "./infra.ts";

describe("parseCpuStat", () => {
	test("reads a container's cumulative user and system CPU from cgroup v2 cpu.stat", () => {
		const cpuStat = [
			"usage_usec 660393348",
			"user_usec 368083696",
			"system_usec 292309651",
			"nice_usec 0",
			"nr_periods 0",
			"nr_throttled 0",
			"throttled_usec 0",
			"",
		].join("\n");
		expect(parseCpuStat(cpuStat)).toEqual({
			ok: true,
			value: { userMicros: 368_083_696, systemMicros: 292_309_651 },
		});
	});

	test("a cpu.stat without user and system time (cgroup v1) is not read", () => {
		expect(parseCpuStat("usage 123\n").ok).toBe(false);
	});
});
