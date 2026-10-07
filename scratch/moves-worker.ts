// #232 experiment, not merged: decodes a tick's drivers.moved chunks off the
// main thread, then posts each decoded chunk back (see moves-bench.ts).
// Decode and post are timed apart, so the bench can tell which side bounds
// the main thread's arrival spread.
import { parseMessage } from "../src/shared/messages.ts";

declare const self: Worker;

// "indexed": IDs interned to dense integers here, so only typed arrays cross.
const indexOf = new Map<string, number>();

self.onmessage = (event: MessageEvent) => {
	const { mode, payloads } = event.data as {
		mode: "arrays" | "typed" | "indexed";
		payloads: string[];
	};
	const decodeStart = performance.now();
	const decoded = payloads.map((payload) => {
		const parsed = parseMessage(JSON.parse(payload));
		if (!parsed.ok || parsed.value.type !== "drivers.moved") {
			throw new Error("bad");
		}
		return parsed.value;
	});
	const postStart = performance.now();
	for (const { driverIds, xs, ys } of decoded) {
		if (mode === "arrays") {
			self.postMessage({ driverIds, xs, ys });
			continue;
		}
		const x = Int32Array.from(xs);
		const y = Int32Array.from(ys);
		if (mode === "typed") {
			self.postMessage({ driverIds, xs: x, ys: y }, [x.buffer, y.buffer]);
			continue;
		}
		const indexes = Int32Array.from(driverIds, (id) => {
			let index = indexOf.get(id);
			if (index === undefined) {
				index = indexOf.size;
				indexOf.set(id, index);
			}
			return index;
		});
		self.postMessage({ indexes, xs: x, ys: y }, [
			indexes.buffer,
			x.buffer,
			y.buffer,
		]);
	}
	self.postMessage({
		done: true,
		decodeMs: postStart - decodeStart,
		postMs: performance.now() - postStart,
	});
};
