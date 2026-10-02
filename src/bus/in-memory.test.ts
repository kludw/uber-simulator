import { describe, expect, test } from "bun:test";
import {
	type CancelTrip,
	type ClockTicked,
	type Message,
	Tick,
	TripId,
} from "../shared/messages.ts";
import { createInMemoryBus } from "./in-memory.ts";

function ticked(n: number): ClockTicked {
	return { type: "clock.ticked", tick: Tick.parse(n) };
}

const cancelTrip: CancelTrip = {
	type: "cancel_trip",
	tripId: TripId.parse("t-1"),
};

function isClockTicked(message: Message): message is ClockTicked {
	return message.type === "clock.ticked";
}

function isCancelTrip(message: Message): message is CancelTrip {
	return message.type === "cancel_trip";
}

describe("in-memory bus", () => {
	test("drain delivers messages in publish order", () => {
		const bus = createInMemoryBus();
		const received: Message[] = [];
		bus.subscribe(isClockTicked, (message) => received.push(message));

		bus.publish(ticked(1));
		bus.publish(ticked(2));
		bus.drain();

		expect(received).toEqual([ticked(1), ticked(2)]);
	});

	test("each message reaches only accepting subscribers, in subscription order", () => {
		const bus = createInMemoryBus();
		const received: [string, Message][] = [];
		bus.subscribe(isClockTicked, (message) => received.push(["a", message]));
		bus.subscribe(isCancelTrip, (message) => received.push(["b", message]));
		bus.subscribe(isClockTicked, (message) => received.push(["c", message]));

		bus.publish(ticked(1));
		bus.publish(cancelTrip);
		bus.drain();

		expect(received).toEqual([
			["a", ticked(1)],
			["c", ticked(1)],
			["b", cancelTrip],
		]);
	});

	test("messages published while draining are delivered in the same drain, after earlier ones", () => {
		const bus = createInMemoryBus();
		const received: Message[] = [];
		bus.subscribe(isClockTicked, (message) => {
			received.push(message);
			if (message.tick === 1) bus.publish(cancelTrip);
		});
		bus.subscribe(isCancelTrip, (message) => received.push(message));

		bus.publish(ticked(1));
		bus.publish(ticked(2));
		bus.drain();

		expect(received).toEqual([ticked(1), ticked(2), cancelTrip]);
	});

	test("a message no subscriber accepts is dropped", () => {
		const bus = createInMemoryBus();
		const received: Message[] = [];
		bus.subscribe(isClockTicked, (message) => received.push(message));

		bus.publish(cancelTrip);
		bus.drain();
		bus.publish(ticked(1));
		bus.drain();

		expect(received).toEqual([ticked(1)]);
	});

	test("publish delivers nothing until drain", () => {
		const bus = createInMemoryBus();
		const received: Message[] = [];
		bus.subscribe(isClockTicked, (message) => received.push(message));

		bus.publish(ticked(1));

		expect(received).toEqual([]);
	});
});
