import * as z from "zod";
import type { Cell } from "./grid.ts";

export const DriverId = z.string().min(1).brand<"DriverId">();
export type DriverId = z.infer<typeof DriverId>;

export const Tick = z.int().nonnegative().brand<"Tick">();
export type Tick = z.infer<typeof Tick>;

export type DriverWentOnline = {
	type: "driver.went_online";
	driverId: DriverId;
	cell: Cell;
};

export type DriverMoved = {
	type: "driver.moved";
	tick: Tick;
	driverId: DriverId;
	cell: Cell;
};
