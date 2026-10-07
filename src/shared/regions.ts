// Regions (ADR 0050): the grid split into columns x rows tiles, numbered
// row-major from 0, each owned by one dispatch instance. Every service of a
// run must use the same layout; nothing checks that they do.
import * as z from "zod";
import { type Cell, Coordinate, cellAt, type Grid } from "./grid.ts";

export const Region = z.int().nonnegative().brand<"Region">();
export type Region = z.infer<typeof Region>;

// "<columns>x<rows>", e.g. "2x1" (--regions, REGIONS).
export const RegionLayout = z
	.string()
	.regex(/^[1-9]\d*x[1-9]\d*$/, {
		error: "expected <columns>x<rows>, e.g. 2x1",
	})
	.transform((text) => {
		const [columns, rows] = text.split("x").map(Number);
		return { columns: Number(columns), rows: Number(rows) };
	});
export type RegionLayout = z.output<typeof RegionLayout>;

// Today's layout: one dispatch owns the whole grid.
export const oneRegion: RegionLayout = { columns: 1, rows: 1 };

// Tile column c covers x with c <= x * columns / width < c + 1, so widths
// differ by at most one cell when columns don't divide the grid.
export function regionOf(layout: RegionLayout, grid: Grid, cell: Cell): Region {
	const column = Math.floor((cell.x * layout.columns) / grid.width);
	const row = Math.floor((cell.y * layout.rows) / grid.height);
	return (row * layout.columns + column) as Region;
}

// Inclusive corners of the region's tile.
export function regionBounds(
	layout: RegionLayout,
	grid: Grid,
	region: Region,
): { min: Cell; max: Cell } {
	if (region >= layout.columns * layout.rows) {
		throw new Error(
			`region ${region} outside a ${layout.columns}x${layout.rows} layout`,
		);
	}
	const column = region % layout.columns;
	const row = Math.floor(region / layout.columns);
	const first = (index: number, parts: number, size: number) =>
		Coordinate.parse(Math.ceil((index * size) / parts));
	const last = (index: number, parts: number, size: number) =>
		Coordinate.parse(Math.ceil(((index + 1) * size) / parts) - 1);
	return {
		min: cellAt(
			first(column, layout.columns, grid.width),
			first(row, layout.rows, grid.height),
		),
		max: cellAt(
			last(column, layout.columns, grid.width),
			last(row, layout.rows, grid.height),
		),
	};
}
