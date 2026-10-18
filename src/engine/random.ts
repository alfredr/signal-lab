// Seeded randomness, so a noise source gives the same realization on every run and turning
// some other knob never reshuffles it.

/** mulberry32: a small, fast 32-bit PRNG. Returns uniform values in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard normal samples from a uniform source (Box-Muller, using both
 * outputs of each pair).
 */
function gaussian(uniform: () => number): () => number {
  let spare: number | undefined;
  return () => {
    if (spare !== undefined) {
      const value = spare;
      spare = undefined;
      return value;
    }

    const radius = Math.sqrt(-2 * Math.log(Math.max(uniform(), 1e-300)));
    const angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

/**
 * Gaussian noise that is the same on every run: seeded by the block (so two
 * noise blocks differ) and by the user's seed setting (so a new realization is
 * one knob away).
 */
export function seededNoise(
  blockSeed: number,
  userSeed: number,
): () => number {
  return gaussian(mulberry32(blockSeed ^ Math.imul(userSeed, 0x9e3779b1)));
}

/**
 * cyrb53: a fast 53-bit string hash, good enough to fingerprint inputs for
 * caching.
 */
export function hash(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }

  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
