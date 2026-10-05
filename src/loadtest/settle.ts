// Settle latency of ticks 1..T (ADR 0037) from the observer's receipts: when
// clock.ticked t arrived, and when the last other event of tick t did. Keeps
// two receipt times per tick, not every event, so it stays small at any
// fleet size. Times in ms from any fixed origin.
export type SettleTracker = {
	clockTicked(tick: number, atMs: number): void;
	// Any other event; ticks outside 1..T are ignored.
	eventReceived(tick: number, atMs: number, subject: string): void;
	summary(): SettleSummary;
};

export type SettleSummary = {
	settleMs: { mean: number; p95: number; max: number };
	// Ticks whose last event arrived after the next clock.ticked; for tick T,
	// with none after it, once it settled in 1,000 ms or more.
	overruns: number;
	// Ticks of 1..T whose clock.ticked arrived.
	ticksObserved: number;
	// Events of ticks 1..T, clock.ticked included.
	messages: number;
	// Largest |gap - 1,000 ms| between consecutive clock.ticked receipts: the
	// clock keeps an absolute schedule, so a large one means the observer
	// itself lagged.
	clockMaxDeviationMs: number;
	// Per subject, the observed ticks whose last event had it, most first
	// (ties by subject): which publisher closes ticks.
	lastEventSubjects: { subject: string; ticks: number }[];
};

export function createSettleTracker(ticks: number): SettleTracker {
	// Index = tick; NaN = nothing received.
	const clockAt = new Float64Array(ticks + 1).fill(Number.NaN);
	const lastEventAt = new Float64Array(ticks + 1).fill(Number.NaN);
	const lastEventSubject: (string | undefined)[] = [];
	const inRun = (tick: number) => tick >= 1 && tick <= ticks;
	let messages = 0;
	return {
		clockTicked(tick, atMs) {
			if (!inRun(tick)) return;
			messages++;
			clockAt[tick] = atMs;
		},
		eventReceived(tick, atMs, subject) {
			if (!inRun(tick)) return;
			messages++;
			const last = lastEventAt[tick] ?? Number.NaN;
			if (!Number.isNaN(last) && atMs <= last) return;
			lastEventAt[tick] = atMs;
			lastEventSubject[tick] = subject;
		},
		summary() {
			const settleMs: number[] = [];
			let overruns = 0;
			let clockMaxDeviationMs = 0;
			const ticksClosed = new Map<string, number>();
			for (let tick = 1; tick <= ticks; tick++) {
				const clock = clockAt[tick] ?? Number.NaN;
				if (Number.isNaN(clock)) continue;
				const last = lastEventAt[tick] ?? Number.NaN;
				const settle = Number.isNaN(last) ? 0 : Math.max(0, last - clock);
				settleMs.push(settle);
				const subject = lastEventSubject[tick];
				if (subject !== undefined) {
					ticksClosed.set(subject, (ticksClosed.get(subject) ?? 0) + 1);
				}
				const nextClock = clockAt[tick + 1] ?? Number.NaN;
				const overran = Number.isNaN(nextClock)
					? settle >= 1000
					: last > nextClock;
				if (overran) overruns++;
				const gap = nextClock - clock;
				if (!Number.isNaN(gap)) {
					clockMaxDeviationMs = Math.max(
						clockMaxDeviationMs,
						Math.abs(gap - 1000),
					);
				}
			}
			return {
				settleMs: {
					mean: mean(settleMs),
					p95: p95(settleMs),
					max: Math.max(...settleMs),
				},
				overruns,
				ticksObserved: settleMs.length,
				messages,
				clockMaxDeviationMs,
				lastEventSubjects: [...ticksClosed]
					.map(([subject, ticks]) => ({ subject, ticks }))
					.toSorted(
						(a, b) => b.ticks - a.ticks || (a.subject < b.subject ? -1 : 1),
					),
			};
		},
	};
}

function mean(values: number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Nearest rank: the smallest value at or above 95% of all values.
function p95(values: number[]): number {
	const sorted = values.toSorted((a, b) => a - b);
	const value = sorted[Math.ceil(0.95 * sorted.length) - 1];
	if (value === undefined) throw new Error("p95 of no values");
	return value;
}
