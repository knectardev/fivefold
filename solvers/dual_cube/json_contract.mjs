/** Versioned JSON handoff between search and reconstruction. */

export const SCHEMA = 'dual-cube-candidate';
export const SCHEMA_VERSION = 2;
export const LEGACY_SCHEMA = 'exact-cover-dual-cube-candidate';
export const SOLVER_BUILD = 'js-kernel-0.1.0';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rotations24() {
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const out = [];
  for (const p of perms) {
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
          M[0][p[0]] = sx;
          M[1][p[1]] = sy;
          M[2][p[2]] = sz;
          const det =
            M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
            M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
            M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
          if (det === 1) out.push(M);
        }
      }
    }
  }
  return out;
}

export const ROT = rotations24();

export function applyRot(v, M) {
  return [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ];
}

export function transformVoxel(v, pl, N) {
  const c = [v[0] - (N - 1) / 2, v[1] - (N - 1) / 2, v[2] - (N - 1) / 2];
  const q = applyRot(c, ROT[pl.r]);
  return [
    Math.round(q[0] + (N - 1) / 2 + pl.t[0]),
    Math.round(q[1] + (N - 1) / 2 + pl.t[1]),
    Math.round(q[2] + (N - 1) / 2 + pl.t[2]),
  ];
}

export function rotTranspose(M) {
  return [
    [M[0][0], M[1][0], M[2][0]],
    [M[0][1], M[1][1], M[2][1]],
    [M[0][2], M[1][2], M[2][2]],
  ];
}

export function transformDirection(d, pl) {
  return applyRot(d, ROT[pl.r]).map((x) => Math.round(x));
}

export function inverseTransformVoxel(v, pl, N) {
  const c = (N - 1) / 2;
  const q = [v[0] - c - pl.t[0], v[1] - c - pl.t[1], v[2] - c - pl.t[2]];
  const p = applyRot(q, rotTranspose(ROT[pl.r]));
  return [Math.round(p[0] + c), Math.round(p[1] + c), Math.round(p[2] + c)];
}

export function transformIndexPoint(p, pl, N) {
  const c = (N - 1) / 2;
  const q = applyRot([p[0] - c, p[1] - c, p[2] - c], ROT[pl.r]);
  return [q[0] + c + pl.t[0], q[1] + c + pl.t[1], q[2] + c + pl.t[2]];
}

export function inverseIndexPoint(p, pl, N) {
  const c = (N - 1) / 2;
  const q = [p[0] - c - pl.t[0], p[1] - c - pl.t[1], p[2] - c - pl.t[2]];
  const r = applyRot(q, rotTranspose(ROT[pl.r]));
  return [r[0] + c, r[1] + c, r[2] + c];
}

/** Integer doubled-lattice face center: f2 = 2v + 1 + d. */
export function doubledFaceCenter(v, d) {
  return [2 * v[0] + 1 + d[0], 2 * v[1] + 1 + d[1], 2 * v[2] + 1 + d[2]];
}

export function transformDoubledFace(f2, pl, N) {
  const shifted = [f2[0] - N, f2[1] - N, f2[2] - N];
  const q = applyRot(shifted, ROT[pl.r]);
  return [
    Math.round(q[0] + N + 2 * pl.t[0]),
    Math.round(q[1] + N + 2 * pl.t[1]),
    Math.round(q[2] + N + 2 * pl.t[2]),
  ];
}

export function inverseDoubledFace(f2, pl, N) {
  const shifted = [f2[0] - N - 2 * pl.t[0], f2[1] - N - 2 * pl.t[1], f2[2] - N - 2 * pl.t[2]];
  const q = applyRot(shifted, rotTranspose(ROT[pl.r]));
  return [Math.round(q[0] + N), Math.round(q[1] + N), Math.round(q[2] + N)];
}

/** Continuous points in the [0, N] cube rotate about N/2, not (N-1)/2. */
export function transformGeometricPoint(p, pl, N) {
  const c = N / 2;
  const q = applyRot([p[0] - c, p[1] - c, p[2] - c], ROT[pl.r]);
  return [q[0] + c + pl.t[0], q[1] + c + pl.t[1], q[2] + c + pl.t[2]];
}

export function inverseGeometricPoint(p, pl, N) {
  const c = N / 2;
  const q = [p[0] - c - pl.t[0], p[1] - c - pl.t[1], p[2] - c - pl.t[2]];
  const r = applyRot(q, rotTranspose(ROT[pl.r]));
  return [r[0] + c, r[1] + c, r[2] + c];
}

export function doubledEquals(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function idx(x, y, z, N) {
  return x + N * (y + N * z);
}

export function unidx(i, N) {
  return [i % N, Math.floor(i / N) % N, Math.floor(i / (N * N))];
}

export function verifyExactClosure(candidate) {
  const N = candidate.gridResolution ?? candidate.N;
  const P = candidate.pieceCount;
  const n = N * N * N;
  const labelsA = candidate.labelsA;
  const labelsB = candidate.labelsB;
  const destOf = candidate.destOf;
  const placements = candidate.placements;
  const reasons = [];
  if (!N || !P) reasons.push('missing gridResolution or pieceCount');
  if (!labelsA || labelsA.length !== n) reasons.push('labelsA length != N³');
  if (!labelsB || labelsB.length !== n) reasons.push('labelsB length != N³');
  if (!placements || placements.length !== P) reasons.push('placements length != pieceCount');
  if (reasons.length) return { ok: false, reasons };

  const seenB = new Uint8Array(n);
  let oob = 0;
  let overlap = 0;
  let destMismatch = 0;
  let transformMismatch = 0;
  for (let x = 0; x < n; x++) {
    const k = labelsA[x];
    if (k < 0 || k >= P) {
      destMismatch++;
      continue;
    }
    const v = unidx(x, N);
    const yv = transformVoxel(v, placements[k], N);
    const [X, Y, Z] = yv;
    if (X < 0 || Y < 0 || Z < 0 || X >= N || Y >= N || Z >= N) {
      oob++;
      continue;
    }
    const y = idx(X, Y, Z, N);
    if (destOf && destOf.length === n && destOf[x] !== y) transformMismatch++;
    if (labelsB[y] !== k) destMismatch++;
    if (seenB[y]) overlap++;
    else seenB[y] = 1;
  }
  let covered = 0;
  for (let i = 0; i < n; i++) covered += seenB[i];
  const voidCount = n - covered;
  if (oob) reasons.push(`${oob} out-of-bounds mappings`);
  if (overlap) reasons.push(`${overlap} Cube B overlaps`);
  if (voidCount) reasons.push(`${voidCount} Cube B voids`);
  if (destMismatch) reasons.push(`${destMismatch} A/B label mismatches`);
  if (destOf && destOf.length === n && transformMismatch) {
    reasons.push(`${transformMismatch} destOf/transform disagreements`);
  }
  return {
    ok: reasons.length === 0,
    reasons,
    coverageA: 1,
    coverageB: 1 - voidCount / n,
    overlap,
    voidCount,
    oob,
  };
}

export function parseCandidate(data) {
  const src = data.selectedCandidate || data;
  const labelsA = src.labelsA || data.labelsA;
  const labelsB = src.labelsB || data.labelsB;
  const placements = src.placements || data.placements;
  const N = data.gridResolution ?? src.gridResolution ?? data.N ?? src.N;
  const K = data.pieceCount ?? src.pieceCount ?? placements?.length;
  if (!N || !K || !Array.isArray(labelsA) || !Array.isArray(labelsB) || !Array.isArray(placements)) {
    throw new Error('JSON is missing gridResolution/N, labelsA, labelsB, or placements.');
  }
  if (labelsA.length !== N * N * N || labelsB.length !== N * N * N) {
    throw new Error('Voxel label count does not match N³.');
  }
  return {
    schema: data.schema || src.schema || SCHEMA,
    version: data.version ?? src.version ?? SCHEMA_VERSION,
    gridResolution: +N,
    N: +N,
    pieceCount: +K,
    labelsA: Array.from(labelsA, Number),
    labelsB: Array.from(labelsB, Number),
    destOf: src.destOf || data.destOf || null,
    placements: placements.map((p) => ({ r: +p.r, t: p.t.map(Number) })),
    searchMetadata: data.searchMetadata || src.searchMetadata || null,
    validation: data.validation || src.validation || null,
  };
}

export function cadEligibility(counts, pieceCount, metrics = null, params = COHERENT_PARAMS) {
  const arr = counts ? Array.from(counts) : [];
  const n = pieceCount ?? arr.length;
  const emptyPieces = [];
  for (let i = 0; i < n; i++) {
    if (!arr[i]) emptyPieces.push(i + 1);
  }
  const disconnectedPieces = [];
  if (metrics?.components) {
    for (let i = 0; i < n; i++) {
      const row = metrics.components[i];
      const comps = typeof row === 'number' ? row : row?.comps;
      if (arr[i] && comps != null && comps !== 1) disconnectedPieces.push(i + 1);
    }
  }
  const connected = metrics?.connected;
  const nonempty = n - emptyPieces.length;
  const reasons = [];
  const warnings = [];
  if (emptyPieces.length) {
    reasons.push(`empty piece(s): ${emptyPieces.join(', ')} — not a CAD reconstruction candidate`);
  }
  if (disconnectedPieces.length) {
    reasons.push(
      `disconnected source topology: piece(s) ${disconnectedPieces.join(', ')} — exact occupancy with invalid pieces; regression fixture, not a CAD candidate`,
    );
  } else if (connected != null && connected < nonempty) {
    reasons.push(`${nonempty - connected} disconnected piece(s) — not a CAD reconstruction candidate`);
  }
  const minVolume = (params?.minVolume ?? 5) / 100;
  if (!emptyPieces.length && metrics?.minVol != null && metrics.minVol < minVolume) {
    reasons.push(`smallest piece ${(100 * metrics.minVol).toFixed(1)}% < ${(100 * minVolume).toFixed(1)}%`);
  }
  const maxFragile = (params?.maxFragile ?? 5) / 100;
  if (metrics?.fragileRatio != null && metrics.fragileRatio > maxFragile) {
    warnings.push(`fragile voxels / local thickness ${(100 * metrics.fragileRatio).toFixed(1)}% > ${(100 * maxFragile).toFixed(1)}%`);
  }
  let cadQueue = 'active';
  if (emptyPieces.length) cadQueue = 'rejected-empty-piece';
  else if (disconnectedPieces.length || (connected != null && connected < nonempty)) cadQueue = 'rejected-disconnected-source';
  else if (reasons.length) cadQueue = 'rejected-undersized';
  const cadEligible = reasons.length === 0 && n > 0;
  return {
    cadEligible,
    cadQueue,
    cadRole: cadEligible ? 'cad-candidate' : cadQueue,
    emptyPieces,
    disconnectedPieces,
    reasons,
    warnings,
  };
}

export function buildCandidateDocument({
  N,
  pieceCount,
  placements,
  labelsA,
  labelsB,
  destOf,
  counts,
  metrics,
  searchParameters,
  seed,
  provenance = 'original',
  activePreset = null,
  solverBuild = SOLVER_BUILD,
}) {
  const doc = {
    schema: SCHEMA,
    version: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    gridResolution: N,
    N,
    pieceCount,
    labelsA: Array.from(labelsA),
    labelsB: Array.from(labelsB),
    destOf: destOf ? Array.from(destOf) : [],
    placements,
    counts: counts ? Array.from(counts) : undefined,
    searchMetadata: {
      solverBuild,
      seed: seed ?? null,
      activePreset,
      provenance,
      searchParameters: searchParameters || {},
    },
    validation: {
      exactClosure: null,
      connectivity: metrics
        ? { connected: metrics.connected, pieceCount, minVol: metrics.minVol, maxVol: metrics.maxVol, fragileRatio: metrics.fragileRatio }
        : null,
      scores: metrics
        ? {
            imbalance: metrics.imbalance,
            roughA: metrics.roughA,
            roughB: metrics.roughB,
            regularity: metrics.regularity,
            moved: metrics.moved,
            similarity: metrics.similarity,
            adjacencyDifference: metrics.adjacencyDifference,
            minVol: metrics.minVol,
            maxVol: metrics.maxVol,
            fragileRatio: metrics.fragileRatio,
            admissibility: metrics.admissibility || null,
          }
        : null,
    },
  };
  doc.validation.exactClosure = verifyExactClosure(doc);
  const cad = cadEligibility(counts, pieceCount, metrics);
  doc.cadEligible = cad.cadEligible;
  doc.cadQueue = cad.cadQueue;
  doc.cadRole = cad.cadRole;
  doc.cadBlockers = cad.reasons;
  doc.cadWarnings = cad.warnings;
  return doc;
}

export const COHERENT_PARAMS = {
  cohA: 4.4,
  cohB: 4.0,
  asym: 38,
  balance: 12,
  connRefine: 3.4,
  minVolume: 5,
  maxFragile: 5,
  maxRough: 1.0,
  rounds: 3,
};
