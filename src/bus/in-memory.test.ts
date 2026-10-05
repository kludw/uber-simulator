import { describe, expect, test } from "bun:test";
import {
	type CancelTrip,
	type ClockTicked,
	type Message,
	Tick,
	TripId,
} from "../shared/messages.ts";
import { createRandom } from "../shared/random.ts";
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

function cancels(count: number): CancelTrip[] {
	return Array.from({ length: count }, (_, i) => ({
		type: "cancel_trip",
		tripId: TripId.parse(`t-${i}`),
	}));
}

// Publishes messages on a bus losing `share` with `seed`, and returns what each
// of two identical subscribers received.
function deliverLossy(
	share: number,
	seed: number,
	messages: Message[],
): { a: Message[]; b: Message[] } {
	const bus = createInMemoryBus({
		loss: { share, random: createRandom(seed) },
	});
	const received = { a: [] as Message[], b: [] as Message[] };
	bus.subscribe(isMessage, (message) => received.a.push(message));
	bus.subscribe(isMessage, (message) => received.b.push(message));
	for (const message of messages) bus.publish(message);
	bus.drain();
	return received;
}

function isMessage(_: Message): _ is Message {
	return true;
}

describe("in-memory bus with loss", () => {
	test("share 0 delivers every message to every subscriber", () => {
		const messages = cancels(100);

		expect(deliverLossy(0, 1, messages)).toEqual({ a: messages, b: messages });
	});

	test("the same seed drops the same deliveries", () => {
		const messages = cancels(100);

		expect(deliverLossy(0.5, 1, messages)).toEqual(
			deliverLossy(0.5, 1, messages),
		);
	});

	// 100 messages at share 0.5: losing none, or both subscribers losing the
	// same ones, is vanishingly unlikely.
	test("drops each delivery independently per subscriber", () => {
		const { a, b } = deliverLossy(0.5, 1, cancels(100));

		expect({
			someLost: a.length < 100,
			sameLost: Bun.deepEquals(a, b),
		}).toEqual({ someLost: true, sameLost: false });
	});

	test("never drops clock.ticked", () => {
		const ticks = [ticked(1), ticked(2), ticked(3)];

		expect(deliverLossy(1, 1, ticks)).toEqual({ a: ticks, b: ticks });
	});

	test("a recorder sees every message", () => {
		const bus = createInMemoryBus({
			loss: { share: 1, random: createRandom(1) },
		});
		const recorded: Message[] = [];
		bus.record((message) => recorded.push(message));
		const messages = cancels(3);

		for (const message of messages) bus.publish(message);
		bus.drain();

		expect(recorded).toEqual(messages);
	});
});
