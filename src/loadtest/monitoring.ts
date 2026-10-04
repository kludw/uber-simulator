// NATS HTTP monitoring (https://docs.nats.io/reference/system/monitor):
// /varz for slow consumers, /connz for bytes queued per connection.
import * as z from "zod";
import type { Result } from "../shared/result.ts";

export type MonitoringFailed = {
	type: "nats_monitoring_failed";
	url: string;
	cause: unknown;
};

const Varz = z.object({ slow_consumers: z.int().nonnegative() });

const Connz = z.object({
	connections: z.array(
		z.object({
			name: z.string().optional(),
			pending_bytes: z.int().nonnegative(),
		}),
	),
});

// Clients the server has disconnected for not keeping up, since it started.
export async function readSlowConsumers(
	monitoringUrl: string,
): Promise<Result<number, MonitoringFailed>> {
	const varz = await readJson(new URL("/varz", monitoringUrl), Varz);
	if (!varz.ok) return varz;
	return { ok: true, value: varz.value.slow_consumers };
}

// Bytes queued for the named connection and the most for any one connection.
export async function readPendingBytes(
	monitoringUrl: string,
	connectionName: string,
): Promise<Result<{ named: number; anyMax: number }, MonitoringFailed>> {
	// Largest first; the default page (1024 connections) covers every service.
	const connz = await readJson(
		new URL("/connz?sort=pending", monitoringUrl),
		Connz,
	);
	if (!connz.ok) return connz;
	const { connections } = connz.value;
	return {
		ok: true,
		value: {
			named:
				connections.find((connection) => connection.name === connectionName)
					?.pending_bytes ?? 0,
			anyMax: connections[0]?.pending_bytes ?? 0,
		},
	};
}

async function readJson<T>(
	url: URL,
	schema: z.ZodType<T>,
): Promise<Result<T, MonitoringFailed>> {
	const failed = (cause: unknown): Result<never, MonitoringFailed> => ({
		ok: false,
		error: { type: "nats_monitoring_failed", url: url.href, cause },
	});
	let body: unknown;
	try {
		const response = await fetch(url);
		if (!response.ok) return failed({ status: response.status });
		body = await response.json();
	} catch (cause) {
		return failed(cause);
	}
	const parsed = schema.safeParse(body);
	if (!parsed.success) return failed(z.flattenError(parsed.error));
	return { ok: true, value: parsed.data };
}
