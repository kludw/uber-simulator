// Seeded PRNG for brains (ADR 0023): sfc32, state seeded via splitmix32.
export interface Random {
	/** Uniform integer in [min, maxInclusive]. */
	int(min: number, maxInclusive: number): number;
	/** Uniform float in [0, 1). */
	float(): number;
	/** Independent stream determined by this stream's seed and the label. */
	child(label: string): Random;
}

export function createRandom(seed: number): Random {
	const nextSeedWord = splitmix32(seed);
	let a = nextSeedWord();
	let b = nextSeedWord();
	let c = nextSeedWord();
	let d = nextSeedWord();

	function nextUint32(): number {
		const t = (((a + b) | 0) + d) | 0;
		d = (d + 1) | 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) | 0;
		c = (c << 21) | (c >>> 11);
		c = (c + t) | 0;
		return t >>> 0;
	}

	const float = () => nextUint32() / 2 ** 32;

	return {
		int: (min, maxInclusive) => {
			if (
				!Number.isInteger(min) ||
				!Number.isInteger(maxInclusive) ||
				min > maxInclusive
			) {
				throw new Error(`invalid int bounds [${min}, ${maxInclusive}]`);
			}
			return min + Math.floor(float() * (maxInclusive - min + 1));
		},
		float,
		// From the seed, not the current state: a child is the same no matter when it is taken.
		child: (label) => createRandom(splitmix32(seed ^ fnv1a(label))()),
	};
}

function fnv1a(label: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < label.length; i++) {
		hash = Math.imul(hash ^ label.charCodeAt(i), 0x01000193);
	}
	return hash >>> 0;
}

function splitmix32(seed: number): () => number {
	let state = seed | 0;
	return () => {
		state = (state + 0x9e3779b9) | 0;
		let z = state;
		z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
		z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
		return (z ^ (z >>> 15)) >>> 0;
	};
}
