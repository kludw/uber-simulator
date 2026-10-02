// Shell shared by the service entrypoints (src/*/main.ts): config, NATS
// connection, structured logs, shutdown. Exit codes: 0 stopped by
// SIGINT/SIGTERM, 1 NATS connection failed or lost, 2 invalid config.
import type { Bus } from "../bus/bus.ts";
import { connectNatsBus } from "../bus/nats.ts";
import type { Result } from "../shared/result.ts";
import {
	type InvalidConfig,
	parseServiceConfig,
	type ServiceConfig,
} from "./config.ts";
import type { SimService } from "./services.ts";

// One JSON line per entry on stdout, tagged with the service.
function log(
	service: string,
	entry: { type: string; [field: string]: unknown },
): void {
	console.log(
		JSON.stringify({ service, ...entry }, (_, value: unknown) =>
			value instanceof Error
				? { name: value.name, message: value.message }
				: value,
		),
	);
}

export function orExit<T>(
	service: string,
	result: Result<T, InvalidConfig>,
): T {
	if (result.ok) return result.value;
	log(service, result.error);
	process.exit(2);
}

export function readServiceConfig(service: string): ServiceConfig {
	return orExit(service, parseServiceConfig(Bun.env));
}

// Connects the process to NATS and closes the bus on SIGINT/SIGTERM.
// `stopping` aborts before the bus closes, so loops stop publishing first.
export async function connectProcess(
	service: string,
	config: ServiceConfig,
): Promise<{ bus: Bus; stopping: AbortSignal }> {
	const stop = new AbortController();
	const connected = await connectNatsBus({
		url: config.natsUrl,
		log: (dropped) => log(service, { type: "message_dropped", ...dropped }),
		logStatus: (status) => {
			log(service, status);
			// Client gave up reconnecting: nothing left to run on.
			if (status.type === "nats_closed" && !stop.signal.aborted) {
				process.exit(1);
			}
		},
	});
	if (!connected.ok) {
		log(service, connected.error);
		process.exit(1);
	}
	const bus = connected.value;
	const shutDown = async (signal: NodeJS.Signals) => {
		if (stop.signal.aborted) return;
		stop.abort();
		await bus.close();
		log(service, { type: "service_stopped", signal });
		process.exit(0);
	};
	process.on("SIGINT", shutDown);
	process.on("SIGTERM", shutDown);
	log(service, { type: "service_started", seed: config.seed });
	return { bus, stopping: stop.signal };
}

export async function runService(
	service: SimService,
	config: ServiceConfig,
): Promise<void> {
	const { bus } = await connectProcess(service.name, config);
	service.start(bus, (rejected) => log(service.name, rejected));
}
