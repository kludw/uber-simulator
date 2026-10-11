import { describe, expect, test } from "bun:test";
import { DriverId } from "./messages.ts";
import { createRandom, type Random } from "./random.ts";
import { driverQuality, ratingPenaltyOf, Stars, starsOf } from "./rating.ts";

// A noise stream whose draw is the given noise in [-1, 1).
function noiseOf(noise: number): Random {
	return {
		float: () => (noise + 1) / 2,
		int: () => {
			throw new Error("stars draw no int");
		},
		child: () => {
			throw new Error("stars take no child");
		},
	};
}

const noNoise = noiseOf(0);

// A ride without detour: as many ticks from pickup to completion as cells.
function ride(waitTicks: number) {
	return { waitTicks, rideTicks: 100, directDistance: 100 };
}

describe("starsOf", () => {
	test("pickup wait costs nothing within 60 ticks", () => {
		expect([
			starsOf(4.5, ride(60), noNoise),
			starsOf(4.5, ride(61), noNoise),
		]).toEqual([Stars.parse(5), Stars.parse(4)]);
	});

	test("pickup wait costs a star per 120 ticks beyond the first 60", () => {
		expect([
			starsOf(4, ride(180), noNoise),
			starsOf(4, ride(300), noNoise),
		]).toEqual([Stars.parse(3), Stars.parse(2)]);
	});

	test("a 50% detour costs a star", () => {
		const detoured = { waitTicks: 0, rideTicks: 150, directDistance: 100 };
		expect(starsOf(4, detoured, noNoise)).toBe(Stars.parse(3));
	});

	test("noise moves stars by up to a star either way", () => {
		expect([
			starsOf(3, ride(0), noiseOf(-1)),
			starsOf(3, ride(0), noiseOf(0.98)),
		]).toEqual([Stars.parse(2), Stars.parse(4)]);
	});

	test("rounds to whole stars, halves up", () => {
		expect([
			starsOf(3.5, ride(0), noNoise),
			starsOf(3.49, ride(0), noNoise),
		]).toEqual([Stars.parse(4), Stars.parse(3)]);
	});

	test("never gives fewer than 1 star", () => {
		expect(starsOf(3.5, ride(1000), noNoise)).toBe(Stars.parse(1));
	});

	test("never gives more than 5 stars", () => {
		expect(starsOf(4.9, ride(0), noiseOf(0.98))).toBe(Stars.parse(5));
	});

	test("a trip with pickup and dropoff on one cell has no detour", () => {
		const inPlace = { waitTicks: 0, rideTicks: 2, directDistance: 0 };
		expect(starsOf(4, inPlace, noNoise)).toBe(Stars.parse(4));
	});
});

describe("driverQuality", () => {
	test("spreads over [3.5, 5.0)", () => {
		const riders = createRandom(42);
		const qualities = Array.from({ length: 1000 }, (_, i) =>
			driverQuality(riders, DriverId.parse(`d-${i}`)),
		);
		const min = Math.min(...qualities);
		const max = Math.max(...qualities);
		expect({
			min: min >= 3.5 && min < 3.51,
			max: max < 5 && max > 4.99,
		}).toEqual({ min: true, max: true });
	});

	test("is the same for a driver whatever the riders drew before", () => {
		const driverId = DriverId.parse("d-7");
		const first = createRandom(42);
		const second = createRandom(42);
		second.float();
		second.child("demand:3").float();
		expect(driverQuality(second, driverId)).toBe(
			driverQuality(first, driverId),
		);
	});
});

describe("ratingPenaltyOf", () => {
	test("an unrated driver has no penalty", () => {
		expect(ratingPenaltyOf(0, 0)).toBe(0);
	});

	test("an average of 4.0 costs 10 cells", () => {
		expect(ratingPenaltyOf(8, 2)).toBe(10);
	});

	test("an average of 1.0 costs the most, 40 cells", () => {
		expect(ratingPenaltyOf(3, 3)).toBe(40);
	});

	test("rounds to whole cells, halves up", () => {
		expect([ratingPenaltyOf(14, 3), ratingPenaltyOf(19, 4)]).toEqual([3, 3]);
	});
});
