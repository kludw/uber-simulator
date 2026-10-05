// The infra under a load test, read from outside: the NATS server's and
// ClickHouse's CPU time, from each container's cgroup v2 cpu.stat through the
// docker CLI (https://docs.kernel.org/admin-guide/cgroup-v2.html#cpu-interface-files),
// and ClickHouse's merge work, from system.events
// (https://clickhouse.com/docs/operations/system-tables/events). cpu.stat
// counts every process in the container, cumulative since it started (the
// `cat` reading it is among them); ClickHouse's own UserTimeMicroseconds
// leaves most of its threads out (a fifth of cpu.stat's on the local stack),
// and NATS's /varz `cpu` is a percentage over the last second only, so
// neither is used.
import * as z from "zod";
import {
	type ClickHouse,
	type ClickHouseConfig,
	type ClickHouseError,
	connectClickHouse,
} from "../persistence/clickhouse.ts";
import type { Result } from "../shared/result.ts";

export type CpuTime = { userMicros: number; systemMicros: number };

// Cumulative since each container started; atMs from performance.now().
export type InfraReading = {
	atMs: number;
	natsServer: CpuTime;
	clickhouse: CpuTime;
	// Rows read by background merges, every table (system logs included).
	mergedRows: number;
};

export type InfraReadFailed =
	| { type: "docker_failed"; command: string[]; cause: unknown }
	| { type: "container_not_found"; url: string }
	| { type: "cpu_stat_unreadable"; container: string; cause: unknown }
	| { type: "merged_rows_unreadable"; cause: unknown }
	| ClickHouseError;

export type InfraReader = {
	read(): Promise<Result<InfraReading, InfraReadFailed>>;
	close(): Promise<void>;
};

// The containers are the ones publishing the NATS URL's port and ClickHouse's
// HTTP port on this host: compose.yaml's locally, the workflow's in CI.
export async function createInfraReader(infra: {
	natsUrl: string;
	clickhouse: ClickHouseConfig;
}): Promise<Result<InfraReader, InfraReadFailed>> {
	const natsServer = await findContainer(infra.natsUrl);
	if (!natsServer.ok) return natsServer;
	const clickhouse = await findContainer(infra.clickhouse.url);
	if (!clickhouse.ok) return clickhouse;
	const client = await connectClickHouse(infra.clickhouse);
	if (!client.ok) return client;
	return {
		ok: true,
		value: {
			read: async () => {
				const atMs = performance.now();
				const [natsCpu, clickhouseCpu, mergedRows] = await Promise.all([
					readContainerCpu(natsServer.value),
					readContainerCpu(clickhouse.value),
					readMergedRows(client.value),
				]);
				if (!natsCpu.ok) return natsCpu;
				if (!clickhouseCpu.ok) return clickhouseCpu;
				if (!mergedRows.ok) return mergedRows;
				return {
					ok: true,
					value: {
						atMs,
						natsServer: natsCpu.value,
						clickhouse: clickhouseCpu.value,
						mergedRows: mergedRows.value,
					},
				};
			},
			close: () => client.value.close(),
		},
	};
}

const CpuStat = z.object({
	user_usec: z.coerce.number().pipe(z.int().nonnegative()),
	system_usec: z.coerce.number().pipe(z.int().nonnegative()),
});

// cpu.stat is one "key value" pair per line.
export function parseCpuStat(
	text: string,
): Result<CpuTime, z.core.$ZodFlattenedError<unknown>> {
	const fields = Object.fromEntries(
		text
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => line.split(" ")),
	);
	const parsed = CpuStat.safeParse(fields);
	if (!parsed.success)
		return { ok: false, error: z.flattenError(parsed.error) };
	return {
		ok: true,
		value: {
			userMicros: parsed.data.user_usec,
			systemMicros: parsed.data.system_usec,
		},
	};
}

const defaultPorts: Record<string, string> = {
	"nats:": "4222",
	"http:": "80",
	"https:": "443",
};

// The running container publishing the URL's port on this host.
async function findContainer(
	url: string,
): Promise<Result<string, InfraReadFailed>> {
	const { port, protocol } = new URL(url);
	const published = port === "" ? defaultPorts[protocol] : port;
	if (published === undefined) {
		return { ok: false, error: { type: "container_not_found", url } };
	}
	const ids = await docker([
		"ps",
		"--quiet",
		"--filter",
		`publish=${published}`,
	]);
	if (!ids.ok) return ids;
	const [id] = ids.value.split("\n").filter((line) => line !== "");
	if (id === undefined) {
		return { ok: false, error: { type: "container_not_found", url } };
	}
	return { ok: true, value: id };
}

async function readContainerCpu(
	container: string,
): Promise<Result<CpuTime, InfraReadFailed>> {
	const text = await docker([
		"exec",
		container,
		"cat",
		"/sys/fs/cgroup/cpu.stat",
	]);
	if (!text.ok) return text;
	const cpu = parseCpuStat(text.value);
	if (!cpu.ok) {
		return {
			ok: false,
			error: { type: "cpu_stat_unreadable", container, cause: cpu.error },
		};
	}
	return cpu;
}

// UInt64 comes back as a JSON string (ClickHouse's default quoting).
const MergedRows = z.tuple([
	z.object({ value: z.coerce.number().pipe(z.int().nonnegative()) }),
]);

async function readMergedRows(
	clickhouse: ClickHouse,
): Promise<Result<number, InfraReadFailed>> {
	const rows = await clickhouse.query(
		"SELECT value FROM system.events WHERE event = 'MergedRows'",
	);
	if (!rows.ok) return rows;
	// No row until the server's first merge.
	if (rows.value.length === 0) return { ok: true, value: 0 };
	const parsed = MergedRows.safeParse(rows.value);
	if (!parsed.success) {
		return {
			ok: false,
			error: {
				type: "merged_rows_unreadable",
				cause: z.flattenError(parsed.error),
			},
		};
	}
	return { ok: true, value: parsed.data[0].value };
}

async function docker(
	args: string[],
): Promise<Result<string, InfraReadFailed>> {
	const command = ["docker", ...args];
	const failed = (cause: unknown): Result<never, InfraReadFailed> => ({
		ok: false,
		error: { type: "docker_failed", command, cause },
	});
	try {
		const subprocess = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(subprocess.stdout).text(),
			new Response(subprocess.stderr).text(),
			subprocess.exited,
		]);
		if (code !== 0) return failed({ code, stderr });
		return { ok: true, value: stdout };
	} catch (cause) {
		// Bun.spawn throws when the executable isn't found.
		return failed(cause);
	}
}
