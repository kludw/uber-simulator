// Clock service process: the only wall-time pacer. Publishes clock.ticked
// from tick 1, one per 1 s / SPEED, after CLOCK_START_DELAY_MS so the other
// services are subscribed. Config: src/sim/config.ts.
import { Tick } from "../shared/messages.ts";
import { connectProcess, readServiceConfig } from "../sim/process.ts";
import { tickDueAt } from "./schedule.ts";

const config = readServiceConfig("clock");
// Publishes only: subscribes to nothing (ADR 0042).
const { bus, stopping } = await connectProcess("clock", config, []);
const schedule = {
	firstTickAt: Date.now() + config.clockStartDelayMs,
	speed: config.speed,
};
for (let tick = Tick.parse(1); ; tick = Tick.parse(tick + 1)) {
	await Bun.sleep(new Date(tickDueAt(tick, schedule)));
	if (stopping.aborted) break;
	const dueAt = tickDueAt(tick, schedule);
	const wokeAt = Date.now();
	bus.publish({ type: "clock.ticked", tick });
	console.log(JSON.stringify({ service: "clock", type: "exp_tick", tick, dueAt, wokeLateMs: wokeAt - dueAt, publishedLateMs: Date.now() - dueAt }));
}
