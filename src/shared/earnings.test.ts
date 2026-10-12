import { describe, expect, test } from "bun:test";
import { driverShareOf, earningsTarget } from "./earnings.ts";
import { Coordinate, cellAt } from "./grid.ts";
import { DriverId } from "./messages.ts";
import { createRandom } from "./random.ts";
import { Fare, fareOf, Surge } from "./surge.ts";

// 10 cells: a base fare of 270 cents.
const trip = {
	pickup: cellAt(Coordinate.parse(0), Coordinate.parse(0)),
	dropoff: cellAt(Coordinate.parse(10), Coordinate.parse(0)),
};

describe("driverShareOf", () => {
	test("a driver earns three quarters of a fare, halves rounded up", () => {
		expect([
			driverShareOf(Fare.parse(254)),
			driverShareOf(Fare.parse(250)),
			driverShareOf(Fare.parse(2)),
		]).toEqual([191, 188, 2]);
	});

	test("a surged fare's share is of the surged fare", () => {
		// 270 × 1.3 = 351; 351 × 0.75 = 263.25.
		expect(driverShareOf(fareOf(trip, Surge.parse(1.3), null))).toBe(263);
	});

	test("a pooled fare's share is of the discounted fare", () => {
		// 270 × 0.75 = 202.5 -> 203; 203 × 0.75 = 152.25.
		const pooled = { ...trip, pooled: true as const };
		expect(driverShareOf(fareOf(pooled, Surge.parse(1), null))).toBe(152);
	});
});

const drivers = Array.from({ length: 200 }, (_, index) =>
	DriverId.parse(`d-${index}`),
);

describe("earningsTarget", () => {
	test("is whole cents from $15 to $30", () => {
		const targets = drivers.map((driverId) =>
			earningsTarget(createRandom(42), driverId),
		);
		expect(
			targets.every(
				(target) =>
					Number.isInteger(target) && target >= 1500 && target <= 3000,
			),
		).toBe(true);
	});

	test("is the same for a driver ID and seed, whatever else was drawn", () => {
		const drawn = createRandom(42);
		drawn.int(0, 100);
		drawn.child("chase:7").float();
		const driverId = DriverId.parse("d-3");
		expect(earningsTarget(drawn, driverId)).toBe(
			earningsTarget(createRandom(42), driverId),
		);
	});

	test("differs between drivers", () => {
		const targets = drivers.map((driverId) =>
			earningsTarget(createRandom(42), driverId),
		);
		expect(new Set(targets).size).toBeGreaterThan(150);
	});
});
