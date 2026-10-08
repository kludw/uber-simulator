import type { Cell, Grid } from "../shared/grid.ts";
import type { Tick } from "../shared/messages.ts";
import type { RegionLayout } from "../shared/regions.ts";
import { type Surge, zonePartBounds } from "../shared/surge.ts";
import {
	type DriverView,
	emptyView,
	fleetSizeOf,
	forEachDriver,
	type View,
} from "./view.ts";

// Cell coordinates; fractional while a driver is between cells.
type Point = { x: number; y: number };
// CSS pixels.
type Size = { width: number; height: number };

// Legend colors (the side panel shows them, src/ui/panel.ts): the one place a
// driver state, a waiting rider, or an active trip gets its color.
export const driverColors: Record<DriverView["state"], string> = {
	idle: "#8b949e",
	en_route: "#e3b341",
	at_pickup: "#f0883e",
	on_trip: "#3fb950",
	at_dropoff: "#58a6ff",
};
const backgroundColor = "#0d1117";
const cityColor = "#161b22";
export const waitingRiderColor = "#ff7b72";
export const activeTripColor = "rgba(88, 166, 255, 0.35)";
// Surging zones (ADR 0054): a hue no driver state or rider uses, so a tint
// over dots or heatmap tiles stays readable as surge.
export const surgeColor = "#d2a8ff";
const driverRadius = 3;
const waitingRiderSize = 5;

// Above this many drivers, dots are too many to draw each frame and to read
// (ADR 0053): chosen, not found; dots were measured at 10k and 100k only.
const dotsUpTo = 10_000;

export type DrawMode = "dots" | "heatmap";

// By the fleet size of the latest drivers.* message (ADR 0053).
export function drawModeOf(view: View): DrawMode {
	return fleetSizeOf(view) > dotsUpTo ? "heatmap" : "dots";
}

// A tile's drivers are colored from idle to busy (any state but idle) by
// their busy share; waiting riders turn it red.
export const heatmapColors = {
	idle: driverColors.idle,
	busy: driverColors.on_trip,
	waitingRiders: waitingRiderColor,
};

// Heatmap tiles are square, this many cells a side (ADR 0053).
const cellsPerTile = 5;
const ridersForFullRed = 3;

// One pixel per heatmap tile, row-major, 4 bytes (RGBA) each: an ImageData's
// data, drawn scaled up to the city.
type Heatmap = {
	columns: number;
	rows: number;
	rgba: Uint8ClampedArray<ArrayBuffer>;
};

export function heatmapOf(view: View, grid: Grid): Heatmap {
	const columns = Math.ceil(grid.width / cellsPerTile);
	const rows = Math.ceil(grid.height / cellsPerTile);
	const tiles = columns * rows;
	const tileOf = (cell: Cell) =>
		Math.floor(cell.y / cellsPerTile) * columns +
		Math.floor(cell.x / cellsPerTile);
	const drivers = new Uint32Array(tiles);
	const busy = new Uint32Array(tiles);
	const waiting = new Uint32Array(tiles);
	let shown = 0;
	forEachDriver(view, (_index, driver) => {
		const tile = tileOf(driver.cell);
		drivers[tile] = (drivers[tile] ?? 0) + 1;
		if (driver.state !== "idle") busy[tile] = (busy[tile] ?? 0) + 1;
		shown++;
	});
	for (const rider of view.waitingRiders.values()) {
		const tile = tileOf(rider.pickup);
		waiting[tile] = (waiting[tile] ?? 0) + 1;
	}
	// A tile at twice the mean is at full brightness.
	const fullAt = (2 * shown) / tiles;
	const city = rgbOf(cityColor);
	const idle = rgbOf(heatmapColors.idle);
	const busyColor = rgbOf(heatmapColors.busy);
	const red = rgbOf(heatmapColors.waitingRiders);
	const rgba = new Uint8ClampedArray(tiles * 4);
	for (let tile = 0; tile < tiles; tile++) {
		const inTile = drivers[tile] ?? 0;
		const lit =
			inTile === 0
				? city
				: mix(
						city,
						mix(idle, busyColor, (busy[tile] ?? 0) / inTile),
						Math.min(1, inTile / fullAt),
					);
		const redShare = Math.min(1, (waiting[tile] ?? 0) / ridersForFullRed);
		rgba.set([...mix(lit, red, redShare), 255], tile * 4);
	}
	return { columns, rows, rgba };
}

// A surging zone's part in the region that priced it (ADR 0054): the
// whole zone unless a region border cuts it. Inclusive corners. Prices from
// regions or zones outside the page's layout (its REGIONS differs from the
// run's) are not drawn: they have no place on this map.
type SurgeArea = { min: Cell; max: Cell; surge: Surge };

export function surgeAreasOf(
	view: View,
	layout: RegionLayout,
	grid: Grid,
): SurgeArea[] {
	const areas: SurgeArea[] = [];
	for (const [region, zones] of view.zonesPriced) {
		if (region >= layout.columns * layout.rows) continue;
		for (const { zone, surge } of zones) {
			const bounds = zonePartBounds(layout, grid, region, zone);
			if (bounds === null) continue;
			areas.push({ ...bounds, surge });
		}
	}
	return areas;
}

// As the canvas and the panel write a surge, e.g. "1.4×".
export function surgeLabel(surge: number): string {
	return `${surge.toFixed(1)}×`;
}

type Rgb = [number, number, number];

// "#rrggbb" -> [r, g, b].
function rgbOf(hex: string): Rgb {
	const value = Number.parseInt(hex.slice(1), 16);
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

// share 0: from; 1: to.
function mix(from: Rgb, to: Rgb, share: number): Rgb {
	return [
		Math.round(from[0] + (to[0] - from[0]) * share),
		Math.round(from[1] + (to[1] - from[1]) * share),
		Math.round(from[2] + (to[2] - from[2]) * share),
	];
}

// Scales the grid uniformly to fit the canvas and centers it (letterboxed),
// so cells stay square whatever the canvas shape.
export function cellToPixel(cell: Point, grid: Grid, canvasSize: Size): Point {
	const scale = Math.min(
		canvasSize.width / grid.width,
		canvasSize.height / grid.height,
	);
	const left = (canvasSize.width - grid.width * scale) / 2;
	const top = (canvasSize.height - grid.height * scale) / 2;
	return {
		x: left + (cell.x + 0.5) * scale,
		y: top + (cell.y + 0.5) * scale,
	};
}

// fraction: share of the current tick elapsed, 0 at its clock.ticked. Only a
// move made on the current tick is animated; past 1 (next tick late) the
// driver waits at its cell rather than overshooting.
export function driverPosition(
	driver: DriverView,
	tick: Tick | null,
	fraction: number,
): Point {
	const to = driver.cell;
	if (driver.movedAt !== tick || fraction >= 1) return to;
	const from = driver.previousCell;
	return {
		x: from.x + (to.x - from.x) * fraction,
		y: from.y + (to.y - from.y) * fraction,
	};
}

// When clock.ticked messages arrived, in performance.now() milliseconds. The
// duration between the last two arrivals paces the animation: measured, not
// configured, so it follows the clock's speed.
type TickTiming =
	| { seen: "none" }
	| { seen: "one"; tick: Tick; arrivedAt: number }
	| { seen: "paced"; tick: Tick; arrivedAt: number; duration: number };

export const noTickTiming: TickTiming = { seen: "none" };

// The latest tick seen again (an unchanged view) is not a new arrival.
export function observeTick(
	timing: TickTiming,
	tick: Tick,
	now: number,
): TickTiming {
	if (timing.seen === "none") return { seen: "one", tick, arrivedAt: now };
	if (tick === timing.tick) return timing;
	return {
		seen: "paced",
		tick,
		arrivedAt: now,
		duration: now - timing.arrivedAt,
	};
}

// Share of the current tick elapsed, for driverPosition. 1 (drivers at their
// cells) until a duration is known, and while the next tick is late. Two
// ticks arriving in the same millisecond give no usable pace: 1 too.
export function tickFraction(timing: TickTiming, now: number): number {
	if (timing.seen !== "paced" || timing.duration <= 0) return 1;
	return Math.min(1, (now - timing.arrivedAt) / timing.duration);
}

// Draws the view on every animation frame: dots, or above the threshold the
// heatmap, recomputed once per tick rather than per frame (ADR 0053), then
// surging zones over either (ADR 0054). Call show() after each event applied
// to the view (it is updated in place). layout: the run's regions.
export function startRenderer(
	canvas: HTMLCanvasElement,
	grid: Grid,
	layout: RegionLayout,
): { show(view: View): void } {
	const context = canvas.getContext("2d");
	if (context === null) throw new Error("canvas 2D context unavailable");
	let view = emptyView();
	let timing = noTickTiming;
	// The heatmap image, one pixel per tile, and the tick and fleet size it
	// shows; null while dots are drawn. Remade on the first frame after a new
	// clock.ticked, before most of that tick's moves arrive: mostly tick t-1's
	// end state, at most a cell off per driver, invisible at tile size. A new
	// fleet size (the view reset, tick kept) remakes it too.
	let heatmap: {
		image: OffscreenCanvas;
		tick: Tick | null;
		fleetSize: number;
	} | null = null;

	const frame = (now: number) => {
		const size = fitToDisplay(context);
		drawCity(context, grid, size);
		if (drawModeOf(view) === "dots") {
			heatmap = null;
			drawDots(context, view, grid, size, tickFraction(timing, now));
		} else {
			const fleetSize = fleetSizeOf(view);
			if (
				heatmap === null ||
				heatmap.tick !== view.tick ||
				heatmap.fleetSize !== fleetSize
			) {
				heatmap = {
					image: heatmapImage(view, grid),
					tick: view.tick,
					fleetSize,
				};
			}
			drawHeatmap(context, heatmap.image, grid, size);
		}
		drawSurge(context, surgeAreasOf(view, layout, grid), grid, size);
		requestAnimationFrame(frame);
	};
	requestAnimationFrame(frame);

	return {
		show(next) {
			if (next.tick !== null) {
				timing = observeTick(timing, next.tick, performance.now());
			}
			view = next;
		},
	};
}

function drawCity(
	context: CanvasRenderingContext2D,
	grid: Grid,
	size: Size,
): void {
	context.fillStyle = backgroundColor;
	context.fillRect(0, 0, size.width, size.height);
	const topLeft = cellToPixel({ x: -0.5, y: -0.5 }, grid, size);
	const bottomRight = cellToPixel(
		{ x: grid.width - 0.5, y: grid.height - 0.5 },
		grid,
		size,
	);
	context.fillStyle = cityColor;
	context.fillRect(
		topLeft.x,
		topLeft.y,
		bottomRight.x - topLeft.x,
		bottomRight.y - topLeft.y,
	);
}

function drawDots(
	context: CanvasRenderingContext2D,
	view: View,
	grid: Grid,
	size: Size,
	fraction: number,
): void {
	const toPixel = (cell: Point) => cellToPixel(cell, grid, size);

	context.strokeStyle = activeTripColor;
	context.lineWidth = 1;
	context.beginPath();
	for (const trip of view.activeTrips.values()) {
		const pickup = toPixel(trip.pickup);
		const dropoff = toPixel(trip.dropoff);
		context.moveTo(pickup.x, pickup.y);
		context.lineTo(dropoff.x, dropoff.y);
	}
	context.stroke();

	context.strokeStyle = waitingRiderColor;
	context.lineWidth = 1.5;
	for (const rider of view.waitingRiders.values()) {
		const pickup = toPixel(rider.pickup);
		const half = waitingRiderSize / 2;
		context.strokeRect(
			pickup.x - half,
			pickup.y - half,
			waitingRiderSize,
			waitingRiderSize,
		);
	}

	forEachDriver(view, (_index, driver) => {
		const position = toPixel(driverPosition(driver, view.tick, fraction));
		context.fillStyle = driverColors[driver.state];
		context.beginPath();
		context.arc(position.x, position.y, driverRadius, 0, 2 * Math.PI);
		context.fill();
	});
}

// Tinted more the higher the surge, outlined, labeled at the center.
function drawSurge(
	context: CanvasRenderingContext2D,
	areas: SurgeArea[],
	grid: Grid,
	size: Size,
): void {
	context.font = "bold 12px system-ui, sans-serif";
	context.textAlign = "center";
	context.textBaseline = "middle";
	context.lineWidth = 1;
	for (const { min, max, surge } of areas) {
		const topLeft = cellToPixel({ x: min.x - 0.5, y: min.y - 0.5 }, grid, size);
		const bottomRight = cellToPixel(
			{ x: max.x + 0.5, y: max.y + 0.5 },
			grid,
			size,
		);
		const width = bottomRight.x - topLeft.x;
		const height = bottomRight.y - topLeft.y;
		context.globalAlpha = 0.15 + 0.35 * (surge - 1);
		context.fillStyle = surgeColor;
		context.fillRect(topLeft.x, topLeft.y, width, height);
		context.globalAlpha = 1;
		context.strokeStyle = surgeColor;
		context.strokeRect(topLeft.x, topLeft.y, width, height);
		const label = surgeLabel(surge);
		const center = { x: topLeft.x + width / 2, y: topLeft.y + height / 2 };
		context.lineWidth = 3;
		context.strokeStyle = backgroundColor;
		context.strokeText(label, center.x, center.y);
		context.fillStyle = "#ffffff";
		context.fillText(label, center.x, center.y);
		context.lineWidth = 1;
	}
}

function heatmapImage(view: View, grid: Grid): OffscreenCanvas {
	const { columns, rows, rgba } = heatmapOf(view, grid);
	const image = new OffscreenCanvas(columns, rows);
	const imageContext = image.getContext("2d");
	if (imageContext === null)
		throw new Error("offscreen 2D context unavailable");
	imageContext.putImageData(new ImageData(rgba, columns, rows), 0, 0);
	return image;
}

// One image pixel per tile, scaled up unsmoothed so tiles keep sharp edges.
function drawHeatmap(
	context: CanvasRenderingContext2D,
	image: OffscreenCanvas,
	grid: Grid,
	size: Size,
): void {
	const topLeft = cellToPixel({ x: -0.5, y: -0.5 }, grid, size);
	const bottomRight = cellToPixel(
		{
			x: image.width * cellsPerTile - 0.5,
			y: image.height * cellsPerTile - 0.5,
		},
		grid,
		size,
	);
	context.imageSmoothingEnabled = false;
	context.drawImage(
		image,
		topLeft.x,
		topLeft.y,
		bottomRight.x - topLeft.x,
		bottomRight.y - topLeft.y,
	);
}

// Sizes the backing store to the canvas's CSS size times devicePixelRatio, so
// lines stay crisp on high-DPI screens, and scales drawing back to CSS pixels.
function fitToDisplay(context: CanvasRenderingContext2D): Size {
	const canvas = context.canvas;
	const size = { width: canvas.clientWidth, height: canvas.clientHeight };
	const ratio = window.devicePixelRatio;
	const width = Math.round(size.width * ratio);
	const height = Math.round(size.height * ratio);
	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
	}
	context.setTransform(ratio, 0, 0, ratio, 0, 0);
	return size;
}
