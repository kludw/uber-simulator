import { createInMemoryBus } from "../bus/in-memory.ts";
import { type Message, Tick } from "../shared/messages.ts";
import {
	dispatchService,
	driverShardService,
	type Rejected,
	ridersService,
	type SimConfig,
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
	const services = [
		...Array.from({ length: config.driverShards.count }, (_, shard) =>
			driverShardService(config, shard),
		),
		dispatchService(config),
		ridersService(config),
	];
	for (const service of services) {
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
