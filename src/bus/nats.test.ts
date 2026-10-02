import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "@nats-io/transport-node";
import * as z from "zod";
import { Cell } from "../shared/grid.ts";
import {
	type CancelTrip,
	DriverId,
	type Message,
	RiderId,
	Tick,
	TripId,
} from "../shared/messages.ts";
import {
	connectNatsBus,
	type DroppedMessage,
	type NatsBus,
	subjectFor,
} from "./nats.ts";

const tick = Tick.parse(1);
const tripId = TripId.parse("t-1");
const driverId = DriverId.parse("d-7");
const riderId = RiderId.parse("r-1");
const cell = Cell.parse({ x: 0, y: 0 });

describe("subjectFor", () => {
	// Every Message type with its subject per ADR 0028.
	const cases: [Message, string][] = [
		[{ type: "clock.ticked", tick }, "sim.events.clock.ticked"],
		[
			{ type: "driver.went_online", tick, driverId, cell },
			"sim.events.driver.went_online",
		],
		[{ type: "driver.moved", tick, driverId, cell }, "sim.events.driver.moved"],
		[
			{ type: "driver.arrived_at_pickup", tick, driverId, tripId, cell },
			"sim.events.driver.arrived_at_pickup",
		],
		[
			{ type: "driver.arrived_at_dropoff", tick, driverId, tripId, cell },
			"sim.events.driver.arrived_at_dropoff",
		],
		[
			{
				type: "trip.requested",
				tick,
				tripId,
				riderId,
				pickup: cell,
				dropoff: cell,
			},
			"sim.events.trip.requested",
		],
		[
			{ type: "trip.offered", tick, tripId, driverId },
			"sim.events.trip.offered",
		],
		[
			{ type: "trip.offer_declined", tick, tripId, driverId },
			"sim.events.trip.offer_declined",
		],
		[
			{ type: "trip.offer_expired", tick, tripId, driverId },
			"sim.events.trip.offer_expired",
		],
		[
			{ type: "trip.matched", tick, tripId, driverId },
			"sim.events.trip.matched",
		],
		[
			{ type: "trip.picked_up", tick, tripId, driverId },
			"sim.events.trip.picked_up",
		],
		[
			{ type: "trip.completed", tick, tripId, driverId },
			"sim.events.trip.completed",
		],
		[
			{ type: "trip.cancelled", tick, tripId, driverId: null },
			"sim.events.trip.cancelled",
		],
		[
			{ type: "offer", tripId, driverId, pickup: cell, dropoff: cell },
			"sim.offers.d-7",
		],
		[
			{ type: "offer_accepted", tripId, driverId },
			"sim.replies.offer_accepted",
		],
		[
			{ type: "offer_declined", tripId, driverId },
			"sim.replies.offer_declined",
		],
		[
			{
				type: "request_trip",
				tick,
				tripId,
				riderId,
				pickup: cell,
				dropoff: cell,
			},
			"sim.commands.request_trip",
		],
		[
			{ type: "request_trip_accepted", tripId },
			"sim.replies.request_trip_accepted",
		],
		[
			{
				type: "request_trip_rejected",
				tripId,
				error: { type: "duplicate_trip_id" },
			},
			"sim.replies.request_trip_rejected",
		],
		[{ type: "cancel_trip", tripId }, "sim.commands.cancel_trip"],
		[
			{ type: "cancel_trip_accepted", tripId },
			"sim.replies.cancel_trip_accepted",
		],
		[
			{
				type: "cancel_trip_rejected",
				tripId,
				error: { type: "unknown_trip" },
			},
			"sim.replies.cancel_trip_rejected",
		],
	];

	test.each(cases)("%p goes on %s", (message, subject) => {
		expect(subjectFor(message)).toBe(subject);
	});
});

describe("connectNatsBus", () => {
	test("returns an error when no server listens at the url", async () => {
		// Port 1 is privileged and unused, so the connection is refused.
		const result = await connectNatsBus({
			url: "nats://127.0.0.1:1",
			log: () => {},
		});

		expect(result).toMatchObject({
			ok: false,
			error: { type: "nats_connect_failed", url: "nats://127.0.0.1:1" },
		});
	});
});

// Integration tests need a real server: `docker compose up -d --wait`, then
// NATS_URL from .env (Bun loads it) or the environment.
const natsUrl = z.url().optional().parse(Bun.env.NATS_URL);
if (!natsUrl) {
	console.warn("NATS_URL unset: skipping NATS bus integration tests");
}

describe.skipIf(!natsUrl)("NATS bus", () => {
	// Other runs may share the server: each test uses its own trip IDs and
	// accepts only those.
	const runId = crypto.randomUUID();
	const open: NatsBus[] = [];

	afterEach(async () => {
		await Promise.all(open.splice(0).map((bus) => bus.close()));
	});

	async function connectBus(log: (dropped: DroppedMessage) => void = () => {}) {
		const result = await connectNatsBus({ url: natsUrl ?? "", log });
		if (!result.ok) throw new Error("NATS unavailable", { cause: result });
		open.push(result.value);
		return result.value;
	}

	function cancelTrip(n: number): CancelTrip {
		return { type: "cancel_trip", tripId: TripId.parse(`${runId}-${n}`) };
	}

	function isOwnCancelTrip(message: Message): message is CancelTrip {
		return message.type === "cancel_trip" && message.tripId.startsWith(runId);
	}

	async function waitFor(condition: () => boolean): Promise<void> {
		for (let attempt = 0; attempt < 100; attempt++) {
			if (condition()) return;
			await Bun.sleep(20);
		}
	}

	test("a subscriber on another connection receives messages in publish order", async () => {
		const publisher = await connectBus();
		const subscriber = await connectBus();
		const received: Message[] = [];
		subscriber.subscribe(isOwnCancelTrip, (message) => received.push(message));
		const sent = Array.from({ length: 50 }, (_, n) => cancelTrip(n));

		for (const message of sent) publisher.publish(message);
		await waitFor(() => received.length >= sent.length);

		expect(received).toEqual(sent);
	});

	test("each message reaches only subscribers that accept it", async () => {
		const bus = await connectBus();
		const received: [string, Message][] = [];
		const isCancelTrip =
			(n: number) =>
			(message: Message): message is CancelTrip =>
				isOwnCancelTrip(message) && message.tripId === cancelTrip(n).tripId;
		bus.subscribe(isCancelTrip(1), (message) =>
			received.push(["one", message]),
		);
		bus.subscribe(isCancelTrip(2), (message) =>
			received.push(["two", message]),
		);

		// Trip 1 last: once it arrives, trips 2 and 3 were handled (one publisher).
		bus.publish(cancelTrip(2));
		bus.publish(cancelTrip(3));
		bus.publish(cancelTrip(1));
		await waitFor(() => received.length >= 2);

		expect(received).toEqual([
			["two", cancelTrip(2)],
			["one", cancelTrip(1)],
		]);
	});

	test("handlers run one at a time, even when a handler publishes", async () => {
		const bus = await connectBus();
		const trace: string[] = [];
		bus.subscribe(isOwnCancelTrip, (message) => {
			trace.push(`start ${message.tripId}`);
			if (message.tripId === cancelTrip(1).tripId) bus.publish(cancelTrip(2));
			trace.push(`end ${message.tripId}`);
		});

		bus.publish(cancelTrip(1));
		await waitFor(() => trace.length >= 4);

		const [t1, t2] = [cancelTrip(1).tripId, cancelTrip(2).tripId];
		expect(trace).toEqual([
			`start ${t1}`,
			`end ${t1}`,
			`start ${t2}`,
			`end ${t2}`,
		]);
	});

	test("invalid payloads on sim.> are logged and dropped", async () => {
		const logged: DroppedMessage[] = [];
		const bus = await connectBus((dropped) => logged.push(dropped));
		const received: Message[] = [];
		bus.subscribe(isOwnCancelTrip, (message) => received.push(message));
		// A raw connection can publish what the bus never would; one publisher
		// keeps the valid message last.
		const raw = await connect({ servers: natsUrl });
		const subject = `sim.test.${runId}`;

		raw.publish(subject, "{not json");
		raw.publish(subject, JSON.stringify({ type: "no_such_message" }));
		raw.publish(subject, JSON.stringify(cancelTrip(1)));
		await raw.drain();
		await waitFor(() => received.length >= 1);

		expect({
			logged: logged.filter((dropped) => dropped.subject === subject),
			received,
		}).toMatchObject({
			logged: [
				{ subject, error: { type: "invalid_json" } },
				{ subject, error: { type: "invalid_message" } },
			],
			received: [cancelTrip(1)],
		});
	});
});
