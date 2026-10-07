import { expect, test } from "bun:test";
import { DriverIndex, driverIdAt } from "./fleet.ts";

const index = (n: number) => DriverIndex.parse(n);

test("driver IDs are zero-padded to the digits of the fleet's last index", () => {
	const ids: string[] = [
		driverIdAt(100, index(0)),
		driverIdAt(100, index(7)),
		driverIdAt(100, index(99)),
		driverIdAt(101, index(7)),
		driverIdAt(1, index(0)),
	];
	expect(ids).toEqual(["d-00", "d-07", "d-99", "d-007", "d-0"]);
});

test("one fleet size gives the same ID for an index every time", () => {
	const first = driverIdAt(12, index(3));
	driverIdAt(1000, index(3));
	expect(driverIdAt(12, index(3))).toBe(first);
});

test("an index outside the fleet is a bug", () => {
	expect(() => driverIdAt(10, index(10))).toThrow();
});
