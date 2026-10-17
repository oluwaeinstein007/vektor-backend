/**
 * NW-020 — deterministic pseudo-randomness.
 *
 * The README's third convention is that determinism is the feature: same
 * scenario plus same seed must produce identical output, or this is a demo
 * toy rather than a test harness. That rules out `Math.random()` anywhere
 * in the simulation path, because it cannot be seeded in Node.
 *
 * mulberry32: 32-bit, tiny, and good enough for jitter on a sensor reading.
 * Explicitly NOT for anything security-relevant — it is trivially
 * predictable by design, which is the entire point here.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A per-entity stream derived from the scenario seed and the entity id, so
 * each entity's jitter is independent AND reproducible regardless of how
 * many entities the scenario has or what order they are processed in.
 *
 * Deriving every entity's noise from one shared generator would make a
 * scenario's output depend on entity ordering — add an entity at the top of
 * the file and every other entity's track silently changes. That is the
 * difference between a harness you can bisect against and one you cannot.
 */
export function streamFor(seed: number, entityId: string): () => number {
  let h = seed >>> 0;
  for (let i = 0; i < entityId.length; i++) {
    h = Math.imul(h ^ entityId.charCodeAt(i), 0x01000193) >>> 0;
  }
  return mulberry32(h);
}

/** Uniform in [-magnitude, +magnitude]. */
export function jitter(rand: () => number, magnitude: number): number {
  return (rand() * 2 - 1) * magnitude;
}
