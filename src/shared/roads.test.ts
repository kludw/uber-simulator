import { describe, expect, test } from "bun:test";
import type { Grid } from "./grid.ts";
import { roadNetworkNamed } from "./roads.ts";

const grid: Grid = { width: 500, height: 500 };

describe("presets", () => {
	test("river is one horizontal river at row 263 with 4 bridges", () => {
		const network = roadNetworkNamed("river", grid);
		expect({
			rows: network.riverRows,
			columns: network.riverColumns,
			bridges: network.bridges.length,
		}).toEqual({ rows: [263], columns: [], bridges: 4 });
	});

	test("canals is 3 + 3 rivers near the quarter lines with 48 bridges", () => {
		const network = roadNetworkNamed("canals", grid);
		expect({
			rows: network.riverRows,
			columns: network.riverColumns,
			bridges: network.bridges.length,
		}).toEqual({
			rows: [138, 248, 361],
			columns: [105, 264, 367],
			bridges: 48,
		});
	});
});
