import { expect, test } from "bun:test";
import { DriverIndex, driverIdAt, driverIndexOf } from "./fleet.ts";
import { DriverId } from "./messages.ts";

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

test("a driver ID in driverIdAt's format names its index", () => {
	const indexes = [
		driverIndexOf(driverIdAt(100, index(7))),
		driverIndexOf(driverIdAt(400_000, index(399_999))),
		driverIndexOf(DriverId.parse("d-0")),
	];
	expect(indexes).toEqual([7, 399_999, 0].map(index));
});

test.each(["d-", "d-x1", "driver-1", "D-1", "d-1a", "1"])(
	"driver ID %p names no index",
	(id) => {
		expect(driverIndexOf(DriverId.parse(id))).toBeNull();
	},
);
