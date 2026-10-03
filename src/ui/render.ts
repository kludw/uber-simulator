import type { Grid } from "../shared/grid.ts";
import type { Tick } from "../shared/messages.ts";
import { type DriverView, emptyView, type View } from "./view.ts";

// Cell coordinates; fractional while a driver is between cells.
type Point = { x: number; y: number };
// CSS pixels.
type Size = { width: number; height: number };

// Legend colors: the one place a driver state gets its color.
const driverColors: Record<DriverView["state"], string> = {
	idle: "#8b949e",
	en_route: "#e3b341",
	at_pickup: "#f0883e",
	on_trip: "#3fb950",
	at_dropoff: "#58a6ff",
};
const backgroundColor = "#0d1117";
const cityColor = "#161b22";
const waitingRiderColor = "#ff7b72";
const activeTripColor = "rgba(88, 166, 255, 0.35)";
const driverRadius = 3;
const waitingRiderSize = 5;

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

// Draws the latest view on every animation frame. Call show() with each new
// view.
export function startRenderer(
	canvas: HTMLCanvasElement,
	grid: Grid,
): { show(view: View): void } {
	const context = canvas.getContext("2d");
	if (context === null) throw new Error("canvas 2D context unavailable");
	let view = emptyView();
	let timing = noTickTiming;

	const frame = (now: number) => {
		draw(context, view, grid, tickFraction(timing, now));
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

function draw(
	context: CanvasRenderingContext2D,
	view: View,
	grid: Grid,
	fraction: number,
): void {
	const size = fitToDisplay(context);
	const toPixel = (cell: Point) => cellToPixel(cell, grid, size);

	context.fillStyle = backgroundColor;
	context.fillRect(0, 0, size.width, size.height);
	const cityTopLeft = toPixel({ x: -0.5, y: -0.5 });
	const cityBottomRight = toPixel({
		x: grid.width - 0.5,
		y: grid.height - 0.5,
	});
	context.fillStyle = cityColor;
	context.fillRect(
		cityTopLeft.x,
		cityTopLeft.y,
		cityBottomRight.x - cityTopLeft.x,
		cityBottomRight.y - cityTopLeft.y,
	);

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

	for (const driver of view.drivers.values()) {
		const position = toPixel(driverPosition(driver, view.tick, fraction));
		context.fillStyle = driverColors[driver.state];
		context.beginPath();
		context.arc(position.x, position.y, driverRadius, 0, 2 * Math.PI);
		context.fill();
	}
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
