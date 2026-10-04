// Whether the persister kept up over a run (ADR 0038): its backlog (events
// published but not yet persisted and acked), at most over the second half of
// the samples, within 3 ticks of events. A single sample lands anywhere in a
// tick's batch, so the bound allows that, not sustained growth. Undefined for
// fewer than 2 samples.
export type PersisterBacklog = {
	secondHalfMax: number;
	limit: number;
	withinLimit: boolean;
};

export const maxTicksBehind = 3;

export function persisterBacklog(
	backlog: number[],
	eventsPerTick: number,
): PersisterBacklog | undefined {
	if (backlog.length < 2) return undefined;
	const half = Math.floor(backlog.length / 2);
	const secondHalfMax = Math.max(...backlog.slice(backlog.length - half));
	const limit = maxTicksBehind * eventsPerTick;
	return { secondHalfMax, limit, withinLimit: secondHalfMax <= limit };
}
