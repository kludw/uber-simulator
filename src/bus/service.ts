import type {
	InputRejected,
	Message,
	MessageOf,
	MessageType,
} from "../shared/messages.ts";
import type { Random } from "../shared/random.ts";
import type { Bus } from "./bus.ts";

type Rejected = InputRejected<Message, string>;

// Generic shell connecting a pure brain to the bus (ADR 0027). inputs: the
// message types the brain takes, its bus subscription (ADR 0042); accepts
// narrows them further, e.g. to entities the service owns (all by default).
export function startService<State, Type extends MessageType>(
	bus: Bus,
	service: {
		start: { state: State; outputs: Message[] };
		inputs: readonly Type[];
		accepts?: (input: MessageOf<Type>) => boolean;
		decide: (
			state: State,
			input: MessageOf<Type>,
			random: Random,
		) => { state: State; outputs: (Message | Rejected)[] };
		random: Random;
		log: (rejected: Rejected) => void;
	},
): void {
	let state = service.start.state;
	for (const output of service.start.outputs) bus.publish(output);
	bus.subscribe(service.inputs, (input) => {
		if (service.accepts && !service.accepts(input)) return;
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
