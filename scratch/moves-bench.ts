// #232 experiment, not merged: dispatch's cost of one tick of drivers.moved
// at a fleet size, by step and by candidate option, single process, no NATS.
// Every driver moves one cell per tick (live at 400k: 80 chunks per tick).
// Usage: bun scratch/moves-bench.ts [drivers] [ticks]
import { decideDispatch, startDispatch } from "../src/dispatch/brain.ts";
import { type Coordinate, cellAt, specGrid } from "../src/shared/grid.ts";
import {
	DriverId,
	DriversMoved,
	driversMoved,
	driversWentOnline,
	forEachMove,
	parseMessage,
} from "../src/shared/messages.ts";
import { createRandom } from "../src/shared/random.ts";
import * as z from "zod";
import {
	nearestIdle,
	placeDriver,
	startIdleDrivers,
} from "../src/dispatch/idle-drivers.ts";

const drivers = Number(process.argv[2] ?? 400_000);
const ticks = Number(process.argv[3] ?? 30);
const shards = 2;
const perChunk = 5_000;
const random = createRandom(1);
const grid = specGrid;

// IDs as the shards make them (src/sim/services.ts), in ID order per shard.
const idWidth = String(drivers - 1).length;
const ids = Array.from({ length: drivers }, (_, i) =>
	DriverId.parse(`d-${String(i).padStart(idWidth, "0")}`),
);
const xs = Int32Array.from(ids, () => random.int(0, grid.width - 1));
const ys = Int32Array.from(ids, () => random.int(0, grid.height - 1));
const perShard = drivers / shards;

function chunksOf<T>(entries: T[]): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < entries.length; i += perChunk) {
		chunks.push(entries.slice(i, i + perChunk));
	}
	return chunks;
}

function step(i: number): void {
	const axis = random.int(0, 1);
	const delta = random.int(0, 1) * 2 - 1;
	if (axis === 0) xs[i] = Math.min(grid.width - 1, Math.max(0, (xs[i] ?? 0) + delta));
	else ys[i] = Math.min(grid.height - 1, Math.max(0, (ys[i] ?? 0) + delta));
}

const online: string[] = [];
for (let shard = 0; shard < shards; shard++) {
	const entries = [];
	for (let i = shard * perShard; i < (shard + 1) * perShard; i++) {
		entries.push({
			driverId: ids[i] as DriverId,
			cell: cellAt(xs[i] as Coordinate, ys[i] as Coordinate),
		});
	}
	for (const chunk of chunksOf(entries)) {
		online.push(JSON.stringify(driversWentOnline(0 as never, chunk)));
	}
}
// Payloads per tick, as received.
const payloads: string[][] = [];
const indexedByTick: string[][] = [];
for (let tick = 1; tick <= ticks; tick++) {
	const tickPayloads: string[] = [];
	const tickIndexed: string[] = [];
	for (let shard = 0; shard < shards; shard++) {
		const moves = [];
		for (let i = shard * perShard; i < (shard + 1) * perShard; i++) {
			step(i);
			moves.push({
				driverId: ids[i] as DriverId,
				cell: cellAt(xs[i] as Coordinate, ys[i] as Coordinate),
			});
		}
		for (const chunk of chunksOf(moves)) {
			tickPayloads.push(JSON.stringify(driversMoved(tick as never, chunk)));
		}
		// Option shape: each driver's dense index in its shard instead of its ID.
		const indexes = moves.map((_, i) => i);
		for (let i = 0; i < moves.length; i += perChunk) {
			const chunk = moves.slice(i, i + perChunk);
			tickIndexed.push(
				JSON.stringify({
					type: "drivers.moved",
					tick,
					shard,
					drivers: indexes.slice(i, i + perChunk),
					xs: chunk.map((move) => move.cell.x),
					ys: chunk.map((move) => move.cell.y),
				}),
			);
		}
	}
	payloads.push(tickPayloads);
	indexedByTick.push(tickIndexed);
}

// Option schemas: each array checked in one pass by z.custom, no schema run
// per element (z.array runs its element schema per entry and copies).
const idPattern = /^[A-Za-z0-9_-]+$/;
const isCoordinate = (c: unknown) =>
	typeof c === "number" && Number.isSafeInteger(c) && c >= 0;
const onePassIds = z.custom<DriverId[]>(
	(ids) =>
		Array.isArray(ids) &&
		ids.every((id) => typeof id === "string" && idPattern.test(id)),
);
const onePassCoordinates = z.custom<Coordinate[]>(
	(cs) => Array.isArray(cs) && cs.every(isCoordinate),
);
const sameLength = (m: { xs: unknown[]; ys: unknown[] }, n: number) =>
	m.xs.length === n && m.ys.length === n;
const OnePassMoved = z
	.object({
		type: z.literal("drivers.moved"),
		tick: z.int().nonnegative(),
		driverIds: onePassIds,
		xs: onePassCoordinates,
		ys: onePassCoordinates,
	})
	.refine((m) => sameLength(m, m.driverIds.length));
const IndexedMoved = z
	.object({
		type: z.literal("drivers.moved"),
		tick: z.int().nonnegative(),
		shard: z.int().nonnegative(),
		drivers: onePassCoordinates,
		xs: onePassCoordinates,
		ys: onePassCoordinates,
	})
	.refine((m) => sameLength(m, m.drivers.length));

const results = new Map<string, number[]>();
function time(name: string, run: () => void): void {
	const start = performance.now();
	run();
	const ms = performance.now() - start;
	const all = results.get(name) ?? [];
	all.push(ms);
	results.set(name, all);
}
const median = (values: number[]) => {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

// Dispatch with every driver online, then each tick's moves applied by the
// real brain; the other steps are timed on the same payloads.
let state = startDispatch({ grid, tick: 0 as never });
for (const payload of online) {
	const parsed = parseMessage(JSON.parse(payload));
	if (!parsed.ok || parsed.value.type !== "drivers.went_online") throw new Error("bad");
	state = decideDispatch(state, parsed.value, random).state;
}
// Option: one record per driver indexed by a dense integer (e.g. the driver's
// place in its shard), x and y as numbers, no Cell per move, no Map lookup.
type IndexedDriver = { x: number; y: number; bucket: number };
const indexed: IndexedDriver[] = Array.from({ length: drivers }, (_, i) => ({
	x: xs[i] ?? 0,
	y: ys[i] ?? 0,
	bucket: -1,
}));
// Option: same Map as now, records with x, y numbers, no Cell per move.
type MappedDriver = { x: number; y: number; bucket: number };
const mapped = new Map<string, MappedDriver>(
	ids.map((id, i) => [id, { x: xs[i] ?? 0, y: ys[i] ?? 0, bucket: -1 }]),
);
const bucketOf = (x: number, y: number) =>
	Math.floor(y / 16) * Math.ceil(grid.width / 16) + Math.floor(x / 16);
let crossings = 0;
let moves = 0;

for (const tickPayloads of payloads) {
	let parsedJson: unknown[] = [];
	let messages: DriversMoved[] = [];
	time("decode: JSON.parse", () => {
		parsedJson = tickPayloads.map((payload) => JSON.parse(payload));
	});
	time("decode: Zod via parseMessage (union)", () => {
		messages = parsedJson.map((json) => {
			const parsed = parseMessage(json);
			if (!parsed.ok || parsed.value.type !== "drivers.moved") throw new Error("bad");
			return parsed.value;
		});
	});
	time("decode: Zod via DriversMoved alone", () => {
		for (const json of parsedJson) {
			if (!DriversMoved.safeParse(json).success) throw new Error("bad");
		}
	});
	time("decode option: Zod, one pass per array (z.custom)", () => {
		for (const json of parsedJson) {
			if (!OnePassMoved.safeParse(json).success) throw new Error("bad");
		}
	});
	const indexedPayloads = indexedByTick[payloads.indexOf(tickPayloads)] ?? [];
	let indexedJson: unknown[] = [];
	time("decode option: indexes not IDs, JSON.parse", () => {
		indexedJson = indexedPayloads.map((payload) => JSON.parse(payload));
	});
	time("decode option: indexes not IDs, Zod one pass", () => {
		for (const json of indexedJson) {
			if (!IndexedMoved.safeParse(json).success) throw new Error("bad");
		}
	});
	time("apply: decideDispatch (now)", () => {
		for (const message of messages) {
			state = decideDispatch(state, message, random).state;
		}
	});
	time("apply: forEachMove only (cellAt per move, no-op visit)", () => {
		let n = 0;
		for (const message of messages) forEachMove(message, () => n++);
	});
	time("apply option: Map lookup, x/y numbers, bucket check", () => {
		for (const message of messages) {
			const { driverIds, xs: mx, ys: my } = message;
			for (let i = 0; i < driverIds.length; i++) {
				const driver = mapped.get(driverIds[i] as string);
				if (driver === undefined) throw new Error("unknown");
				const x = mx[i] as number;
				const y = my[i] as number;
				driver.x = x;
				driver.y = y;
				const bucket = bucketOf(x, y);
				if (bucket !== driver.bucket) driver.bucket = bucket;
			}
		}
	});
	time("apply option: dense index, x/y numbers, bucket check", () => {
		let base = 0;
		let shardOf = 0;
		for (const message of messages) {
			const { driverIds, xs: mx, ys: my } = message;
			// Every driver moved: index = position in the fleet.
			for (let i = 0; i < driverIds.length; i++) {
				const driver = indexed[base + i];
				if (driver === undefined) throw new Error("unknown");
				const x = mx[i] as number;
				const y = my[i] as number;
				driver.x = x;
				driver.y = y;
				const bucket = bucketOf(x, y);
				moves++;
				if (bucket !== driver.bucket) {
					if (driver.bucket !== -1) crossings++;
					driver.bucket = bucket;
				}
			}
			base += driverIds.length;
			shardOf++;
		}
	});
}

console.log(
	`drivers ${drivers}, ticks ${ticks}, chunks per tick ${payloads[0]?.length}, bucket crossings ${((100 * crossings) / moves).toFixed(1)}% of moves`,
);
console.log("median ms per tick (first tick dropped as warm-up):");
for (const [name, values] of results) {
	console.log(`  ${name.padEnd(58)} ${median(values.slice(1)).toFixed(1).padStart(8)}`);
}

// Option: smaller grid buckets (ADR 0036 tuned 16 cells at 50k). Real
// placeDriver and nearestIdle; every driver idle (live, the busy ones are
// out of the buckets); one nearest search per trip requested per tick at the
// spec ratio (drivers / 600), random pickups, nothing excluded.
const searchesPerTick = Math.round(drivers / 600);
const noneExcluded = new Set<DriverId>();
for (const cellsPerBucket of [16, 8, 4]) {
	const idle = startIdleDrivers(grid, { cellsPerBucket, linearScanBelow: 64 });
	const placeMs: number[] = [];
	const searchMs: number[] = [];
	for (const tickPayloads of payloads) {
		const messages = tickPayloads.map((payload) => {
			const parsed = parseMessage(JSON.parse(payload));
			if (!parsed.ok || parsed.value.type !== "drivers.moved") throw new Error("bad");
			return parsed.value;
		});
		const start = performance.now();
		for (const message of messages) {
			forEachMove(message, (driverId, cell) => placeDriver(idle, driverId, cell));
		}
		placeMs.push(performance.now() - start);
		const pickups = Array.from({ length: searchesPerTick }, () =>
			cellAt(
				random.int(0, grid.width - 1) as Coordinate,
				random.int(0, grid.height - 1) as Coordinate,
			),
		);
		const searchStart = performance.now();
		for (const pickup of pickups) nearestIdle(idle, pickup, noneExcluded);
		searchMs.push(performance.now() - searchStart);
	}
	// The first tick places every driver (new records): dropped.
	console.log(
		`  buckets of ${cellsPerBucket} cells: placeDriver ${median(placeMs.slice(1)).toFixed(1)} ms per tick, ${searchesPerTick} nearest searches ${median(searchMs.slice(1)).toFixed(1)} ms per tick`,
	);
}

// Option: decode on a worker. The worker JSON.parses and Zod-parses a tick's
// chunks and posts each decoded chunk. The main thread blocks until the
// worker is done (its `done` message queues behind the chunks), then receives
// the queued chunks back to back: from unblocking to `done` is the main
// thread's cost of receiving them (deserializing, dispatching each event).
const blockMs = (ms: number) => {
	const until = performance.now() + ms;
	while (performance.now() < until) {}
};
for (const mode of ["arrays", "typed", "indexed"] as const) {
	const worker = new Worker(new URL("./moves-worker.ts", import.meta.url));
	const spreads: number[] = [];
	const decodeMs: number[] = [];
	const postMs: number[] = [];
	let received = 0;
	await new Promise<void>((resolve) => {
		let tick = 0;
		let start = 0;
		const next = () => {
			const tickPayloads = payloads[tick];
			if (tickPayloads === undefined) {
				worker.terminate();
				resolve();
				return;
			}
			worker.postMessage({ mode, payloads: tickPayloads });
			// Longer than the worker's decode + post (printed below).
			blockMs(Math.max(500, drivers / 400));
			start = performance.now();
		};
		worker.onmessage = (event: MessageEvent) => {
			if (!event.data.done) {
				received++;
				return;
			}
			spreads.push(performance.now() - start);
			decodeMs.push(event.data.decodeMs);
			postMs.push(event.data.postMs);
			tick++;
			setTimeout(next, 50);
		};
		next();
	});
	console.log(
		`  worker decode (${mode}): main receiving ${median(spreads.slice(1)).toFixed(1)} ms per tick (${received} chunks); worker decode ${median(decodeMs.slice(1)).toFixed(1)}, post ${median(postMs.slice(1)).toFixed(1)} ms`,
	);
}
