// Micro-benchmark for #222: JSON.parse + Zod parse of one drivers.moved chunk
// (5,000 moves) in candidate shapes. "+cells" also builds the per-move cell
// objects a consumer needs (dispatch's driverCells holds a Cell per driver).
import * as z from "zod";

const movesPerChunk = 5_000;
const rounds = Number(process.argv[2] ?? 400);

const DriverId = z
	.string()
	.regex(/^[A-Za-z0-9_-]+$/)
	.brand<"DriverId">();
const Coordinate = z.int().nonnegative();
const Cell = z
	.object({ x: Coordinate, y: Coordinate })
	.readonly()
	.brand<"Cell">();
const Tick = z.int().nonnegative().brand<"Tick">();

const ObjectsShape = z.object({
	type: z.literal("drivers.moved"),
	tick: Tick,
	moves: z.array(z.object({ driverId: DriverId, cell: Cell })),
});
const TuplesShape = z.object({
	type: z.literal("drivers.moved"),
	tick: Tick,
	moves: z.array(z.tuple([DriverId, Coordinate, Coordinate])),
});
const ParallelShape = z
	.object({
		type: z.literal("drivers.moved"),
		tick: Tick,
		driverIds: z.array(DriverId),
		xs: z.array(Coordinate),
		ys: z.array(Coordinate),
	})
	.refine(
		(m) => m.xs.length === m.driverIds.length && m.ys.length === m.driverIds.length,
	);
// Same wire shape as ParallelShape; each array's elements checked by one
// refine instead of a schema per element.
const idPattern = /^[A-Za-z0-9_-]+$/;
const isCoordinate = (c: number) => Number.isSafeInteger(c) && c >= 0;
const ParallelRefinedShape = z
	.object({
		type: z.literal("drivers.moved"),
		tick: Tick,
		driverIds: z
			.array(z.string())
			.refine((ids) => ids.every((id) => idPattern.test(id))),
		xs: z.array(z.number()).refine((cs) => cs.every(isCoordinate)),
		ys: z.array(z.number()).refine((cs) => cs.every(isCoordinate)),
	})
	.refine(
		(m) => m.xs.length === m.driverIds.length && m.ys.length === m.driverIds.length,
	);
// As ParallelRefinedShape, each array branded by a transform (as merged, #222).
type Coordinate = number & z.$brand<"Coordinate">;
const ParallelBrandedShape = z
	.object({
		type: z.literal("drivers.moved"),
		tick: Tick,
		driverIds: z
			.array(z.string())
			.refine((ids) => ids.every((id) => idPattern.test(id)))
			.transform((ids) => ids as z.infer<typeof DriverId>[]),
		xs: z
			.array(z.number())
			.refine((cs) => cs.every(isCoordinate))
			.transform((cs) => cs as Coordinate[]),
		ys: z
			.array(z.number())
			.refine((cs) => cs.every(isCoordinate))
			.transform((cs) => cs as Coordinate[]),
	})
	.refine(
		(m) => m.xs.length === m.driverIds.length && m.ys.length === m.driverIds.length,
	);
// IDs by schema per element (branded), coordinates by one refine per array.
const ParallelHybridShape = z
	.object({
		type: z.literal("drivers.moved"),
		tick: Tick,
		driverIds: z.array(DriverId),
		xs: z.array(z.number()).refine((cs) => cs.every(isCoordinate)),
		ys: z.array(z.number()).refine((cs) => cs.every(isCoordinate)),
	})
	.refine(
		(m) => m.xs.length === m.driverIds.length && m.ys.length === m.driverIds.length,
	);
const FlatCellsShape = z
	.object({
		type: z.literal("drivers.moved"),
		tick: Tick,
		driverIds: z.array(DriverId),
		cells: z.array(Coordinate),
	})
	.refine((m) => m.cells.length === 2 * m.driverIds.length);

const ids = Array.from(
	{ length: movesPerChunk },
	(_, i) => `d-${String(i * 7).padStart(6, "0")}`,
);
const xs = ids.map((_, i) => (i * 37) % 500);
const ys = ids.map((_, i) => (i * 91) % 500);

const payloads = {
	objects: JSON.stringify({
		type: "drivers.moved",
		tick: 1234,
		moves: ids.map((driverId, i) => ({ driverId, cell: { x: xs[i], y: ys[i] } })),
	}),
	tuples: JSON.stringify({
		type: "drivers.moved",
		tick: 1234,
		moves: ids.map((driverId, i) => [driverId, xs[i], ys[i]]),
	}),
	parallelRefined: JSON.stringify({
		type: "drivers.moved",
		tick: 1234,
		driverIds: ids,
		xs,
		ys,
	}),
	parallel: JSON.stringify({ type: "drivers.moved", tick: 1234, driverIds: ids, xs, ys }),
	flatCells: JSON.stringify({
		type: "drivers.moved",
		tick: 1234,
		driverIds: ids,
		cells: ids.flatMap((_, i) => [xs[i], ys[i]]),
	}),
};

let sink = 0;
type Cellish = { x: number; y: number };
const cases: Record<string, (json: string) => void> = {
	objects: (json) => {
		const m = ObjectsShape.parse(JSON.parse(json));
		sink += m.moves.length;
	},
	"objects+cells": (json) => {
		const m = ObjectsShape.parse(JSON.parse(json));
		for (const move of m.moves) sink += move.cell.x;
	},
	tuples: (json) => {
		const m = TuplesShape.parse(JSON.parse(json));
		sink += m.moves.length;
	},
	"tuples+cells": (json) => {
		const m = TuplesShape.parse(JSON.parse(json));
		for (const [, x, y] of m.moves) {
			const cell: Cellish = { x, y };
			sink += cell.x;
		}
	},
	parallel: (json) => {
		const m = ParallelShape.parse(JSON.parse(json));
		sink += m.driverIds.length;
	},
	"parallel+cells": (json) => {
		const m = ParallelShape.parse(JSON.parse(json));
		for (let i = 0; i < m.driverIds.length; i++) {
			const cell: Cellish = { x: m.xs[i] as number, y: m.ys[i] as number };
			sink += cell.x;
		}
	},
	parallelRefined: (json) => {
		const m = ParallelRefinedShape.parse(JSON.parse(json));
		sink += m.driverIds.length;
	},
	parallelBranded: (json) => {
		const m = ParallelBrandedShape.parse(JSON.parse(json));
		sink += m.driverIds.length;
	},
	parallelHybrid: (json) => {
		const m = ParallelHybridShape.parse(JSON.parse(json));
		sink += m.driverIds.length;
	},
	flatCells: (json) => {
		const m = FlatCellsShape.parse(JSON.parse(json));
		sink += m.driverIds.length;
	},
	"flatCells+cells": (json) => {
		const m = FlatCellsShape.parse(JSON.parse(json));
		for (let i = 0; i < m.driverIds.length; i++) {
			const cell: Cellish = {
				x: m.cells[2 * i] as number,
				y: m.cells[2 * i + 1] as number,
			};
			sink += cell.x;
		}
	},
};

function payloadOf(name: string): string {
	const shape = name.split("+")[0] as string;
	if (shape.startsWith("parallel")) return payloads.parallel;
	return payloads[shape as keyof typeof payloads];
}

function jsonOnly(json: string): void {
	sink += Object.keys(JSON.parse(json)).length;
}

function median(values: number[]): number {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] as number;
}

function measure(run: (json: string) => void, json: string): number {
	for (let i = 0; i < 50; i++) run(json); // warm-up
	const samples: number[] = [];
	for (let i = 0; i < rounds; i++) {
		const start = Bun.nanoseconds();
		run(json);
		samples.push((Bun.nanoseconds() - start) / 1e6);
	}
	return median(samples);
}

console.log(`bun ${Bun.version}, ${movesPerChunk} moves per chunk, ${rounds} rounds, median ms`);
console.log("shape | bytes | JSON.parse | JSON.parse + Zod");
for (const [name, run] of Object.entries(cases)) {
	const json = payloadOf(name);
	const parseMs = measure(jsonOnly, json);
	const totalMs = measure(run, json);
	console.log(`${name} | ${json.length} | ${parseMs.toFixed(3)} | ${totalMs.toFixed(3)}`);
}
console.log(`(sink ${sink})`);
