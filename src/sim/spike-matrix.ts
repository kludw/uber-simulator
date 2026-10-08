// usage: bun matrix.ts KEY=VAL ... ; runs scenarios x matchings in the worktree.
const root =
	"/Users/kamil/Documents/repos/uber-simulator/.claude/worktrees/agent-a796f862e4a810765";
const extraEnv = Object.fromEntries(
	Bun.argv.slice(2).map((kv) => kv.split("=") as [string, string]),
);
const scenarios: Record<string, string[]> = {
	spec: ["--seed", "42", "--ticks", "3600"],
	cityspec: ["--seed", "42", "--ticks", "3600", "--demand", "city"],
	heavy: [
		"--seed", "42", "--ticks", "3600", "--demand", "city",
		"--requests-per-minute", "30", "--drivers-per-shard", "25",
	],
	busy: ["--seed", "42", "--ticks", "3600", "--demand", "city", "--requests-per-minute", "20"],
	heavy2x2: [
		"--seed", "42", "--ticks", "3600", "--demand", "city",
		"--requests-per-minute", "30", "--drivers-per-shard", "25", "--regions", "2x2",
	],
};
const only = process.env.ONLY?.split(",");
const jobs = [];
for (const [name, args] of Object.entries(scenarios)) {
	if (only && !only.includes(name)) continue;
	for (const matching of ["greedy", "batched"]) {
		jobs.push(
			(async () => {
				const proc = Bun.spawn(
					["bun", "src/sim/main.ts", ...args, "--matching", matching],
					{ cwd: root, env: { ...process.env, SPIKE_PRINT: "1", ...extraEnv }, stdout: "pipe" },
				);
				const out = await new Response(proc.stdout).text();
				const get = (label: string) =>
					out.split("\n").find((l) => l.startsWith(label))?.split(": ")[1];
				const spike = JSON.parse(
					out.split("\n").find((l) => l.startsWith("SPIKE"))?.slice(6) ?? "{}",
				);
				return `${name.padEnd(9)} ${matching.padEnd(7)} req=${get("trips requested")} comp=${get("trips completed")} canc=${get("trips cancelled")} declined=${spike.declined} pickup=${get("mean ticks")} rev=$${(spike.revenue / 100).toFixed(0)} rev/trip=$${(spike.revenue / 100 / Number(get("trips completed"))).toFixed(2)} meanQuote=${spike.meanQuoted?.toFixed(2)} surgedReq=${spike.surgedRequests} viol=${get("invariant violations")}`;
			})(),
		);
	}
}
for (const line of await Promise.all(jobs)) console.log(line);
