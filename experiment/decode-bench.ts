// Experiment only (#238, not merged): CPU time to decode drivers.moved
// messages the way dispatch does (JSON.parse + Zod), per message.
import { DriversMoved } from "../src/shared/messages.ts";

const iterations = Number(process.argv[2] ?? 2000);
const count = 5000;
const payload = JSON.stringify({
	type: "drivers.moved",
	tick: 7,
	region: 0,
	driverIds: Array.from(
		{ length: count },
		(_, i) => `d-${String(i).padStart(6, "0")}`,
	),
	xs: Array.from({ length: count }, (_, i) => (i * 7) % 1000),
	ys: Array.from({ length: count }, (_, i) => (i * 13) % 1000),
});
const bytes = new TextEncoder().encode(payload);
const decoder = new TextDecoder();
for (let i = 0; i < 200; i++) {
	DriversMoved.parse(JSON.parse(decoder.decode(bytes)));
}
const cpuStart = process.cpuUsage();
const wallStart = performance.now();
let checksum = 0;
for (let i = 0; i < iterations; i++) {
	checksum += DriversMoved.parse(JSON.parse(decoder.decode(bytes))).xs.length;
}
const wall = performance.now() - wallStart;
const cpu = process.cpuUsage(cpuStart);
const cpuMs = (cpu.user + cpu.system) / 1000;
console.log(
	`per message: wall ${(wall / iterations).toFixed(3)} ms, cpu ${(cpuMs / iterations).toFixed(3)} ms; per move cpu ${((cpuMs / iterations / count) * 1000).toFixed(3)} us (${checksum})`,
);
