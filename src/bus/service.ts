import type { InputRejected, Message } from "../shared/messages.ts";
import type { Random } from "../shared/random.ts";
import type { Bus } from "./bus.ts";

type Rejected = InputRejected<Message, string>;

// Generic shell connecting a pure brain to the bus (ADR 0027).
export function startService<State, Input extends Message>(
	bus: Bus,
	service: {
		start: { state: State; outputs: Message[] };
		accepts: (message: Message) => message is Input;
		decide: (
			state: State,
			input: Input,
			random: Random,
		) => { state: State; outputs: (Message | Rejected)[] };
		random: Random;
		log: (rejected: Rejected) => void;
	},
): void {
	let state = service.start.state;
	for (const output of service.start.outputs) bus.publish(output);
	bus.subscribe(service.accepts, (input) => {
		const decision = service.decide(state, input, service.random);
		state = decision.state;
		for (const output of decision.outputs) {
			if (output.type === "input_rejected") {
				service.log(output);
				continue;
			}
			bus.publish(output);
		}
	});
}
