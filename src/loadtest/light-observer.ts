// EXPERIMENT (#218, not for merge): a second observer in its own process that
// never JSON-parses a payload: on receipt (synchronous callback) it stamps
// wall time and reads the tick from the payload's first bytes. Its receipts
// are the reference the load test's observer is compared with.
import { connect } from "@nats-io/transport-node";

const natsUrl = Bun.env.NATS_URL ?? "nats://localhost:4222";
const nc = await connect({ servers: natsUrl, name: "loadtest-light-observer" });
const clockAt = new Map<number, number>();
const lastAt = new Map<number, number>();
const lastSubject = new Map<number, string>();
const decoder = new TextDecoder();
const tickPattern = /"tick":(\d+)/;
nc.subscribe("sim.events.>", {
	callback: (_err, m) => {
		const at = performance.timeOrigin + performance.now();
		const head = decoder.decode(m.data.subarray(0, 200));
		const match = tickPattern.exec(head);
		if (match === null) return;
		const tick = Number(match[1]);
		if (m.subject === "sim.events.clock.ticked") {
			clockAt.set(tick, at);
			return;
		}
		const last = lastAt.get(tick);
		if (last !== undefined && at <= last) return;
		lastAt.set(tick, at);
		lastSubject.set(tick, m.subject);
	},
});
await nc.flush();
console.log(JSON.stringify({ type: "service_started" }));
process.on("SIGTERM", () => {
	for (const [tick, clock] of clockAt) {
		console.error(
			`exp_light ${JSON.stringify({ tick, clock, last: lastAt.get(tick) ?? null, subject: lastSubject.get(tick) ?? null })}`,
		);
	}
	process.exit(0);
});
