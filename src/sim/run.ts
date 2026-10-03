import { createInMemoryBus } from "../bus/in-memory.ts";
import {
	connectNatsBus,
	type NatsBus,
	type NatsConnectError,
} from "../bus/nats.ts";
import { type Message, RunId, Tick } from "../shared/messages.ts";
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

export type RunResult = {
	eventLog: Message[];
	rejected: { service: string; rejected: Rejected }[];
};

// Runs every service over one in-memory bus, the runner acting as clock
// (ADR 0027). Same config gives the same eventLog.
export function runInProcess(config: RunConfig): RunResult {
	const bus = createInMemoryBus();
	const result: RunResult = { eventLog: [], rejected: [] };
	bus.subscribe(
		(message): message is Message => true,
		(message) => result.eventLog.push(message),
	);
	for (const service of allServices(config)) {
		service.start(bus, (rejected) =>
			result.rejected.push({ service: service.name, rejected }),
		);
	}
	bus.drain();

	for (let tick = 1; tick <= config.ticks; tick++) {
		bus.publish({ type: "clock.ticked", tick: Tick.parse(tick) });
		bus.drain();
	}
	return result;
}

// Same services, each on its own NATS connection (the real network path),
// recorded by one more connection on sim.> that also acts as clock. Only
// per-publisher order holds (ADR 0028), so the event log differs between
// runs of one config: assert invariants, not exact logs. Every connection
// stamps one fresh run id (ADR 0029), returned with the result.
export async function runOverNats(
	config: RunConfig & { url: string },
): Promise<Result<RunResult & { runId: RunId }, NatsConnectError>> {
	const runId = RunId.parse(crypto.randomUUID());
	const services = allServices(config);
	const buses: NatsBus[] = [];
	// Runner first, so it is subscribed before any service publishes.
	for (const name of ["runner", ...services.map((service) => service.name)]) {
		const connected = await connectNatsBus({
			url: config.url,
			runId,
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
		});
		if (!connected.ok) {
			await Promise.all(buses.map((bus) => bus.close()));
			return connected;
		}
		buses.push(connected.value);
	}
	const [runnerBus, ...serviceBuses] = buses;
	if (!runnerBus) throw new Error("runner bus missing");

	const result: RunResult = { eventLog: [], rejected: [] };
	const received = () => result.eventLog.length;
	runnerBus.subscribe(
		(message): message is Message => true,
		(message) => result.eventLog.push(message),
	);
	// Every service is subscribed (connect flushes) before any starts, so
	// dispatch sees every driver.went_online.
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
