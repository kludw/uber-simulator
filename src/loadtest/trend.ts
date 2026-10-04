// Whether the persister's backlog grew over a run (ADR 0037): a single
// sample mostly shows batch oscillation, so compare the mean pending count of
// the run's second half with its first. Undefined for fewer than 2 samples.
export type PendingTrend = {
	firstHalfMean: number;
	secondHalfMean: number;
	rising: boolean;
};

export function pendingTrend(pending: number[]): PendingTrend | undefined {
	if (pending.length < 2) return undefined;
	const half = Math.floor(pending.length / 2);
	const firstHalfMean = mean(pending.slice(0, half));
	const secondHalfMean = mean(pending.slice(pending.length - half));
	return {
		firstHalfMean,
		secondHalfMean,
		rising: secondHalfMean > firstHalfMean,
	};
}

function mean(values: number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}
