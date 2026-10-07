import { createInMemoryBus } from "../bus/in-memory.ts";
import {
	connectNatsBus,
	type NatsBus,
	type NatsConnectError,
} from "../bus/nats.ts";
import { type Message, messageTypes, RunId, Tick } from "../shared/messages.ts";
import { createRandom } from "../shared/random.ts";
import type { Result } from "../shared/result.ts";
import {
	dispatchService,
	driverShardService,
	type Rejected,
	ridersService,
	type SimConfig,
	type SimService,
} from "./services.ts";

export type RunConfig = SimConfig & { ticks: number };

type InProcessConfig = RunConfig & { lossShare?: number };

export type RunResult = {
	messageCount: number;
	rejected: { service: string; rejected: Rejected }[];
};

export type RunObservers = {
	// Each message as it is delivered, in publish order.
	onMessage?: (message: Message) => void;
	// Once each tick's messages are all delivered, with the result so far
	// (`bun run bench` times ticks and reports partial runs with it).
	onTickDone?: (tick: Tick, soFar: RunResult) => void;
};

// Runs every service over one in-memory bus, the runner acting as clock
// (ADR 0027). Same config gives the same messages. The event log is kept
// only with keepEventLog (ADR 0033: memory would grow with every message);
// other callers observe messages as they come. lossShare (tests only) drops
// that share of deliveries to services, seeded by config.seed, to show
// recovery from lost messages (ADR 0041); the event log still has every
// message.
export function runInProcess(
	config: InProcessConfig & { keepEventLog: true },
	observers?: RunObservers,
): RunResult & { eventLog: Message[] };
export function runInProcess(
	config: InProcessConfig & { keepEventLog?: false },
	observers?: RunObservers,
): RunResult;
export function runInProcess(
	config: InProcessConfig & { keepEventLog?: boolean },
	{ onMessage = () => {}, onTickDone = () => {} }: RunObservers = {},
): RunResult & { eventLog?: Message[] } {
	const bus = createInMemoryBus({
		loss: {
			share: config.lossShare ?? 0,
			random: createRandom(config.seed).child("bus-loss"),
		},
	});
	const result: RunResult = { messageCount: 0, rejected: [] };
	const eventLog: Message[] = [];
	bus.record((message) => {
		result.messageCount++;
		if (config.keepEventLog) eventLog.push(message);
		onMessage(message);
	});
	for (const service of allServices(config)) {
		service.start(bus, (rejected) =>
			result.rejected.push({ service: service.name, rejected }),
		);
	}
	bus.drain();

	for (let tick = 1; tick <= config.ticks; tick++) {
		const clockTick = Tick.parse(tick);
		bus.publish({ type: "clock.ticked", tick: clockTick });
		bus.drain();
		onTickDone(clockTick, result);
	}
	return config.keepEventLog ? { ...result, eventLog } : result;
}

// Same services, each on its own NATS connection (the real network path),
// recorded by one more connection taking every type, which also acts as
// clock. Only per-publisher order holds (ADR 0028), so the event log differs
// between runs of one config: assert invariants, not exact logs. Every
// connection stamps one fresh run id (ADR 0029), returned with the result.
export async function runOverNats(
	config: RunConfig & { url: string },
): Promise<
	Result<RunResult & { eventLog: Message[]; runId: RunId }, NatsConnectError>
> {
	const runId = RunId.parse(crypto.randomUUID());
	const services = allServices(config);
	const buses: NatsBus[] = [];
	// Runner first, so it is subscribed before any service publishes. It
	// records every message type.
	const connections = [{ name: "runner", inputs: messageTypes }, ...services];
	for (const { name, inputs } of connections) {
		const connected = await connectNatsBus({
			url: config.url,
			runId,
			inputs,
			log: (dropped) =>
				console.warn(
					JSON.stringify({
						service: name,
						type: "message_dropped",
						...dropped,
					}),
				),
			logStatus: (status) => {
				// Every connection closes when the run ends.
				if (status.type === "nats_closed") return;
				console.warn(JSON.stringify({ service: name, ...status }));
			},
			// Timing is for the service processes' logs (bun run loadtest).
			logTiming: () => {},
		});
		if (!connected.ok) {
			await Promise.all(buses.map((bus) => bus.close()));
			return connected;
		}
		buses.push(connected.value);
	}
	const [runnerBus, ...serviceBuses] = buses;
	if (!runnerBus) throw new Error("runner bus missing");

	const result: RunResult & { eventLog: Message[] } = {
		messageCount: 0,
		rejected: [],
		eventLog: [],
	};
	const received = () => result.messageCount;
	runnerBus.subscribe(messageTypes, (message) => {
		result.messageCount++;
		result.eventLog.push(message);
	});
	// Every service is subscribed (connect flushes) before any starts, so
	// dispatch sees every drivers.went_online.
	services.forEach((service, i) => {
		const bus = serviceBuses[i];
		if (!bus) throw new Error(`no bus for ${service.name}`);
		service.start(bus, (rejected) =>
			result.rejected.push({ service: service.name, rejected }),
		);
	});
	await settled(received);

	for (let tick = 1; tick <= config.ticks; tick++) {
		runnerBus.publish({ type: "clock.ticked", tick: Tick.parse(tick) });
		await settled(received);
	}
	// Runner last, so it records whatever the services flush on close.
	await Promise.all(serviceBuses.map((bus) => bus.close()));
	await runnerBus.close();
	return { ok: true, value: { ...result, runId } };
}

// NATS has no drain(): a tick has settled once the runner has received
// nothing for a quiet interval. On one host a tick's messages follow each
// other within a millisecond or so, so 10 ms of silence means it's done.
// Ending early only lets the next tick overtake a late message, which
// services tolerate anyway (ADR 0028); it can't break an invariant.
const quietMs = 10;

async function settled(received: () => number): Promise<void> {
	let seen: number;
	do {
		seen = received();
		await Bun.sleep(quietMs);
	} while (received() !== seen);
}

function allServices(config: SimConfig): SimService[] {
	return [
		...Array.from({ length: config.driverShards.count }, (_, shard) =>
			driverShardService(config, shard),
		),
		dispatchService(config),
		ridersService(config),
	];
}
