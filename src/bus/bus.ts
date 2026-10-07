import type { Message, MessageOf, MessageType } from "../shared/messages.ts";
import type { Region } from "../shared/regions.ts";

// Port between service shells and transport (ADR 0027). A subscriber names
// the message types it takes (ADR 0042), so a transport can skip the rest
// before decoding them, and handlers get their own input type without casts.
// A subscriber with a region takes only that region's messages of the types
// carrying one (ADR 0050: dispatch k); without, every region's.
export type Bus = {
	publish(message: Message): void;
	subscribe<Type extends MessageType>(
		types: readonly Type[],
		handle: (message: MessageOf<Type>) => void,
		region?: Region,
	): void;
};
