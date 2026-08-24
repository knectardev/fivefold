import {
  ROT,
  applyRot,
  transformVoxel,
  idx,
  unidx,
  mulberry32,
  verifyExactClosure,
  COHERENT_PARAMS,
} from './json_contract.mjs';

export { ROT, applyRot, transformVoxel, idx, unidx, mulberry32, verifyExactClosure, COHERENT_PARAMS };

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function defaultParams(pieceCount) {
  return {
    ...COHERENT_PARAMS,
    minMoved: Math.min(pieceCount, Math.max(1, Math.round(pieceCount * 0.75))),
  };
}

function dist2(v, s, N) {
  const x = v[0] / (N - 1) - s[0];
  const y = v[1] / (N - 1) - s[1];
  const z = v[2] / (N - 1) - s[2];
  return x * x + y * y + z * z;
}

function neighborSupport(labels, index, piece, N) {
  if (!labels) return 0;
  const [x, y, z] = unidx(index, N);
  let support = 0;
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const X = x + d[0];
    const Y = y + d[1];
    const Z = z + d[2];
    if (X < 0 || Y < 0 || Z < 0 || X >= N || Y >= N || Z >= N) continue;
    if (labels[idx(X, Y, Z, N)] === piece) support++;
  }
  return support;
}

export function randomSeedLayout(N, pieceCount, asym, rand) {
  const A = asym / 100;
  const levels = [0.16, 0.34, 0.5, 0.66, 0.84];
  const candidates = [];
  for (const x of levels) {
    for (const y of levels) {
      for (const z of levels) {
        if (Math.abs(x - 0.5) < 0.01 && Math.abs(y - 0.5) < 0.01 && Math.abs(z - 0.5) < 0.01) continue;
        candidates.push([x, y, z]);
      }
    }
  }
  const chosen = [];
  chosen.push(candidates[Math.floor(rand() * candidates.length)]);
  while (chosen.length < pieceCount) {
    let best = null;
    let bestD = -1;
    for (const c of candidates) {
      if (chosen.includes(c)) continue;
      let nearest = Infinity;
      for (const s of chosen) {
        const d = (c[0] - s[0]) ** 2 + (c[1] - s[1]) ** 2 + (c[2] - s[2]) ** 2;
        nearest = Math.min(nearest, d);
      }
      if (nearest > bestD) {
        bestD = nearest;
        best = c;
      }
    }
    chosen.push(best);
  }
  return chosen.map((s, i) => [
    clamp(s[0] + A * (rand() * 0.32 - 0.16) + 0.025 * Math.sin(i * 1.73), 0.04, 0.96),
    clamp(s[1] + A * (rand() * 0.32 - 0.16) + 0.025 * Math.cos(i * 1.31), 0.04, 0.96),
    clamp(s[2] + A * (rand() * 0.32 - 0.16) + 0.025 * Math.sin(i * 0.91 + 0.7), 0.04, 0.96),
  ]);
}

export function randomTransforms(pieceCount, radius, minMoved, rand) {
  const p = Array.from({ length: pieceCount }, () => ({
    r: Math.floor(rand() * 24),
    t: [
      radius ? Math.floor(rand() * (2 * radius + 1) - radius) : 0,
      radius ? Math.floor(rand() * (2 * radius + 1) - radius) : 0,
      radius ? Math.floor(rand() * (2 * radius + 1) - radius) : 0,
    ],
  }));
  let moved = p.filter((x) => x.r !== 0 || x.t.some((v) => v !== 0)).length;
  while (moved < minMoved) {
    const k = Math.floor(rand() * pieceCount);
    p[k].r = 1 + Math.floor(rand() * 23);
    moved = p.filter((x) => x.r !== 0 || x.t.some((v) => v !== 0)).length;
  }
  return p;
}

export function makeEdges(N, pieceCount, placements, seedsA, seedsB, bias, params, priorA = null, priorB = null) {
  const n = N * N * N;
  const wA = params.cohA;
  const wB = params.cohB;
  const edges = Array.from({ length: n }, () => []);
  let minCost = Infinity;
  for (let x = 0; x < n; x++) {
    const v = unidx(x, N);
    for (let k = 0; k < pieceCount; k++) {
      const yv = transformVoxel(v, placements[k], N);
      const [X, Y, Z] = yv;
      if (X < 0 || Y < 0 || Z < 0 || X >= N || Y >= N || Z >= N) continue;
      const y = idx(X, Y, Z, N);
      const wobble = 0.035 * Math.sin((v[0] * 1.7 + v[1] * 2.3 + v[2] * 1.1 + k) * 2.1);
      const supportA = neighborSupport(priorA, x, k, N);
      const supportB = neighborSupport(priorB, y, k, N);
      const connectivityPenalty = params.connRefine * ((12 - supportA - supportB) / 12);
      const cost = wA * dist2(v, seedsA[k], N) + wB * dist2(yv, seedsB[k], N) + bias[k] + wobble + connectivityPenalty;
      edges[x].push({ y, piece: k, cost });
      minCost = Math.min(minCost, cost);
    }
  }
  const shift = minCost < 0 ? -minCost : 0;
  for (const list of edges) for (const e of list) e.cost += shift;
  return edges;
}

let matchingBackend = null;

/** Install an optional matcher (WASM) that consumes the same edge lists as JS. */
export function setMatchingBackend(fn) {
  matchingBackend = fn;
}

export function minCostPerfectMatching(edges) {
  if (matchingBackend) return matchingBackend(edges);
  return minCostPerfectMatchingJS(edges);
}

export function minCostPerfectMatchingJS(edges) {
  const n = edges.length;
  const V = 2 + n + n;
  const S = 2 * n;
  const T = 2 * n + 1;
  const G = Array.from({ length: V }, () => []);
  function addEdge(u, v, cap, cost, piece = -1, source = -1) {
    const a = { to: v, rev: G[v].length, cap, cost, piece, source, original: cap };
    const b = { to: u, rev: G[u].length, cap: 0, cost: -cost, piece: -1, source: -1, original: 0 };
    G[u].push(a);
    G[v].push(b);
  }
  for (let x = 0; x < n; x++) {
    addEdge(S, x, 1, 0);
    for (const e of edges[x]) addEdge(x, n + e.y, 1, e.cost, e.piece, x);
  }
  for (let y = 0; y < n; y++) addEdge(n + y, T, 1, 0);

  const pot = new Float64Array(V);
  const dist = new Float64Array(V);
  const prevV = new Int32Array(V);
  const prevE = new Int32Array(V);
  let flow = 0;
  let totalCost = 0;
  const heap = [];
  function push(item) {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= item[0]) break;
      heap[i] = heap[p];
      i = p;
    }
    heap[i] = item;
  }
  function pop() {
    const root = heap[0];
    const last = heap.pop();
    if (heap.length) {
      let i = 0;
      heap[0] = last;
      while (true) {
        const l = i * 2 + 1;
        const r = l + 1;
        let b = i;
        if (l < heap.length && heap[l][0] < heap[b][0]) b = l;
        if (r < heap.length && heap[r][0] < heap[b][0]) b = r;
        if (b === i) break;
        [heap[i], heap[b]] = [heap[b], heap[i]];
        i = b;
      }
    }
    return root;
  }

  while (flow < n) {
    dist.fill(Infinity);
    prevV.fill(-1);
    prevE.fill(-1);
    dist[S] = 0;
    heap.length = 0;
    push([0, S]);
    while (heap.length) {
      const [d, u] = pop();
      if (d !== dist[u]) continue;
      for (let ei = 0; ei < G[u].length; ei++) {
        const e = G[u][ei];
        if (e.cap <= 0) continue;
        const nd = d + e.cost + pot[u] - pot[e.to];
        if (nd + 1e-12 < dist[e.to]) {
          dist[e.to] = nd;
          prevV[e.to] = u;
          prevE[e.to] = ei;
          push([nd, e.to]);
        }
      }
    }
    if (!Number.isFinite(dist[T])) return null;
    for (let v = 0; v < V; v++) if (Number.isFinite(dist[v])) pot[v] += dist[v];
    let v = T;
    while (v !== S) {
      const u = prevV[v];
      const ei = prevE[v];
      const e = G[u][ei];
      e.cap--;
      G[v][e.rev].cap++;
      totalCost += e.cost;
      v = u;
    }
    flow++;
  }

  const labelsA = new Uint8Array(n);
  const labelsB = new Uint8Array(n);
  const destOf = new Int32Array(n);
  labelsB.fill(255);
  destOf.fill(-1);
  for (let x = 0; x < n; x++) {
    let found = false;
    for (const e of G[x]) {
      if (e.to >= n && e.to < 2 * n && e.original === 1 && e.cap === 0 && e.piece >= 0) {
        const y = e.to - n;
        labelsA[x] = e.piece;
        labelsB[y] = e.piece;
        destOf[x] = y;
        found = true;
        break;
      }
    }
    if (!found) return null;
  }
  return { labelsA, labelsB, destOf, totalCost };
}

export function connectedComponents(labels, k, N) {
  const n = labels.length;
  const seen = new Uint8Array(n);
  const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  let comps = 0;
  let largest = 0;
  let total = 0;
  for (let i = 0; i < n; i++) if (labels[i] === k) total++;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== k || seen[i]) continue;
    comps++;
    let count = 0;
    const q = [i];
    seen[i] = 1;
    for (let h = 0; h < q.length; h++) {
      const j = q[h];
      const [x, y, z] = unidx(j, N);
      count++;
      for (const d of nb) {
        const X = x + d[0];
        const Y = y + d[1];
        const Z = z + d[2];
        if (X < 0 || Y < 0 || Z < 0 || X >= N || Y >= N || Z >= N) continue;
        const t = idx(X, Y, Z, N);
        if (!seen[t] && labels[t] === k) {
          seen[t] = 1;
          q.push(t);
        }
      }
    }
    largest = Math.max(largest, count);
  }
  return { comps, largest, total, ratio: total ? largest / total : 0 };
}

function interfaceRoughness(labels, N) {
  let r = 0;
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const k = labels[idx(x, y, z, N)];
        if (x + 1 < N && labels[idx(x + 1, y, z, N)] !== k) r++;
        if (y + 1 < N && labels[idx(x, y + 1, z, N)] !== k) r++;
        if (z + 1 < N && labels[idx(x, y, z + 1, N)] !== k) r++;
      }
    }
  }
  return r / (N * N * N);
}

export function fragileVoxelRatio(labels, N) {
  let fragile = 0;
  const total = labels.length;
  const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let i = 0; i < labels.length; i++) {
    const [x, y, z] = unidx(i, N);
    const k = labels[i];
    let same = 0;
    for (const d of nb) {
      const X = x + d[0];
      const Y = y + d[1];
      const Z = z + d[2];
      if (X < 0 || Y < 0 || Z < 0 || X >= N || Y >= N || Z >= N) continue;
      if (labels[idx(X, Y, Z, N)] === k) same++;
    }
    if (same <= 1) fragile++;
  }
  return fragile / Math.max(1, total);
}

function adjacencySet(labels, N) {
  const set = new Set();
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const a = labels[idx(x, y, z, N)];
        for (const d of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
          const X = x + d[0];
          const Y = y + d[1];
          const Z = z + d[2];
          if (X >= N || Y >= N || Z >= N) continue;
          const b = labels[idx(X, Y, Z, N)];
          if (a !== b) set.add(a < b ? `${a}-${b}` : `${b}-${a}`);
        }
      }
    }
  }
  return set;
}

function octantRegularity(labels, N, pieceCount) {
  const stats = Array.from({ length: pieceCount }, () => ({
    n: 0,
    min: [N, N, N],
    max: [-1, -1, -1],
    sum: [0, 0, 0],
  }));
  for (let i = 0; i < labels.length; i++) {
    const k = labels[i];
    const [x, y, z] = unidx(i, N);
    const s = stats[k];
    s.n++;
    s.sum[0] += x;
    s.sum[1] += y;
    s.sum[2] += z;
    for (let a = 0; a < 3; a++) {
      s.min[a] = Math.min(s.min[a], [x, y, z][a]);
      s.max[a] = Math.max(s.max[a], [x, y, z][a]);
    }
  }
  const ideals = [
    [0.25, 0.25, 0.25], [0.75, 0.25, 0.25], [0.25, 0.75, 0.25], [0.75, 0.75, 0.25],
    [0.25, 0.25, 0.75], [0.75, 0.25, 0.75], [0.25, 0.75, 0.75], [0.75, 0.75, 0.75],
  ];
  let reg = 0;
  for (const s of stats) {
    if (!s.n) {
      reg += 2;
      continue;
    }
    const c = s.sum.map((q) => q / s.n / (N - 1));
    let near = Infinity;
    for (const p of ideals) near = Math.min(near, (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2);
    const d = s.max.map((q, i) => q - s.min[i] + 1);
    const mean = (d[0] + d[1] + d[2]) / 3;
    const cubic = 1 - (Math.abs(d[0] - mean) + Math.abs(d[1] - mean) + Math.abs(d[2] - mean)) / (3 * Math.max(1, mean));
    reg += Math.exp(-near * 18) * Math.max(0, cubic);
  }
  return reg / pieceCount;
}

export function evaluateCandidate(N, pieceCount, match, placements) {
  const counts = new Int32Array(pieceCount);
  const components = [];
  const n = N * N * N;
  for (const k of match.labelsA) counts[k]++;
  for (let k = 0; k < pieceCount; k++) components.push(connectedComponents(match.labelsA, k, N));
  const connected = components.filter((c) => c.comps === 1).length;
  const target = n / pieceCount;
  const imbalance = [...counts].reduce((s, x) => s + Math.abs(x - target), 0) / n;
  const roughA = interfaceRoughness(match.labelsA, N);
  const roughB = interfaceRoughness(match.labelsB, N);
  const fragileRatio = Math.max(fragileVoxelRatio(match.labelsA, N), fragileVoxelRatio(match.labelsB, N));
  const regularity = octantRegularity(match.labelsA, N, pieceCount);
  const moved = placements.filter((p) => p.r !== 0 || p.t.some((v) => v !== 0)).length;
  let same = 0;
  for (let i = 0; i < n; i++) if (match.labelsA[i] === match.labelsB[i]) same++;
  const similarity = same / n;
  const adjA = adjacencySet(match.labelsA, N);
  const adjB = adjacencySet(match.labelsB, N);
  let inter = 0;
  for (const x of adjA) if (adjB.has(x)) inter++;
  const union = new Set([...adjA, ...adjB]).size || 1;
  const adjacencyDifference = 1 - inter / union;
  const minVol = Math.min(...counts) / n;
  const maxVol = Math.max(...counts) / n;
  const disconnected = pieceCount - connected;
  const score =
    disconnected * 100000 +
    (0.05 - minVol) * 400000 +
    maxVol * 8000 +
    imbalance * 6000 +
    (roughA + roughB) * 350 +
    regularity * 250 +
    similarity * 500 -
    adjacencyDifference * 220 -
    moved * 20;
  return {
    placements: placements.map((p) => ({ r: p.r, t: [...p.t] })),
    labelsA: match.labelsA,
    labelsB: match.labelsB,
    destOf: match.destOf,
    counts,
    components,
    connected,
    imbalance,
    roughA,
    roughB,
    regularity,
    moved,
    similarity,
    adjacencyDifference,
    minVol,
    maxVol,
    fragileRatio,
    score,
    totalCost: match.totalCost,
    exact: true,
  };
}

export function admissibility(c, pieceCount, params) {
  const minVolume = params.minVolume / 100;
  const maxFragile = params.maxFragile / 100;
  const maxRough = params.maxRough;
  const reasons = [];
  if (c.connected < pieceCount) {
    reasons.push(`${pieceCount - c.connected} disconnected piece${pieceCount - c.connected === 1 ? '' : 's'}`);
  }
  if (c.minVol < minVolume) reasons.push(`smallest piece ${(100 * c.minVol).toFixed(1)}% < ${(100 * minVolume).toFixed(1)}%`);
  if (c.fragileRatio > maxFragile) reasons.push(`fragile voxels ${(100 * c.fragileRatio).toFixed(1)}% > ${(100 * maxFragile).toFixed(1)}%`);
  if (c.roughA + c.roughB > maxRough) reasons.push(`roughness ${(c.roughA + c.roughB).toFixed(3)} > ${maxRough.toFixed(2)}`);
  return { pass: reasons.length === 0, reasons };
}

function labelCentroids(labels, fallback, N, pieceCount) {
  const sum = Array.from({ length: pieceCount }, () => [0, 0, 0, 0]);
  for (let i = 0; i < labels.length; i++) {
    const k = labels[i];
    const [x, y, z] = unidx(i, N);
    sum[k][0] += x;
    sum[k][1] += y;
    sum[k][2] += z;
    sum[k][3]++;
  }
  return sum.map((s, k) => (s[3] ? [s[0] / s[3] / (N - 1), s[1] / s[3] / (N - 1), s[2] / s[3] / (N - 1)] : fallback[k]));
}

function blendSeeds(oldSeeds, newSeeds, amount = 0.38) {
  return oldSeeds.map((s, k) => s.map((v, a) => v * (1 - amount) + newSeeds[k][a] * amount));
}

function volumeCells(c) {
  if (c.counts && c.counts.length) {
    const counts = Array.from(c.counts);
    return { minCells: Math.min(...counts), maxCells: Math.max(...counts) };
  }
  return { minCells: c.minVol ?? 0, maxCells: c.maxVol ?? 0 };
}

export function candidateKey(c, pieceCount) {
  const { minCells, maxCells } = volumeCells(c);
  return [
    pieceCount - c.connected,
    -minCells,
    maxCells,
    c.analyticDifficulty ?? 0,
    c.fragileRatio,
    (c.roughA ?? 0) + (c.roughB ?? 0),
    c.imbalance,
    c.regularity,
    c.similarity,
    -c.adjacencyDifference,
    -c.moved,
    c.seed ?? 0,
    c.jobIndex ?? 0,
  ];
}

export function compareKey(a, b, pieceCount) {
  const A = candidateKey(a, pieceCount);
  const B = candidateKey(b, pieceCount);
  for (let i = 0; i < A.length; i++) {
    if (A[i] < B[i] - 1e-9) return -1;
    if (A[i] > B[i] + 1e-9) return 1;
  }
  return 0;
}

/**
 * Solve one transform set. Timings are milliseconds.
 */
export function solveTransformSet({ N, pieceCount, radius, params, rand, placements = null }) {
  const p = params || defaultParams(pieceCount);
  const usedPlacements = placements || randomTransforms(pieceCount, radius, p.minMoved, rand);
  let seedsA = randomSeedLayout(N, pieceCount, p.asym, rand);
  let seedsB = randomSeedLayout(N, pieceCount, p.asym, rand);
  const rounds = p.rounds;
  const n = N * N * N;
  const target = n / pieceCount;
  const bias = new Float64Array(pieceCount);
  let bestLocal = null;
  let priorA = null;
  let priorB = null;
  const timing = { makeEdgesMs: 0, matchingMs: 0, evalMs: 0, rounds: 0, infeasible: false };
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    const edges = makeEdges(N, pieceCount, usedPlacements, seedsA, seedsB, bias, p, priorA, priorB);
    timing.makeEdgesMs += performance.now() - t0;
    if (edges.some((x) => x.length === 0)) {
      timing.infeasible = true;
      return { candidate: null, timing };
    }
    const t1 = performance.now();
    const match = minCostPerfectMatching(edges);
    timing.matchingMs += performance.now() - t1;
    if (!match) {
      timing.infeasible = true;
      return { candidate: null, timing };
    }
    const t2 = performance.now();
    const cand = evaluateCandidate(N, pieceCount, match, usedPlacements);
    timing.evalMs += performance.now() - t2;
    timing.rounds++;
    if (!bestLocal || compareKey(cand, bestLocal, pieceCount) < 0) bestLocal = cand;
    priorA = match.labelsA;
    priorB = match.labelsB;
    seedsA = blendSeeds(seedsA, labelCentroids(match.labelsA, seedsA, N, pieceCount));
    seedsB = blendSeeds(seedsB, labelCentroids(match.labelsB, seedsB, N, pieceCount));
    for (let k = 0; k < pieceCount; k++) bias[k] += p.balance * (cand.counts[k] - target) / target;
  }
  if (bestLocal) bestLocal.admissibility = admissibility(bestLocal, pieceCount, p);
  return { candidate: bestLocal, timing };
}

export function serializeCandidate(c) {
  if (!c) return null;
  return {
    placements: c.placements,
    labelsA: Array.from(c.labelsA),
    labelsB: Array.from(c.labelsB),
    destOf: Array.from(c.destOf),
    counts: Array.from(c.counts),
    connected: c.connected,
    imbalance: c.imbalance,
    roughA: c.roughA,
    roughB: c.roughB,
    regularity: c.regularity,
    moved: c.moved,
    similarity: c.similarity,
    adjacencyDifference: c.adjacencyDifference,
    minVol: c.minVol,
    maxVol: c.maxVol,
    fragileRatio: c.fragileRatio,
    score: c.score,
    totalCost: c.totalCost,
    exact: true,
    admissibility: c.admissibility,
    components: c.components,
    seed: c.seed ?? null,
    archiveKey: candidateKey(c, c.counts?.length || 0).map((x) => Number(x.toFixed?.(9) ?? x)).join('|'),
  };
}
