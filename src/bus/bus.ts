import type { Message } from "../shared/messages.ts";

// Port between service shells and transport (ADR 0027). `accepts` is a type
// guard so handlers receive their own input type without casts.
export type Bus = {
	publish(message: Message): void;
	subscribe<Input extends Message>(
		accepts: (message: Message) => message is Input,
		handle: (message: Input) => void,
	): void;
};
