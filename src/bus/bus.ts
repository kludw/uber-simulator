import type { Message, MessageOf, MessageType } from "../shared/messages.ts";

// Port between service shells and transport (ADR 0027). A subscriber names
// the message types it takes (ADR 0042), so a transport can skip the rest
// before decoding them, and handlers get their own input type without casts.
export type Bus = {
	publish(message: Message): void;
	subscribe<Type extends MessageType>(
		types: readonly Type[],
		handle: (message: MessageOf<Type>) => void,
	): void;
};
