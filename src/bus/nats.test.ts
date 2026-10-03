import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "@nats-io/transport-node";
import * as z from "zod";
import { Cell } from "../shared/grid.ts";
import {
	type CancelTrip,
	DriverId,
	type Message,
	RiderId,
	RunId,
	Tick,
	TripId,
} from "../shared/messages.ts";
import {
	type ConnectionStatus,
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
const testRunId = RunId.parse("test-run-1");

describe("subjectFor", () => {
	// Every Message type with its subject per ADR 0028.
	const cases: [Message, string][] = [
		[{ type: "clock.ticked", tick }, "sim.events.clock.ticked"],
		[
			{ type: "driver.went_online", tick, driverId, cell },
			"sim.events.driver.went_online",
		],
		[
			{ type: "driver.went_offline", tick, driverId, cell },
			"sim.events.driver.went_offline",
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
			runId: testRunId,
			log: () => {},
			logStatus: () => {},
		});

		expect(result).toMatchObject({
			ok: false,
			error: { type: "nats_connect_failed", url: "nats://127.0.0.1:1" },
		});
	});

	test("gives up the connection when the server drops it during setup", async () => {
		// Completes every handshake (PONG to the first PING) but hangs up on the
		// first connection's next PING, the bus's flush after SUB. Later
		// connections (reconnects) stay up.
		let firstConnectionPings = 0;
		const server = fakeNatsServer((socket, text, connection) => {
			for (const _ of text.matchAll(/PING\r\n/g)) {
				if (connection === 1 && ++firstConnectionPings > 1) {
					socket.end();
					return;
				}
				socket.write("PONG\r\n");
			}
		});

		const result = await connectNatsBus({
			url: server.url,
			runId: testRunId,
			log: () => {},
			logStatus: () => {},
		});
		// A client left behind reconnects after its 2 s reconnect wait.
		await Bun.sleep(2500);
		const leftOpen = server.openSockets();
		server.stop();

		expect({ result, leftOpen }).toMatchObject({
			result: {
				ok: false,
				error: { type: "nats_connect_failed", url: server.url },
			},
			leftOpen: 0,
		});
	}, 10_000);

	test("closing a bus while it is reconnecting resolves", async () => {
		// Hangs up on the first publish and stops listening, so the client
		// keeps reconnecting.
		const server = fakeNatsServer((socket, text) => {
			if (text.includes("PUB ")) {
				socket.end();
				server.stop();
				return;
			}
			pong(socket, text);
		});
		const bus = await connectFake(server.url, () => {});
		bus.publish({ type: "cancel_trip", tripId: TripId.parse("t-1") });
		await Bun.sleep(100);

		await expect(bus.close()).resolves.toBeUndefined();
	}, 10_000);

	test("closing a bus whose connection the server closed resolves", async () => {
		// Rejects the connection as unauthorized on its first publish, and every
		// reconnect too, so the client gives up and closes the connection.
		const server = fakeNatsServer((socket, text, connection) => {
			if (connection > 1 || text.includes("PUB ")) {
				socket.write("-ERR 'Authorization Violation'\r\n");
				return;
			}
			pong(socket, text);
		});
		const bus = await connectFake(server.url, () => {});
		bus.publish({ type: "cancel_trip", tripId: TripId.parse("t-1") });
		// One reconnect after its 2 s wait, rejected again: connection closed.
		await Bun.sleep(3000);
		server.stop();

		await expect(bus.close()).resolves.toBeUndefined();
	}, 10_000);

	test("logs the connection dropping, coming back, and closing", async () => {
		// Hangs up the first connection on its first publish; the reconnect
		// stays up.
		const server = fakeNatsServer((socket, text, connection) => {
			if (connection === 1 && text.includes("PUB ")) {
				socket.end();
				return;
			}
			pong(socket, text);
		});
		const statuses: ConnectionStatus[] = [];
		const bus = await connectFake(server.url, (status) =>
			statuses.push(status),
		);
		bus.publish({ type: "cancel_trip", tripId: TripId.parse("t-1") });
		// Reconnects after its 2 s wait.
		await Bun.sleep(2500);
		await bus.close();
		server.stop();

		expect(statuses).toEqual([
			{ type: "nats_disconnected", server: server.address },
			{ type: "nats_reconnected", server: server.address },
			{ type: "nats_closed" },
		]);
	}, 10_000);
});

type FakeSocket = Bun.Socket<{ connection: number }>;

// Fake NATS server on a free port: greets each connection with INFO and
// hands every chunk the client sends to `respond`, with the connection's
// number (1 = first, later ones are reconnects).
function fakeNatsServer(
	respond: (socket: FakeSocket, text: string, connection: number) => void,
) {
	let connections = 0;
	let openSockets = 0;
	const server = Bun.listen<{ connection: number }>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				connections++;
				openSockets++;
				socket.data = { connection: connections };
				socket.write(
					'INFO {"server_id":"fake","version":"2.15.0","max_payload":1048576,"headers":true}\r\n',
				);
			},
			data(socket, chunk) {
				respond(socket, chunk.toString(), socket.data.connection);
			},
			close() {
				openSockets--;
			},
		},
	});
	return {
		url: `nats://127.0.0.1:${server.port}`,
		address: `127.0.0.1:${server.port}`,
		openSockets: () => openSockets,
		stop: () => server.stop(true),
	};
}

function pong(socket: FakeSocket, text: string): void {
	for (const _ of text.matchAll(/PING\r\n/g)) socket.write("PONG\r\n");
}

async function connectFake(
	url: string,
	logStatus: (status: ConnectionStatus) => void,
): Promise<NatsBus> {
	const result = await connectNatsBus({
		url,
		runId: testRunId,
		log: () => {},
		logStatus,
	});
	if (!result.ok) throw new Error("fake server unreachable", { cause: result });
	return result.value;
}

// Integration tests need a real server: `docker compose up -d --wait`, then
// NATS_URL from .env (Bun loads it) or the environment.
const natsUrl = z.url().optional().parse(Bun.env.NATS_URL);
if (!natsUrl) {
	console.warn("NATS_URL unset: skipping NATS bus integration tests");
}

describe.skipIf(!natsUrl)("NATS bus", () => {
	// Other runs may share the server: each test uses its own trip IDs and
	// accepts only those.
	const tripIdSalt = crypto.randomUUID();
	const open: NatsBus[] = [];

	afterEach(async () => {
		await Promise.all(open.splice(0).map((bus) => bus.close()));
	});

	async function connectBus(log: (dropped: DroppedMessage) => void = () => {}) {
		const result = await connectNatsBus({
			url: natsUrl ?? "",
			runId: testRunId,
			log,
			logStatus: () => {},
		});
		if (!result.ok) throw new Error("NATS unavailable", { cause: result });
		open.push(result.value);
		return result.value;
	}

	function cancelTrip(n: number): CancelTrip {
		return { type: "cancel_trip", tripId: TripId.parse(`${tripIdSalt}-${n}`) };
	}

	function isOwnCancelTrip(message: Message): message is CancelTrip {
		return (
			message.type === "cancel_trip" && message.tripId.startsWith(tripIdSalt)
		);
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

	test("every published message carries the bus's run id as a Run-Id header", async () => {
		const bus = await connectBus();
		// A raw connection sees headers, which the bus port hides.
		const raw = await connect({ servers: natsUrl });
		const subscription = raw.subscribe("sim.commands.cancel_trip");
		await raw.flush();
		const received: (string | undefined)[] = [];
		const reading = (async () => {
			for await (const message of subscription) {
				if (!message.string().includes(tripIdSalt)) continue;
				received.push(message.headers?.get("Run-Id"));
				if (received.length === 2) break;
			}
		})();

		bus.publish(cancelTrip(1));
		bus.publish(cancelTrip(2));
		await reading;
		await raw.close();

		expect(received).toEqual([testRunId, testRunId]);
	});

	test("closing an already closed bus resolves", async () => {
		const bus = await connectBus();

		await bus.close();

		await expect(bus.close()).resolves.toBeUndefined();
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
		const subject = `sim.test.${tripIdSalt}`;

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
