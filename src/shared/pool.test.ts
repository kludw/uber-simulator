import { describe, expect, test } from "bun:test";
import { type Cell, cellIn } from "./grid.ts";
import { joinEtaOf, joinReachOf, partnerDropsFirst } from "./pool.ts";

function cell(x: number, y: number): Cell {
	const result = cellIn({ width: 500, height: 500 }, x, y);
	if (!result.ok) throw new Error(`test cell (${x}, ${y}) outside grid`);
	return result.value;
}

describe("joinEtaOf", () => {
	// Driver 10 from the partner's pickup, which is 10 from the joining one.
	test("is the driver's distance via the partner's pickup to the joining pickup", () => {
		expect(
			joinEtaOf(
				cell(0, 0),
				{ pickup: cell(10, 0), dropoff: cell(100, 0), rideSoFar: null },
				{ pickup: cell(20, 0), dropoff: cell(90, 0) },
			),
		).toBe(20);
	});

	// Partner: east from 60 to 300; joining: east from 120 or 121 to 250.
	test("joins at a join ETA of 120 ticks", () => {
		expect(
			joinEtaOf(
				cell(0, 0),
				{ pickup: cell(60, 0), dropoff: cell(300, 0), rideSoFar: null },
				{ pickup: cell(120, 0), dropoff: cell(250, 0) },
			),
		).toBe(120);
	});

	test("does not join at a join ETA over 120 ticks", () => {
		expect(
			joinEtaOf(
				cell(0, 0),
				{ pickup: cell(60, 0), dropoff: cell(300, 0), rideSoFar: null },
				{ pickup: cell(121, 0), dropoff: cell(250, 0) },
			),
		).toBeNull();
	});

	// Both picked up at (0, 0); the partner's dropoff, 10 east, comes first;
	// the joining rider then rides 50 more to its dropoff 40 or 39 south.
	test("joins when the joining rider rides exactly 1.5 times its direct distance", () => {
		expect(
			joinEtaOf(
				cell(0, 0),
				{ pickup: cell(0, 0), dropoff: cell(10, 0), rideSoFar: null },
				{ pickup: cell(0, 0), dropoff: cell(0, 40) },
			),
		).toBe(0);
	});

	test("does not join when the joining rider rides over 1.5 times its direct distance", () => {
		expect(
			joinEtaOf(
				cell(0, 0),
				{ pickup: cell(0, 0), dropoff: cell(10, 0), rideSoFar: null },
				{ pickup: cell(0, 0), dropoff: cell(0, 39) },
			),
		).toBeNull();
	});

	// The partner, picked up at (0, 0), rides 5 to the joining pickup, 10 east
	// to the joining dropoff, then 35 or 34 to its own, 40 or 39 south.
	test("joins when the partner rides exactly 1.5 times its direct distance", () => {
		expect(
			joinEtaOf(
				cell(0, 0),
				{ pickup: cell(0, 0), dropoff: cell(0, 40), rideSoFar: null },
				{ pickup: cell(0, 5), dropoff: cell(10, 5) },
			),
		).toBe(5);
	});

	test("does not join when the partner rides over 1.5 times its direct distance", () => {
		expect(
			joinEtaOf(
				cell(0, 0),
				{ pickup: cell(0, 0), dropoff: cell(0, 39), rideSoFar: null },
				{ pickup: cell(0, 5), dropoff: cell(10, 5) },
			),
		).toBeNull();
	});

	// The partner, aboard since (0, 0) and 10 south now, rides 30 more on a
	// straight line south (joining 20 to 30) to its dropoff at 40.
	test("is the driver's distance to the joining pickup once the partner is aboard", () => {
		expect(
			joinEtaOf(
				cell(0, 10),
				{ pickup: cell(0, 0), dropoff: cell(0, 40), rideSoFar: 30 },
				{ pickup: cell(0, 20), dropoff: cell(0, 30) },
			),
		).toBe(10);
	});

	test("counts an aboard partner's ticks so far against its detour limit", () => {
		expect(
			joinEtaOf(
				cell(0, 10),
				{ pickup: cell(0, 0), dropoff: cell(0, 40), rideSoFar: 31 },
				{ pickup: cell(0, 20), dropoff: cell(0, 30) },
			),
		).toBeNull();
	});

	// The driver waits at the partner's dropoff: the partner's ride is over
	// whichever dropoff is nearer the joining pickup, 30 back north.
	test("joins a driver at an aboard partner's dropoff after that dropoff", () => {
		expect(
			joinEtaOf(
				cell(0, 40),
				{ pickup: cell(0, 0), dropoff: cell(0, 40), rideSoFar: 40 },
				{ pickup: cell(0, 10), dropoff: cell(0, 15) },
			),
		).toBe(30);
	});
});

// The joining pickup at (50, 50); dropoffs at the given distances from it.
describe("joinReachOf", () => {
	test("is the nearest idle driver's pickup distance", () => {
		expect(joinReachOf(30)).toBe(30);
	});

	test("is at most 120 ticks however far the nearest idle driver is", () => {
		expect(joinReachOf(121)).toBe(120);
	});

	test("is 120 ticks with no idle driver", () => {
		expect(joinReachOf(undefined)).toBe(120);
	});
});

describe("partnerDropsFirst", () => {
	test("drops the partner first when its dropoff is nearer", () => {
		expect(
			partnerDropsFirst(
				{ pickup: cell(0, 0), dropoff: cell(60, 50) },
				{ pickup: cell(50, 50), dropoff: cell(50, 70) },
			),
		).toBe(true);
	});

	test("drops the joining rider first when its dropoff is nearer", () => {
		expect(
			partnerDropsFirst(
				{ pickup: cell(0, 0), dropoff: cell(80, 50) },
				{ pickup: cell(50, 50), dropoff: cell(50, 70) },
			),
		).toBe(false);
	});

	test("drops the partner first on a tie", () => {
		expect(
			partnerDropsFirst(
				{ pickup: cell(0, 0), dropoff: cell(70, 50) },
				{ pickup: cell(50, 50), dropoff: cell(50, 70) },
			),
		).toBe(true);
	});
});
