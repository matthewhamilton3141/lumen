// Void-and-cluster blue noise (Ulichney 1993), small and deterministic.
// Returns { size, t } with thresholds in (0,1).

function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function blueNoise(n = 64, sigma = 1.5) {
  const N = n * n;
  const r = Math.ceil(sigma * 3);
  const kern = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++)
    kern.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma))]);

  const energy = new Float64Array(N);
  const bits = new Uint8Array(N);
  const splat = (i, sgn) => {
    const x0 = i % n, y0 = (i / n) | 0;
    for (const [dx, dy, w] of kern) energy[((y0 + dy + n) % n) * n + ((x0 + dx + n) % n)] += sgn * w;
  };
  const extreme = (want, max) => {
    let best = -1, bv = max ? -Infinity : Infinity;
    for (let i = 0; i < N; i++) {
      if (bits[i] !== want) continue;
      if (max ? energy[i] > bv : energy[i] < bv) { bv = energy[i]; best = i; }
    }
    return best;
  };

  // Initial binary pattern: ~10% random points, then relax.
  const rand = rng(7);
  let ones = 0;
  while (ones < N / 10) {
    const i = (rand() * N) | 0;
    if (!bits[i]) { bits[i] = 1; splat(i, 1); ones++; }
  }
  for (let it = 0; it < N; it++) {
    const c = extreme(1, true); bits[c] = 0; splat(c, -1);
    const v = extreme(0, false); bits[v] = 1; splat(v, 1);
    if (c === v) break;
  }

  const rank = new Int32Array(N);
  const proto = bits.slice(), protoE = energy.slice();
  // Phase 1: remove clusters from the prototype.
  for (let k = ones - 1; k >= 0; k--) { const c = extreme(1, true); bits[c] = 0; splat(c, -1); rank[c] = k; }
  bits.set(proto); energy.set(protoE);
  // Phase 2+3: fill voids.
  for (let k = ones; k < N; k++) { const v = extreme(0, false); bits[v] = 1; splat(v, 1); rank[v] = k; }

  const t = new Float32Array(N);
  for (let i = 0; i < N; i++) t[i] = (rank[i] + 0.5) / N;
  return { size: n, t };
}
