// Spike #272 (not for merge): drivers by index in typed arrays.
// state: 0 absent, 1 idle, 2 en_route, 3 at_pickup, 4 on_trip, 5 at_dropoff.
import type { SimEvent } from "../shared/messages.ts";

function indexOf(driverId: string): number {
	return Number(driverId.slice(2));
}

export const fleet = {
	size: 0,
	xs: new Uint16Array(0),
	ys: new Uint16Array(0),
	states: new Uint8Array(0),
	ensure(size: number) {
		if (size === this.size) return;
		this.size = size;
		this.xs = new Uint16Array(size);
		this.ys = new Uint16Array(size);
		this.states = new Uint8Array(size);
	},
	onStateEvent(event: SimEvent) {
		const set = (driverId: string, state: number) => {
			const i = indexOf(driverId);
			if (i < this.size && (this.states[i] ?? 0) !== 0) this.states[i] = state;
		};
		switch (event.type) {
			case "trip.matched":
				return set(event.driverId, 2);
			case "driver.arrived_at_pickup":
				return set(event.driverId, 3);
			case "trip.picked_up":
				return set(event.driverId, 4);
			case "driver.arrived_at_dropoff":
				return set(event.driverId, 5);
			case "trip.completed":
				return set(event.driverId, 1);
			case "trip.cancelled":
				if (event.driverId !== null) set(event.driverId, 1);
				return;
			case "driver.went_offline": {
				const i = indexOf(event.driverId);
				if (i < this.size) this.states[i] = 0;
				return;
			}
			default:
				return;
		}
	},
};
