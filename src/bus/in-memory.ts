import type { Message } from "../shared/messages.ts";
import type { Bus } from "./bus.ts";

type Subscription = (message: Message) => void;

// drain() delivers queued messages FIFO until empty, including messages that
// handlers publish meanwhile, so delivery order is publish order (ADR 0027).
export function createInMemoryBus(): Bus & { drain(): void } {
	const queue: Message[] = [];
	const subscriptions: Subscription[] = [];
	return {
		publish(message) {
			queue.push(message);
		},
		subscribe(accepts, handle) {
			subscriptions.push((message) => {
				if (accepts(message)) handle(message);
			});
		},
		drain() {
			for (let message = queue.shift(); message; message = queue.shift()) {
				for (const deliver of subscriptions) deliver(message);
			}
		},
	};
}
