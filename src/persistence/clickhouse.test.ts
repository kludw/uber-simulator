import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseClickHouseConfig } from "../sim/config.ts";
import {
	type ClickHouse,
	connectClickHouse,
	type EventRow,
	migrate,
} from "./clickhouse.ts";

describe("connectClickHouse", () => {
	test("reports an unreachable server", async () => {
		// Nothing listens on port 1.
		const connected = await connectClickHouse({
			url: "http://127.0.0.1:1",
			username: "sim",
			password: "sim",
			database: "sim",
		});

		expect(connected).toMatchObject({
			ok: false,
			error: { type: "clickhouse_connect_failed", url: "http://127.0.0.1:1" },
		});
	});
});

// CLICKHOUSE_* from .env (Bun loads it) or the environment. Each run works in
// its own throwaway database, so it never touches the configured one's data.
const config = Bun.env.CLICKHOUSE_URL ? parseClickHouseConfig(Bun.env) : null;
if (!config) {
	console.warn("CLICKHOUSE_URL unset: skipping ClickHouse integration tests");
}

describe.skipIf(!config)("ClickHouse", () => {
	const testDatabase = `test_${crypto.randomUUID().replaceAll("-", "")}`;
	let admin: ClickHouse;
	let clickhouse: ClickHouse;

	beforeAll(async () => {
		if (!config?.ok) throw new Error("invalid ClickHouse config");
		admin = await connected(config.value);
		await succeeded(admin.command(`CREATE DATABASE ${testDatabase}`));
		clickhouse = await connected({ ...config.value, database: testDatabase });
	});

	afterAll(async () => {
		await clickhouse?.close();
		await admin?.command(`DROP DATABASE IF EXISTS ${testDatabase}`);
		await admin?.close();
	});

	const row: EventRow = {
		runId: "run-1",
		type: "driver.moved",
		tick: 7,
		streamSeq: 42,
		tripId: "",
		driverId: "d-1",
		riderId: "",
		payload: '{"type":"driver.moved"}',
		ingestedAt: new Date("2026-10-03T12:34:56Z"),
	};

	test("events inserted after migrating read back", async () => {
		await succeeded(migrate(clickhouse));
		await succeeded(clickhouse.insertEvents([row]));

		const read = await clickhouse.query(
			`SELECT run_id, type, tick, stream_seq, trip_id, driver_id, rider_id,
				payload, toUnixTimestamp(ingested_at) AS ingested_at
			FROM events FINAL`,
		);

		expect(read).toEqual({
			ok: true,
			value: [
				{
					run_id: "run-1",
					type: "driver.moved",
					tick: 7,
					stream_seq: 42,
					trip_id: "",
					driver_id: "d-1",
					rider_id: "",
					payload: '{"type":"driver.moved"}',
					ingested_at: 1791030896,
				},
			],
		});
	});

	test("migrating again keeps the table and its events", async () => {
		await succeeded(migrate(clickhouse));
		await succeeded(clickhouse.insertEvents([{ ...row, runId: "run-2" }]));

		const rerun = await migrate(clickhouse);
		const read = await clickhouse.query(
			"SELECT run_id FROM events FINAL WHERE run_id = {runId:String}",
			{ runId: "run-2" },
		);

		expect({ rerun, read }).toEqual({
			rerun: { ok: true, value: ["001_events.sql"] },
			read: { ok: true, value: [{ run_id: "run-2" }] },
		});
	});

	test("a failed query is a request error", async () => {
		expect(await clickhouse.query("SELECT * FROM no_such_table")).toMatchObject(
			{ ok: false, error: { type: "clickhouse_request_failed" } },
		);
	});

	test("wrong credentials fail to connect", async () => {
		if (!config?.ok) throw new Error("invalid ClickHouse config");
		const url = config.value.url;

		expect(
			await connectClickHouse({ ...config.value, password: "wrong" }),
		).toMatchObject({
			ok: false,
			error: { type: "clickhouse_connect_failed", url },
		});
	});
});

async function connected(
	config: Parameters<typeof connectClickHouse>[0],
): Promise<ClickHouse> {
	const result = await connectClickHouse(config);
	if (!result.ok) throw new Error("connect failed", { cause: result.error });
	return result.value;
}

async function succeeded<T>(
	pending: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>,
): Promise<T> {
	const result = await pending;
	if (!result.ok) throw new Error("ClickHouse call failed", { cause: result });
	return result.value;
}
