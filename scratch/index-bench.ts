// #268 experiment, not merged: cost of one tick of drivers.moved for its
// consumers, today's shape (ADR 0047, one-pass Zod, regions) against driver
// indexes instead of IDs. Single process, no NATS, every driver moves one
// cell per tick, 2 shards, chunks of 5,000, one region (1x1).
// Usage: bun scratch/index-bench.ts [drivers] [ticks]
import * as z from "zod";
import { decideDispatch, startDispatch } from "../src/dispatch/brain.ts";
import { type Coordinate, cellAt, specGrid } from "../src/shared/grid.ts";
import {
	DriverId,
	type DriversMoved,
	driversMoved,
	driversWentOnline,
	forEachMove,
	parseMessage,
} from "../src/shared/messages.ts";
import { createRandom } from "../src/shared/random.ts";
import { Region } from "../src/shared/regions.ts";

const fleet = Number(process.argv[2] ?? 400_000);
const ticks = Number(process.argv[3] ?? 30);
const shards = 2;
const perChunk = 5_000;
const random = createRandom(1);
const grid = specGrid;
const region = Region.parse(0);

// IDs as the shards make them (src/sim/services.ts).
const idWidth = String(fleet - 1).length;
const driverIdAt = (index: number) =>
	`d-${String(index).padStart(idWidth, "0")}` as DriverId;
const ids = Array.from({ length: fleet }, (_, i) => DriverId.parse(driverIdAt(i)));
const xs = Int32Array.from(ids, () => random.int(0, grid.width - 1));
const ys = Int32Array.from(ids, () => random.int(0, grid.height - 1));
const perShard = fleet / shards;

function step(i: number): void {
	const delta = random.int(0, 1) * 2 - 1;
	if (random.int(0, 1) === 0)
		xs[i] = Math.min(grid.width - 1, Math.max(0, (xs[i] ?? 0) + delta));
	else ys[i] = Math.min(grid.height - 1, Math.max(0, (ys[i] ?? 0) + delta));
}

const cellOf = (i: number) => cellAt(xs[i] as Coordinate, ys[i] as Coordinate);
const online: string[] = [];
for (let shard = 0; shard < shards; shard++) {
	for (let start = shard * perShard; start < (shard + 1) * perShard; start += perChunk) {
		const entries = [];
		for (let i = start; i < Math.min(start + perChunk, (shard + 1) * perShard); i++) {
			entries.push({ driverId: ids[i] as DriverId, cell: cellOf(i) });
		}
		online.push(JSON.stringify(driversWentOnline(0 as never, region, entries)));
	}
}

// Payloads per tick, as received: today's and the index shape.
const now: string[][] = [];
const indexed: string[][] = [];
for (let tick = 1; tick <= ticks; tick++) {
	const tickNow: string[] = [];
	const tickIndexed: string[] = [];
	for (let i = 0; i < fleet; i++) step(i);
	for (let shard = 0; shard < shards; shard++) {
		const end = (shard + 1) * perShard;
		for (let start = shard * perShard; start < end; start += perChunk) {
			const moves = [];
			const driverIndexes: number[] = [];
			for (let i = start; i < Math.min(start + perChunk, end); i++) {
				moves.push({ driverId: ids[i] as DriverId, cell: cellOf(i) });
				driverIndexes.push(i);
			}
			tickNow.push(JSON.stringify(driversMoved(tick as never, region, moves)));
			tickIndexed.push(
				JSON.stringify({
					type: "drivers.moved",
					tick,
					region,
					fleet,
					driverIndexes,
					xs: moves.map((move) => move.cell.x),
					ys: moves.map((move) => move.cell.y),
				}),
			);
		}
	}
	now.push(tickNow);
	indexed.push(tickIndexed);
}

// Index shape, checked as messages.ts checks today's arrays: one pass per
// array, plus one across them (lengths, every index below fleet).
const isCount = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
const Counts = z.custom<number[]>((a) => Array.isArray(a) && a.every(isCount));
const IndexedMoved = z
	.object({
		type: z.literal("drivers.moved"),
		tick: z.int().nonnegative(),
		region: z.int().nonnegative(),
		fleet: z.int().positive(),
		driverIndexes: Counts,
		xs: Counts,
		ys: Counts,
	})
	.refine(
		(m) =>
			m.xs.length === m.driverIndexes.length &&
			m.ys.length === m.driverIndexes.length &&
			m.driverIndexes.every((i) => i < m.fleet),
	);
type IndexedMoved = z.infer<typeof IndexedMoved>;

// One table of IDs per fleet, filled on first use: what a reader that wants
// IDs (UI, invariant checker) would pay per move.
const idTable: (DriverId | undefined)[] = new Array(fleet);
const idOf = (index: number): DriverId => {
	let id = idTable[index];
	if (id === undefined) {
		id = driverIdAt(index);
		idTable[index] = id;
	}
	return id;
};

// Prototype of dispatch's placeDriver (idle-drivers.ts, one region, every
// driver idle) with its records keyed two ways: by DriverId in a Map (today)
// and by index in an array (option). Same record, same bucket upkeep.
type Driver = { x: number; y: number; bucket: number; slot: number };
const size = 8;
const columns = Math.ceil(grid.width / size);
const rows = Math.ceil(grid.height / size);
const bucketOf = (x: number, y: number) =>
	Math.min(Math.floor(y / size), rows - 1) * columns +
	Math.min(Math.floor(x / size), columns - 1);
function makeIndex() {
	return {
		buckets: Array.from({ length: columns * rows }, (): Driver[] => []),
	};
}
type Index = ReturnType<typeof makeIndex>;
function add(index: Index, driver: Driver): void {
	driver.bucket = bucketOf(driver.x, driver.y);
	const bucket = index.buckets[driver.bucket] as Driver[];
	driver.slot = bucket.length;
	bucket.push(driver);
}
function remove(index: Index, driver: Driver): void {
	const bucket = index.buckets[driver.bucket] as Driver[];
	const last = bucket.pop() as Driver;
	if (last !== driver) {
		bucket[driver.slot] = last;
		last.slot = driver.slot;
	}
}
const byId = new Map<DriverId, Driver>();
const byIdIndex = makeIndex();
function placeById(driverId: DriverId, x: number, y: number): void {
	const driver = byId.get(driverId);
	if (driver === undefined) {
		const placed = { x, y, bucket: -1, slot: 0 };
		byId.set(driverId, placed);
		add(byIdIndex, placed);
		return;
	}
	driver.x = x;
	driver.y = y;
	if (bucketOf(x, y) === driver.bucket) return;
	remove(byIdIndex, driver);
	add(byIdIndex, driver);
}
const byIndex: (Driver | undefined)[] = [];
const byIndexIndex = makeIndex();
function placeByIndex(driverIndex: number, x: number, y: number): void {
	const driver = byIndex[driverIndex];
	if (driver === undefined) {
		const placed = { x, y, bucket: -1, slot: 0 };
		byIndex[driverIndex] = placed;
		add(byIndexIndex, placed);
		return;
	}
	driver.x = x;
	driver.y = y;
	if (bucketOf(x, y) === driver.bucket) return;
	remove(byIndexIndex, driver);
	add(byIndexIndex, driver);
}

const results = new Map<string, number[]>();
function time(name: string, run: () => void): void {
	const start = performance.now();
	run();
	const ms = performance.now() - start;
	const all = results.get(name) ?? [];
	all.push(ms);
	results.set(name, all);
}
const median = (values: number[]) =>
	values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;

let state = startDispatch({ grid, tick: 0 as never });
for (const payload of online) {
	const parsed = parseMessage(JSON.parse(payload));
	if (!parsed.ok || parsed.value.type !== "drivers.went_online") throw new Error("bad");
	state = decideDispatch(state, parsed.value, random).state;
}
for (let i = 0; i < fleet; i++) {
	placeById(ids[i] as DriverId, xs[i] as number, ys[i] as number);
	placeByIndex(i, xs[i] as number, ys[i] as number);
}

let sink = 0;
for (let t = 0; t < ticks; t++) {
	const tickNow = now[t] as string[];
	const tickIndexed = indexed[t] as string[];
	let jsonNow: unknown[] = [];
	let messages: DriversMoved[] = [];
	time("ids: JSON.parse", () => {
		jsonNow = tickNow.map((p) => JSON.parse(p));
	});
	time("ids: Zod (parseMessage)", () => {
		messages = jsonNow.map((json) => {
			const parsed = parseMessage(json);
			if (!parsed.ok || parsed.value.type !== "drivers.moved") throw new Error("bad");
			return parsed.value;
		});
	});
	time("ids: apply, real decideDispatch", () => {
		for (const message of messages) state = decideDispatch(state, message, random).state;
	});
	time("ids: apply, prototype Map by DriverId", () => {
		for (const m of messages) {
			for (let i = 0; i < m.driverIds.length; i++) {
				placeById(m.driverIds[i] as DriverId, m.xs[i] as number, m.ys[i] as number);
			}
		}
	});
	time("ids: read with IDs (forEachMove: UI, invariants)", () => {
		for (const m of messages) forEachMove(m, (id, cell) => { sink += id.length + cell.x; });
	});
	time("ids: persister row payload (JSON.stringify)", () => {
		for (const m of messages) sink += JSON.stringify(m).length;
	});

	let jsonIndexed: unknown[] = [];
	let indexedMessages: IndexedMoved[] = [];
	time("indexes: JSON.parse", () => {
		jsonIndexed = tickIndexed.map((p) => JSON.parse(p));
	});
	time("indexes: Zod (one pass, index < fleet)", () => {
		indexedMessages = jsonIndexed.map((json) => {
			const parsed = IndexedMoved.safeParse(json);
			if (!parsed.success) throw new Error("bad");
			return parsed.data;
		});
	});
	time("indexes: apply, prototype array by index", () => {
		for (const m of indexedMessages) {
			for (let i = 0; i < m.driverIndexes.length; i++) {
				placeByIndex(m.driverIndexes[i] as number, m.xs[i] as number, m.ys[i] as number);
			}
		}
	});
	time("indexes: read with IDs (ID table, cellAt)", () => {
		for (const m of indexedMessages) {
			for (let i = 0; i < m.driverIndexes.length; i++) {
				const id = idOf(m.driverIndexes[i] as number);
				const cell = cellAt(m.xs[i] as Coordinate, m.ys[i] as Coordinate);
				sink += id.length + cell.x;
			}
		}
	});
	time("indexes: persister row payload (JSON.stringify)", () => {
		for (const m of indexedMessages) sink += JSON.stringify(m).length;
	});
}

const bytes = (payloads: string[]) => payloads.reduce((n, p) => n + p.length, 0);
console.log(
	`fleet ${fleet}, ticks ${ticks}, chunks per tick ${now[0]?.length}, bytes per tick ids ${bytes(now[0] ?? [])} indexes ${bytes(indexed[0] ?? [])} (sink ${sink > 0})`,
);
console.log("median ms per tick (first tick dropped as warm-up):");
for (const [name, values] of results) {
	console.log(`  ${name.padEnd(52)} ${median(values.slice(1)).toFixed(1).padStart(8)}`);
}
