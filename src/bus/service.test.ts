import { describe, expect, test } from "bun:test";
import { decideDriverShard, startDriverShard } from "../driver/brain.ts";
import { cellIn, type Grid } from "../shared/grid.ts";
import {
	type CancelTrip,
	type ClockTicked,
	DriverId,
	driversWentOnline,
	type InputRejected,
	type Message,
	messageTypes,
	type Offer,
	Tick,
	TripId,
	type TripPickedUp,
} from "../shared/messages.ts";
import { createRandom } from "../shared/random.ts";
import { Region } from "../shared/regions.ts";
import { createInMemoryBus } from "./in-memory.ts";
import { startService } from "./service.ts";

// 1x1 grid: every random cell is (0, 0), so outputs are known literals.
const grid: Grid = { width: 1, height: 1 };
const origin = (() => {
	const result = cellIn(grid, 0, 0);
	if (!result.ok) throw new Error("origin outside grid");
	return result.value;
})();
const d1 = DriverId.parse("d-1");

function ticked(n: number): ClockTicked {
	return { type: "clock.ticked", tick: Tick.parse(n) };
}

function cancelTrip(id: string): CancelTrip {
	return {
		type: "cancel_trip",
		tripId: TripId.parse(id),
		region: Region.parse(0),
	};
}

const rejectedTick: InputRejected<Message, string> = {
	type: "input_rejected",
	reason: "stale_tick",
	input: ticked(1),
};

// Test brain: answers every tick with a rejection between two commands.
const rejectingService = {
	start: { state: null, outputs: [] },
	inputs: ["clock.ticked" as const],
	decide: (state: null) => ({
		state,
		outputs: [cancelTrip("t-1"), rejectedTick, cancelTrip("t-2")],
	}),
	random: createRandom(1),
};

function recordAll(bus: ReturnType<typeof createInMemoryBus>): Message[] {
	const published: Message[] = [];
	bus.subscribe(messageTypes, (message) => published.push(message));
	return published;
}

describe("startService", () => {
	test("publishes start outputs when the service starts", () => {
		const bus = createInMemoryBus();
		const published = recordAll(bus);
		const random = createRandom(1);

		startService(bus, {
			start: startDriverShard(
				{ grid, driverIds: [d1], tick: Tick.parse(0) },
				random,
			),
			inputs: [],
			decide: (state) => ({ state, outputs: [] }),
			random,
			log: () => {},
		});
		bus.drain();

		expect(published).toEqual([
			driversWentOnline(Tick.parse(0), Region.parse(0), [
				{ driverId: d1, cell: origin },
			]),
		]);
	});

	test("feeds each accepted message to decide in delivery order, carrying state", () => {
		const bus = createInMemoryBus();
		const decided: [number, Message][] = [];

		startService(bus, {
			start: { state: 0, outputs: [] },
			inputs: ["clock.ticked"],
			decide: (state: number, input) => {
				decided.push([state, input]);
				return { state: state + 1, outputs: [] };
			},
			random: createRandom(1),
			log: () => {},
		});
		bus.publish(ticked(1));
		bus.publish(ticked(2));
		bus.drain();

		expect(decided).toEqual([
			[0, ticked(1)],
			[1, ticked(2)],
		]);
	});

	test("publishes outputs in order, except input_rejected", () => {
		const bus = createInMemoryBus();
		const published = recordAll(bus);

		startService(bus, { ...rejectingService, log: () => {} });
		bus.publish(ticked(1));
		bus.drain();

		expect(published).toEqual([
			ticked(1),
			cancelTrip("t-1"),
			cancelTrip("t-2"),
		]);
	});

	test("logs input_rejected as a structured object", () => {
		const bus = createInMemoryBus();
		const logged: InputRejected<Message, string>[] = [];

		startService(bus, {
			...rejectingService,
			log: (rejected) => logged.push(rejected),
		});
		bus.publish(ticked(1));
		bus.drain();

		expect(logged).toEqual([
			{ type: "input_rejected", reason: "stale_tick", input: ticked(1) },
		]);
	});

	test("messages of types the service doesn't take never reach decide", () => {
		const bus = createInMemoryBus();
		const decided: Message[] = [];

		startService(bus, {
			start: { state: null, outputs: [] },
			inputs: ["clock.ticked"],
			decide: (state: null, input) => {
				decided.push(input);
				return { state, outputs: [] };
			},
			random: createRandom(1),
			log: () => {},
		});
		bus.publish(cancelTrip("t-1"));
		bus.publish(ticked(1));
		bus.drain();

		expect(decided).toEqual([ticked(1)]);
	});

	test("inputs the service doesn't accept never reach decide", () => {
		const bus = createInMemoryBus();
		const decided: Message[] = [];

		startService(bus, {
			start: { state: null, outputs: [] },
			inputs: ["cancel_trip"],
			accepts: (input) => input.tripId === "t-2",
			decide: (state: null, input) => {
				decided.push(input);
				return { state, outputs: [] };
			},
			random: createRandom(1),
			log: () => {},
		});
		bus.publish(cancelTrip("t-1"));
		bus.publish(cancelTrip("t-2"));
		bus.drain();

		expect(decided).toEqual([cancelTrip("t-2")]);
	});

	test("runs the driver brain: accepts an offer, logs a stale pickup", () => {
		const bus = createInMemoryBus();
		const published = recordAll(bus);
		const logged: InputRejected<Message, string>[] = [];
		const random = createRandom(1);
		const t1 = TripId.parse("t-1");
		const offer: Offer = {
			type: "offer",
			tripId: t1,
			driverId: d1,
			pickup: origin,
			dropoff: origin,
		};
		const pickedUp: TripPickedUp = {
			type: "trip.picked_up",
			tick: Tick.parse(1),
			tripId: t1,
			driverId: d1,
		};

		startService(bus, {
			start: startDriverShard(
				{ grid, driverIds: [d1], tick: Tick.parse(0) },
				random,
			),
			inputs: ["offer", "trip.picked_up"],
			decide: decideDriverShard,
			random,
			log: (rejected) => logged.push(rejected),
		});
		bus.publish(pickedUp);
		bus.publish(offer);
		bus.drain();

		expect({ published, logged }).toEqual({
			published: [
				driversWentOnline(Tick.parse(0), Region.parse(0), [
					{ driverId: d1, cell: origin },
				]),
				pickedUp,
				offer,
				{
					type: "offer_accepted",
					tripId: t1,
					driverId: d1,
					region: Region.parse(0),
				},
			],
			logged: [
				{
					type: "input_rejected",
					reason: "driver_not_at_pickup",
					input: pickedUp,
				},
			],
		});
	});
});
