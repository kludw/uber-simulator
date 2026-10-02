import { describe, expect, test } from "bun:test";
import { createRandom, type Random } from "./random.ts";

function floats(random: Random, count: number): number[] {
	return Array.from({ length: count }, () => random.float());
}

describe("createRandom", () => {
	test("same seed gives identical sequences", () => {
		expect(floats(createRandom(7), 20)).toEqual(floats(createRandom(7), 20));
	});

	test("different seeds give different sequences", () => {
		expect(floats(createRandom(7), 20)).not.toEqual(
			floats(createRandom(8), 20),
		);
	});

	// Guards against accidental algorithm change: every seeded outcome depends on it.
	test("seed 42 gives pinned first floats", () => {
		expect(floats(createRandom(42), 4)).toEqual([
			0.8686135609168559, 0.41595513583160937, 0.33768315333873034,
			0.5103033822961152,
		]);
	});
});

describe("float", () => {
	test("stays in [0, 1) over many draws", () => {
		const draws = floats(createRandom(1), 10_000);
		expect(draws.every((draw) => draw >= 0 && draw < 1)).toBe(true);
	});
});

describe("int", () => {
	test("stays within inclusive bounds and hits both ends", () => {
		const random = createRandom(3);
		const draws = new Set(
			Array.from({ length: 1_000 }, () => random.int(-2, 2)),
		);
		expect([...draws].sort((a, b) => a - b)).toEqual([-2, -1, 0, 1, 2]);
	});
});

describe("child", () => {
	test("same seed and label give identical streams, regardless of parent draws", () => {
		const parent = createRandom(5);
		const before = floats(parent.child("a"), 20);
		floats(parent, 3);
		expect(floats(parent.child("a"), 20)).toEqual(before);
	});

	test("different labels give different streams", () => {
		const parent = createRandom(5);
		expect(floats(parent.child("a"), 20)).not.toEqual(
			floats(parent.child("b"), 20),
		);
	});

	test("child stream differs from parent stream", () => {
		expect(floats(createRandom(5).child("a"), 20)).not.toEqual(
			floats(createRandom(5), 20),
		);
	});

	test("drawing from a child leaves the parent sequence unchanged", () => {
		const parent = createRandom(5);
		const child = parent.child("a");
		const interleaved = Array.from({ length: 20 }, () => {
			child.float();
			return parent.float();
		});
		expect(interleaved).toEqual(floats(createRandom(5), 20));
	});
});
