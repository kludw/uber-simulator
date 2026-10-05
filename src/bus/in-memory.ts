import type { Message } from "../shared/messages.ts";
import type { Random } from "../shared/random.ts";
import type { Bus } from "./bus.ts";

type Subscription = { lossy: boolean; deliver: (message: Message) => void };

export type InMemoryBusOptions = {
	// Drops each (message, subscriber) delivery independently with probability
	// share, like core NATS losing a message to one subscriber (ADR 0028), so
	// tests can show recovery (ADR 0041). Draws come from random in delivery
	// order, so the same seed drops the same deliveries. clock.ticked is never
	// dropped: the runner is the clock and must reach every service.
	loss?: { share: number; random: Random };
};

// drain() delivers queued messages FIFO until empty, including messages that
// handlers publish meanwhile, so delivery order is publish order (ADR 0027).
// record() subscribes to every message, never dropped: the run's event log.
export function createInMemoryBus({ loss }: InMemoryBusOptions = {}): Bus & {
	drain(): void;
	record(handle: (message: Message) => void): void;
} {
	if (loss !== undefined && !(loss.share >= 0 && loss.share <= 1)) {
		throw new Error(`loss share ${loss.share} outside [0, 1]`);
	}
	const queue: Message[] = [];
	const subscriptions: Subscription[] = [];
	const lost = (message: Message) =>
		loss !== undefined &&
		loss.share > 0 &&
		message.type !== "clock.ticked" &&
		loss.random.float() < loss.share;
	return {
		publish(message) {
			queue.push(message);
		},
		subscribe(accepts, handle) {
			subscriptions.push({
				lossy: true,
				deliver: (message) => {
					if (accepts(message)) handle(message);
				},
			});
		},
		record(handle) {
			subscriptions.push({ lossy: false, deliver: handle });
		},
		drain() {
			for (let message = queue.shift(); message; message = queue.shift()) {
				for (const { lossy, deliver } of subscriptions) {
					if (lossy && lost(message)) continue;
					deliver(message);
				}
			}
		},
	};
}
