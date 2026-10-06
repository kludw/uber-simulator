// Whether the persister kept up over a run (ADR 0046): its backlog (events
// published but not yet delivered to it, consumer num_pending), at most over
// the second half of the samples, within 3 ticks of events. Events it holds
// but hasn't acked (num_ack_pending) don't count: they are its own in-flight
// batches, bounded by max ack pending and the fetch wait (ADR 0044), and at
// low rates or in bursts they alone can exceed 3 ticks. Undefined for fewer
// than 2 samples.
export type PersisterSample = { pending: number; ackPending: number };

export type PersisterBacklog = {
	secondHalfMax: number;
	limit: number;
	withinLimit: boolean;
};

export const maxTicksBehind = 3;

export function persisterBacklog(
	samples: PersisterSample[],
	eventsPerTick: number,
): PersisterBacklog | undefined {
	if (samples.length < 2) return undefined;
	const half = Math.floor(samples.length / 2);
	const secondHalfMax = Math.max(
		...samples.slice(samples.length - half).map(({ pending }) => pending),
	);
	const limit = maxTicksBehind * eventsPerTick;
	return { secondHalfMax, limit, withinLimit: secondHalfMax <= limit };
}
