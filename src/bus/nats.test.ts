import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "@nats-io/transport-node";
import * as z from "zod";
import {
	type CancelTrip,
	type Message,
	type MessageType,
	type RequestTripAccepted,
	RunId,
	TripId,
} from "../shared/messages.ts";
import { Region } from "../shared/regions.ts";
import {
	type ConnectionStatus,
	connectNatsBus,
	type DroppedMessage,
	type MessagesTimed,
	type NatsBus,
} from "./nats.ts";

const testRunId = RunId.parse("test-run-1");

describe("connectNatsBus", () => {
	test("returns an error when no server listens at the url", async () => {
		// Port 1 is privileged and unused, so the connection is refused.
		const result = await connectNatsBus({
			url: "nats://127.0.0.1:1",
			runId: testRunId,
			log: () => {},
			logStatus: () => {},
			logTiming: () => {},
			inputs: ["cancel_trip"],
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
			logTiming: () => {},
			inputs: ["cancel_trip"],
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
		bus.publish({
			type: "cancel_trip",
			tripId: TripId.parse("t-1"),
			region: Region.parse(0),
		});
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
		bus.publish({
			type: "cancel_trip",
			tripId: TripId.parse("t-1"),
			region: Region.parse(0),
		});
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
		bus.publish({
			type: "cancel_trip",
			tripId: TripId.parse("t-1"),
			region: Region.parse(0),
		});
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

	test("logs messages received and delivered, and ms decoding and handling, every 10 s and on close", async () => {
		// A fake server, so no other publisher adds messages: it pushes the
		// test's payloads on the bus's subscription.
		let client: FakeSocket | undefined;
		let sid = "";
		const server = fakeNatsServer((socket, text) => {
			const subscribed = text.match(/SUB sim\.commands\.cancel_trip (\S+)\r\n/);
			if (subscribed?.[1]) {
				client = socket;
				sid = subscribed[1];
			}
			pong(socket, text);
		});
		// Controlled time: only handling takes any, 6 s per message.
		let nowMs = 0;
		const timed: MessagesTimed[] = [];
		const result = await connectNatsBus({
			url: server.url,
			runId: testRunId,
			log: () => {},
			logStatus: () => {},
			logTiming: (timing) => timed.push(timing),
			now: () => nowMs,
			inputs: ["cancel_trip"],
		});
		if (!result.ok) throw new Error("fake server unreachable");
		const bus = result.value;
		const { promise: lastHandled, resolve: handledLast } =
			Promise.withResolvers<void>();
		bus.subscribe(["cancel_trip"], (message) => {
			nowMs += 6000;
			if (message.tripId === "t-3") handledLast();
		});
		const push = (payload: string) =>
			client?.write(
				`MSG sim.commands.cancel_trip ${sid} ${Buffer.byteLength(payload)}\r\n${payload}\r\n`,
			);

		push(
			JSON.stringify({
				type: "cancel_trip",
				tripId: "t-1",
				region: Region.parse(0),
			}),
		);
		// A type no subscriber takes, then not a message at all.
		push(JSON.stringify({ type: "request_trip_accepted", tripId: "t-9" }));
		push("{not json");
		push(
			JSON.stringify({
				type: "cancel_trip",
				tripId: "t-2",
				region: Region.parse(0),
			}),
		);
		push(
			JSON.stringify({
				type: "cancel_trip",
				tripId: "t-3",
				region: Region.parse(0),
			}),
		);
		await lastHandled;
		await bus.close();
		server.stop();

		expect(timed).toEqual([
			{
				type: "messages_timed",
				intervalMs: 12_000,
				received: 4,
				decodeMs: 0,
				delivered: 2,
				handleMs: 12_000,
				byType: {
					cancel_trip: { received: 2, decodeMs: 0, handleMs: 12_000 },
					request_trip_accepted: { received: 1, decodeMs: 0, handleMs: 0 },
				},
			},
			{
				type: "messages_timed",
				intervalMs: 6000,
				received: 1,
				decodeMs: 0,
				delivered: 1,
				handleMs: 6000,
				byType: {
					cancel_trip: { received: 1, decodeMs: 0, handleMs: 6000 },
				},
			},
		]);
	}, 10_000);

	test("splits messages received and ms decoding and handling by message type", async () => {
		// A fake server, so no other publisher adds messages.
		let client: FakeSocket | undefined;
		const sids = new Map<string, string>();
		const server = fakeNatsServer((socket, text) => {
			for (const [, subject, sid] of text.matchAll(/SUB (\S+) (\S+)\r\n/g)) {
				if (subject && sid) sids.set(subject, sid);
				client = socket;
			}
			pong(socket, text);
		});
		// Controlled time: only handling takes any, 1 s per drivers.moved and
		// 3 s per cancel_trip, under the 10 s interval: one entry, on close.
		let nowMs = 0;
		const timed: MessagesTimed[] = [];
		const result = await connectNatsBus({
			url: server.url,
			runId: testRunId,
			log: () => {},
			logStatus: () => {},
			logTiming: (timing) => timed.push(timing),
			now: () => nowMs,
			inputs: ["cancel_trip", "drivers.moved"],
		});
		if (!result.ok) throw new Error("fake server unreachable");
		const bus = result.value;
		const { promise: lastHandled, resolve: handledLast } =
			Promise.withResolvers<void>();
		bus.subscribe(["cancel_trip", "drivers.moved"], (message) => {
			nowMs += message.type === "drivers.moved" ? 1000 : 3000;
			if (message.type === "cancel_trip") handledLast();
		});
		const push = (subject: string, payload: string) =>
			client?.write(
				`MSG ${subject} ${sids.get(subject)} ${Buffer.byteLength(payload)}\r\n${payload}\r\n`,
			);
		const moved = (driverId: string) =>
			JSON.stringify({
				type: "drivers.moved",
				tick: 1,
				driverIds: [driverId],
				xs: [0],
				ys: [0],
			});

		push("sim.events.drivers.moved", moved("d-1"));
		push("sim.events.drivers.moved", moved("d-2"));
		push(
			"sim.commands.cancel_trip",
			JSON.stringify({
				type: "cancel_trip",
				tripId: "t-1",
				region: Region.parse(0),
			}),
		);
		await lastHandled;
		await bus.close();
		server.stop();

		expect(timed.map((timing) => timing.byType)).toEqual([
			{
				"drivers.moved": { received: 2, decodeMs: 0, handleMs: 2000 },
				cancel_trip: { received: 1, decodeMs: 0, handleMs: 3000 },
			},
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
		logTiming: () => {},
		inputs: ["cancel_trip"],
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

	async function connectBus(
		options: {
			inputs?: readonly MessageType[];
			log?: (dropped: DroppedMessage) => void;
			logTiming?: (timing: MessagesTimed) => void;
		} = {},
	) {
		const result = await connectNatsBus({
			url: natsUrl ?? "",
			runId: testRunId,
			log: options.log ?? (() => {}),
			logStatus: () => {},
			logTiming: options.logTiming ?? (() => {}),
			inputs: options.inputs ?? ["cancel_trip"],
		});
		if (!result.ok) throw new Error("NATS unavailable", { cause: result });
		open.push(result.value);
		return result.value;
	}

	function cancelTrip(n: number): CancelTrip {
		return {
			type: "cancel_trip",
			tripId: TripId.parse(`${tripIdSalt}-${n}`),
			region: Region.parse(0),
		};
	}

	function isOwn(message: { tripId: string }): boolean {
		return message.tripId.startsWith(tripIdSalt);
	}

	function requestTripAccepted(n: number): RequestTripAccepted {
		return {
			type: "request_trip_accepted",
			tripId: TripId.parse(`${tripIdSalt}-${n}`),
		};
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
		subscriber.subscribe(["cancel_trip"], (message) => {
			if (isOwn(message)) received.push(message);
		});
		const sent = Array.from({ length: 50 }, (_, n) => cancelTrip(n));

		for (const message of sent) publisher.publish(message);
		await waitFor(() => received.length >= sent.length);

		expect(received).toEqual(sent);
	});

	// ADR 0042: one NATS subscription per type, delivered from one callback,
	// so a publisher's order holds across subscriptions (e.g. dispatch's offer
	// before its trip.cancelled, at a driver shard).
	test("a subscriber to several types receives them in publish order", async () => {
		const publisher = await connectBus();
		const subscriber = await connectBus({
			inputs: ["cancel_trip", "request_trip_accepted"],
		});
		const received: Message[] = [];
		subscriber.subscribe(
			["cancel_trip", "request_trip_accepted"],
			(message) => {
				if (isOwn(message)) received.push(message);
			},
		);
		const sent = Array.from({ length: 50 }, (_, n) =>
			n % 2 === 0 ? cancelTrip(n) : requestTripAccepted(n),
		);

		for (const message of sent) publisher.publish(message);
		await waitFor(() => received.length >= sent.length);

		expect(received).toEqual(sent);
	});

	test("each message reaches only subscribers to its type, in subscription order", async () => {
		const bus = await connectBus({
			inputs: ["cancel_trip", "request_trip_accepted"],
		});
		const received: [string, Message][] = [];
		bus.subscribe(["cancel_trip"], (message) => {
			if (isOwn(message)) received.push(["a", message]);
		});
		bus.subscribe(["request_trip_accepted"], (message) => {
			if (isOwn(message)) received.push(["b", message]);
		});
		bus.subscribe(["cancel_trip"], (message) => {
			if (isOwn(message)) received.push(["c", message]);
		});

		bus.publish(requestTripAccepted(1));
		bus.publish(cancelTrip(2));
		await waitFor(() => received.length >= 3);

		expect(received).toEqual([
			["b", requestTripAccepted(1)],
			["a", cancelTrip(2)],
			["c", cancelTrip(2)],
		]);
	});

	test("a bus never receives types outside its inputs", async () => {
		const publisher = await connectBus({
			inputs: [],
		});
		const timed: MessagesTimed[] = [];
		const subscriber = await connectBus({
			logTiming: (timing) => timed.push(timing),
		});
		const received: Message[] = [];
		subscriber.subscribe(["cancel_trip"], (message) => {
			if (isOwn(message)) received.push(message);
		});

		// One publisher: once the cancel_trip arrives, the reply before it would have.
		publisher.publish(requestTripAccepted(1));
		publisher.publish(cancelTrip(2));
		await waitFor(() => received.length >= 1);
		await subscriber.close();

		expect(timed.reduce((sum, timing) => sum + timing.received, 0)).toBe(1);
	});

	test("subscribing to a type outside the bus's inputs is a bug", async () => {
		const bus = await connectBus();

		expect(() => bus.subscribe(["trip_status"], () => {})).toThrow();
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

	// bun test intercepts uncaught errors, so the bus runs in its own process.
	test("a handler's throw surfaces outside the client: the process exits non-zero", async () => {
		const child = Bun.spawn(
			[
				"bun",
				`${import.meta.dir}/handler-throws.fixture.ts`,
				cancelTrip(1).tripId,
			],
			{
				env: { ...Bun.env, NATS_URL: natsUrl },
				stdout: "ignore",
				stderr: "pipe",
			},
		);
		const [exitCode, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
		]);

		expect({ failed: exitCode !== 0, stderr }).toMatchObject({
			failed: true,
			stderr: expect.stringContaining("handler bug"),
		});
	}, 10_000);

	test("closing an already closed bus resolves", async () => {
		const bus = await connectBus();

		await bus.close();

		await expect(bus.close()).resolves.toBeUndefined();
	});

	test("handlers run one at a time, even when a handler publishes", async () => {
		const bus = await connectBus();
		const trace: string[] = [];
		bus.subscribe(["cancel_trip"], (message) => {
			if (!isOwn(message)) return;
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

	test("invalid payloads on a subscribed subject are logged and dropped", async () => {
		const logged: DroppedMessage[] = [];
		const bus = await connectBus({ log: (dropped) => logged.push(dropped) });
		const received: Message[] = [];
		bus.subscribe(["cancel_trip"], (message) => {
			if (isOwn(message)) received.push(message);
		});
		// A raw connection can publish what the bus never would; one publisher
		// keeps the valid message last.
		const raw = await connect({ servers: natsUrl });
		const subject = "sim.commands.cancel_trip";

		raw.publish(subject, "{not json");
		raw.publish(subject, JSON.stringify({ type: "no_such_message" }));
		raw.publish(subject, JSON.stringify(cancelTrip(1)));
		await raw.drain();
		await waitFor(() => received.length >= 1);

		expect({
			logged,
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
