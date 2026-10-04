// ClickHouse adapter (ADR 0013, 0029): the only module that imports the
// client or knows the events table's column encoding. Every failure comes
// back as a Result.
import { join } from "node:path";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import type { RunId, Tick } from "../shared/messages.ts";
import type { Result } from "../shared/result.ts";

export type ClickHouseConfig = {
	url: string;
	username: string;
	password: string;
	database: string;
};

// One row of the events table. IDs are empty when the event has none.
export type EventRow = {
	runId: RunId;
	type: string;
	tick: Tick;
	streamSeq: number;
	tripId: string;
	driverId: string;
	riderId: string;
	// The full event as JSON.
	payload: string;
	ingestedAt: Date;
};

export type ClickHouse = {
	insertEvents(rows: EventRow[]): Promise<Result<void, ClickHouseError>>;
	// Rows as JSON objects, unvalidated: callers parse them. `params` bind
	// `{name:Type}` placeholders in `sql`.
	query(
		sql: string,
		params?: Record<string, unknown>,
	): Promise<Result<unknown[], ClickHouseError>>;
	// Statements without output, e.g. DDL.
	command(sql: string): Promise<Result<void, ClickHouseError>>;
	close(): Promise<void>;
};

export type ClickHouseError =
	| { type: "clickhouse_connect_failed"; url: string; cause: unknown }
	| { type: "clickhouse_request_failed"; cause: unknown };

export type MigrationFailed = {
	type: "migration_failed";
	file: string;
	cause: ClickHouseError;
};

export async function connectClickHouse(
	config: ClickHouseConfig,
): Promise<Result<ClickHouse, ClickHouseError>> {
	const client = createClient(config);
	// A query, not ping(): ping({ select: true }) checks credentials but not
	// the database; a query runs in the configured database, so a missing one
	// fails here too.
	const clickhouse = wrap(client);
	const reached = await clickhouse.command("SELECT 1");
	if (!reached.ok) {
		await client.close();
		return {
			ok: false,
			error: {
				type: "clickhouse_connect_failed",
				url: config.url,
				cause: reached.error.cause,
			},
		};
	}
	return { ok: true, value: clickhouse };
}

function wrap(client: ClickHouseClient): ClickHouse {
	return {
		insertEvents: (rows) =>
			request(async () => {
				await client.insert({
					table: "events",
					values: rows.map(toColumns),
					format: "JSONEachRow",
					// At low volume batches stay below the ~1,000 rows ClickHouse
					// wants per insert, so the server buffers them (ADR 0029). Full
					// 10,000-row batches took as long async as sync (ADR 0039).
					clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
				});
			}),
		query: (sql, params) =>
			request(async () => {
				const resultSet = await client.query({
					query: sql,
					query_params: params,
					format: "JSONEachRow",
				});
				return resultSet.json<unknown>();
			}),
		command: (sql) =>
			request(async () => {
				await client.command({ query: sql });
			}),
		close: () => client.close(),
	};
}

function toColumns(row: EventRow) {
	return {
		run_id: row.runId,
		type: row.type,
		tick: row.tick,
		stream_seq: row.streamSeq,
		trip_id: row.tripId,
		driver_id: row.driverId,
		rider_id: row.riderId,
		payload: row.payload,
		// DateTime takes unix seconds.
		ingested_at: Math.floor(row.ingestedAt.getTime() / 1000),
	};
}

// The client throws on network and server errors alike.
async function request<T>(
	send: () => Promise<T>,
): Promise<Result<T, ClickHouseError>> {
	try {
		return { ok: true, value: await send() };
	} catch (cause) {
		return { ok: false, error: { type: "clickhouse_request_failed", cause } };
	}
}

const migrationsDirectory = join(import.meta.dir, "../../infra/clickhouse");

// Applies every infra/clickhouse/*.sql file in name order, every time. Each
// file must be idempotent (IF NOT EXISTS), so rerunning is a no-op. Returns
// the files applied.
export async function migrate(
	clickhouse: Pick<ClickHouse, "command">,
): Promise<Result<string[], MigrationFailed>> {
	const files = (
		await Array.fromAsync(new Bun.Glob("*.sql").scan(migrationsDirectory))
	).toSorted();
	for (const file of files) {
		const sql = await Bun.file(join(migrationsDirectory, file)).text();
		const applied = await clickhouse.command(sql);
		if (!applied.ok) {
			return {
				ok: false,
				error: { type: "migration_failed", file, cause: applied.error },
			};
		}
	}
	return { ok: true, value: files };
}
