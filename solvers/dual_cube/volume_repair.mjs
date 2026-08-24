/**
 * Repair a fully connected exact-cover candidate by transferring A/B
 * correspondence cells from oversized pieces into undersized ones.
 *
 * Placements stay frozen. Relabeling an A-cell is legal only when destOf,
 * rebuilt from the piece transforms, remains a permutation of Cube B.
 *
 *   node solvers/dual_cube/volume_repair.mjs
 *   node solvers/dual_cube/volume_repair.mjs solvers/dual_cube/results/candidate_N8_P8_connected.volume_seed.json
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  idx,
  unidx,
  transformVoxel,
  buildCandidateDocument,
  cadEligibility,
  verifyExactClosure,
} from './json_contract.mjs';
import {
  connectedComponents,
  evaluateCandidate,
  compareKey,
} from './exact_cover_kernel.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, 'results');
const FACE = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export function cadMinCells(N) {
  return Math.ceil(0.05 * N * N * N - 1e-12);
}

export function rebuildCorrespondence(labelsA, placements, N) {
  const n = N * N * N;
  const P = placements.length;
  const labelsB = new Uint8Array(n);
  const destOf = new Int32Array(n);
  labelsB.fill(255);
  destOf.fill(-1);
  for (let x = 0; x < n; x++) {
    const k = labelsA[x];
    if (k < 0 || k >= P) return null;
    const [X, Y, Z] = transformVoxel(unidx(x, N), placements[k], N);
    if (X < 0 || Y < 0 || Z < 0 || X >= N || Y >= N || Z >= N) return null;
    const y = idx(X, Y, Z, N);
    if (labelsB[y] !== 255) return null;
    labelsB[y] = k;
    destOf[x] = y;
  }
  return { labelsA, labelsB, destOf, totalCost: 0 };
}

function destTable(placements, N) {
  const n = N * N * N;
  const P = placements.length;
  const table = Array.from({ length: P }, () => new Int32Array(n));
  for (let k = 0; k < P; k++) {
    for (let x = 0; x < n; x++) {
      const [X, Y, Z] = transformVoxel(unidx(x, N), placements[k], N);
      table[k][x] = X < 0 || Y < 0 || Z < 0 || X >= N || Y >= N || Z >= N ? -1 : idx(X, Y, Z, N);
    }
  }
  return table;
}

export function faceAdjacentTo(labels, x, piece, N) {
  const [a, b, d] = unidx(x, N);
  for (const [dx, dy, dz] of FACE) {
    const X = a + dx;
    const Y = b + dy;
    const Z = d + dz;
    if (X < 0 || Y < 0 || Z < 0 || X >= N || Y >= N || Z >= N) continue;
    if (labels[idx(X, Y, Z, N)] === piece) return true;
  }
  return false;
}

function inverseDest(destOf, n) {
  const inv = new Int32Array(n);
  inv.fill(-1);
  for (let x = 0; x < n; x++) inv[destOf[x]] = x;
  return inv;
}

/**
 * Shortest dest-permutation cycle that reassigns A-cell x0 to piece R.
 * Each step is a complete correspondence element: x maps through T_k(x).
 */
export function findCorrespondenceCycle(labelsA, destOf, tables, x0, R, maxDepth = 6) {
  const P = tables.length;
  const n = labelsA.length;
  const D = labelsA[x0];
  if (D === R) return null;
  const yNew = tables[R][x0];
  const yVac = tables[D][x0];
  if (yNew < 0) return null;
  if (yNew === yVac) return [{ x: x0, from: D, to: R }];
  const inv = inverseDest(destOf, n);
  const displaced0 = inv[yNew];
  if (displaced0 < 0 || displaced0 === x0) return null;
  const nodes = [{ x: x0, from: D, to: R, parent: -1 }];
  const queue = [{ nodeIdx: 0, displaced: displaced0, depth: 1 }];
  const used = new Uint8Array(n);
  used[x0] = 1;
  let qh = 0;
  while (qh < queue.length) {
    const { nodeIdx, displaced, depth } = queue[qh++];
    if (depth > maxDepth || used[displaced]) continue;
    used[displaced] = 1;
    const from = labelsA[displaced];
    for (let k = 0; k < P; k++) {
      if (k === from) continue;
      const y = tables[k][displaced];
      if (y < 0) continue;
      const node = { x: displaced, from, to: k, parent: nodeIdx };
      const ni = nodes.length;
      nodes.push(node);
      if (y === yVac) {
        const path = [];
        for (let p = ni; p >= 0; p = nodes[p].parent) path.push(nodes[p]);
        path.reverse();
        return path;
      }
      const next = inv[y];
      if (next < 0 || used[next] || next === x0) continue;
      queue.push({ nodeIdx: ni, displaced: next, depth: depth + 1 });
    }
  }
  return null;
}

function applyPath(labelsA, path) {
  const next = Uint8Array.from(labelsA);
  for (const step of path) next[step.x] = step.to;
  return next;
}

function allPiecesConnected(labels, N, P) {
  for (let k = 0; k < P; k++) {
    if (connectedComponents(labels, k, N).comps !== 1) return false;
  }
  return true;
}

function floorOk(before, after, floor) {
  for (let k = 0; k < before.length; k++) {
    if (before[k] >= floor && after[k] < floor) return false;
  }
  return true;
}

export function evaluateLabels(labelsA, placements, N) {
  const rebuilt = rebuildCorrespondence(labelsA, placements, N);
  if (!rebuilt) return null;
  return evaluateCandidate(N, placements.length, rebuilt, placements);
}

function roughness(ev) {
  return (ev.roughA ?? 0) + (ev.roughB ?? 0);
}

export function acceptRepair(before, after, opts = {}) {
  const P = before.counts.length;
  const n = before.labelsA.length;
  const N = Math.round(Math.cbrt(n));
  const floor = opts.floor ?? cadMinCells(N);
  const maxRoughGain = opts.maxRoughGain ?? 0.12;
  if (after.connected !== P) return { ok: false, reason: 'disconnected-A' };
  if (!allPiecesConnected(after.labelsB, N, P)) return { ok: false, reason: 'disconnected-B' };
  if (!floorOk(before.counts, after.counts, floor)) return { ok: false, reason: 'floor' };
  if (Math.min(...after.counts) < Math.min(...before.counts)) return { ok: false, reason: 'min-volume' };
  if (roughness(after) > roughness(before) + maxRoughGain) return { ok: false, reason: 'roughness' };
  return { ok: true };
}

function whaleIndex(counts) {
  let w = 0;
  for (let k = 1; k < counts.length; k++) if (counts[k] > counts[w]) w = k;
  return w;
}

function undersized(counts, floor) {
  const out = [];
  for (let k = 0; k < counts.length; k++) if (counts[k] < floor) out.push(k);
  return out;
}

export function repairVolume(candidate, opts = {}) {
  const N = candidate.N ?? candidate.gridResolution;
  const P = candidate.pieceCount;
  const placements = candidate.placements;
  const floor = opts.floor ?? cadMinCells(N);
  const maxIters = opts.maxIters ?? 16;
  let labelsA = Uint8Array.from(candidate.labelsA);
  let current = evaluateLabels(labelsA, placements, N);
  if (!current || current.connected !== P) {
    return { ok: false, reason: 'seed-not-connected', candidate: current };
  }
  const tables = destTable(placements, N);
  const n = N * N * N;
  const steps = [];
  const seedCounts = Array.from(current.counts);

  for (let iter = 0; iter < maxIters; iter++) {
    if (Math.min(...current.counts) >= floor) break;
    const whale = whaleIndex(current.counts);
    const need = undersized(current.counts, floor);
    if (!need.length) break;
    let best = null;
    for (const R of need) {
      for (let x = 0; x < n; x++) {
        if (labelsA[x] !== whale) continue;
        if (!faceAdjacentTo(labelsA, x, R, N)) continue;
        const path = findCorrespondenceCycle(labelsA, current.destOf, tables, x, R, opts.maxDepth ?? 6);
        if (!path) continue;
        const nextA = applyPath(labelsA, path);
        const after = evaluateLabels(nextA, placements, N);
        if (!after) continue;
        const gate = acceptRepair(current, after, { floor, maxRoughGain: opts.maxRoughGain });
        if (!gate.ok) continue;
        if (compareKey(after, current, P) >= 0) continue;
        if (!best || compareKey(after, best.after, P) < 0) {
          best = { after, path, nextA, receiver: R };
        }
      }
    }
    if (!best) break;
    labelsA = best.nextA;
    current = best.after;
    steps.push({
      receiver: best.receiver,
      path: best.path.map((s) => ({ x: s.x, from: s.from, to: s.to })),
      counts: Array.from(current.counts),
      minCells: Math.min(...current.counts),
      maxCells: Math.max(...current.counts),
    });
  }

  const cad = cadEligibility(current.counts, P, current);
  return {
    ok: current.connected === P,
    cadEligible: cad.cadEligible,
    cadQueue: cad.cadQueue,
    cadBlockers: cad.reasons,
    floor,
    seedCounts,
    counts: Array.from(current.counts),
    minCells: Math.min(...current.counts),
    maxCells: Math.max(...current.counts),
    steps,
    candidate: current,
  };
}

/**
 * Post-pass over 22–25-cell connected hits. Does not write files.
 * Callers displace the N=8 connected baseline only when compareKey says so.
 */
export function applyVolumeRepairPostPass(candidates, opts = {}) {
  const N = opts.N;
  const P = opts.pieceCount ?? opts.P;
  const considered = [];
  const repaired = [];
  for (const c of candidates || []) {
    const counts = Array.from(c.counts || []);
    if (!counts.length) continue;
    const minCells = Math.min(...counts);
    if (minCells < 22 || minCells > 25) continue;
    if (c.connected !== (P ?? counts.length)) continue;
    if (!c.labelsA || !c.placements) continue;
    considered.push(c);
    const result = repairVolume({
      ...c,
      N: c.N ?? N,
      gridResolution: c.gridResolution ?? c.N ?? N,
      pieceCount: c.pieceCount ?? P ?? counts.length,
    });
    if (!result.ok || !result.candidate) continue;
    repaired.push({
      seed: c,
      repair: result,
      candidate: {
        ...result.candidate,
        N: c.N ?? N,
        gridResolution: c.gridResolution ?? c.N ?? N,
        pieceCount: c.pieceCount ?? P ?? counts.length,
        seed: c.seed,
        jobIndex: c.jobIndex,
      },
    });
  }
  const pieceCount = P ?? repaired[0]?.candidate?.counts?.length ?? 8;
  repaired.sort((a, b) => compareKey(a.candidate, b.candidate, pieceCount));
  return {
    considered: considered.length,
    repairedCount: repaired.length,
    best: repaired[0] || null,
    all: repaired,
  };
}

export function archiveEntry(candidate, extra = {}) {
  const counts = Array.from(candidate.counts || []);
  return {
    savedAt: new Date().toISOString(),
    seed: candidate.seed ?? extra.seed ?? null,
    jobIndex: candidate.jobIndex ?? extra.jobIndex ?? null,
    connected: candidate.connected,
    counts,
    minCells: counts.length ? Math.min(...counts) : null,
    maxCells: counts.length ? Math.max(...counts) : null,
    minVol: candidate.minVol,
    maxVol: candidate.maxVol ?? null,
    fragileRatio: candidate.fragileRatio,
    rough: (candidate.roughA ?? 0) + (candidate.roughB ?? 0),
    cadEligible: extra.cadEligible ?? false,
    ...extra,
  };
}

export function appendNearMissArchive(outPath, candidate, extra = {}) {
  const counts = Array.from(candidate.counts || []);
  if (!counts.length || candidate.connected !== counts.length) return false;
  const minCells = Math.min(...counts);
  if (minCells < 22 || minCells > 25) return false;
  mkdirSync(dirname(outPath), { recursive: true });
  let doc = { minCellsRange: [22, 25], items: [] };
  if (existsSync(outPath)) {
    try {
      doc = JSON.parse(readFileSync(outPath, 'utf8'));
      if (!Array.isArray(doc.items)) doc.items = [];
    } catch {
      doc = { minCellsRange: [22, 25], items: [] };
    }
  }
  const entry = archiveEntry(candidate, extra);
  const key = `${entry.seed}|${entry.jobIndex}|${counts.join(',')}`;
  if (doc.items.some((it) => `${it.seed}|${it.jobIndex}|${(it.counts || []).join(',')}` === key)) return false;
  doc.items.push(entry);
  doc.items.sort((a, b) => b.minCells - a.minCells || a.maxCells - b.maxCells);
  doc.items = doc.items.slice(0, 50);
  writeFileSync(outPath, JSON.stringify(doc, null, 2));
  return true;
}

function preserveSeed(connectedPath, seedPath) {
  if (!existsSync(connectedPath)) return;
  if (existsSync(seedPath)) return;
  copyFileSync(connectedPath, seedPath);
}

export function writeRepairedDocument(repair, sourceDoc, outPath, extra = {}) {
  const c = repair.candidate;
  const N = sourceDoc.N ?? sourceDoc.gridResolution;
  const P = sourceDoc.pieceCount;
  const cad = cadEligibility(c.counts, P, c);
  const doc = buildCandidateDocument({
    N,
    pieceCount: P,
    placements: c.placements,
    labelsA: c.labelsA,
    labelsB: c.labelsB,
    destOf: c.destOf,
    counts: c.counts,
    metrics: c,
    searchParameters: sourceDoc.searchMetadata?.searchParameters,
    seed: sourceDoc.searchMetadata?.seed,
    provenance: 'volume-repair',
    activePreset: extra.activePreset ?? `volume-repair-n${N}`,
  });
  doc.cadEligible = cad.cadEligible;
  doc.cadQueue = cad.cadQueue;
  doc.cadRole = cad.cadRole;
  doc.repair = {
    seedPath: extra.seedPath ?? null,
    seedCounts: repair.seedCounts,
    steps: repair.steps,
    minCells: repair.minCells,
    maxCells: repair.maxCells,
  };
  writeFileSync(outPath, JSON.stringify(doc));
  return doc;
}

export async function main(argv = process.argv) {
  mkdirSync(resultsDir, { recursive: true });
  const connectedPath = join(resultsDir, 'candidate_N8_P8_connected.json');
  const seedPath = join(resultsDir, 'candidate_N8_P8_connected.volume_seed.json');
  const fixturePath = join(resultsDir, 'candidate_N8_P8.json');
  preserveSeed(connectedPath, seedPath);
  const input = argv[2] || seedPath;
  const sourceDoc = JSON.parse(readFileSync(resolve(input), 'utf8'));
  const N = sourceDoc.N ?? sourceDoc.gridResolution;
  const repair = repairVolume(sourceDoc);
  const archivePath = join(resultsDir, `connected_volume_archive_n${N}.json`);
  appendNearMissArchive(archivePath, evaluateLabels(Uint8Array.from(sourceDoc.labelsA), sourceDoc.placements, N), {
    seed: sourceDoc.searchMetadata?.seed,
    note: 'volume-repair seed',
  });
  console.log(
    `Volume repair N=${N}  seed min=${Math.min(...repair.seedCounts)}  result min=${repair.minCells} max=${repair.maxCells}  steps=${repair.steps.length}  cadEligible=${repair.cadEligible}`,
  );
  for (const step of repair.steps) {
    console.log(`  ${step.path.map((s) => `${s.from}>${s.to}@${s.x}`).join('  ')}  counts=${step.counts.join(',')}`);
  }
  if (repair.cadEligible) {
    const doc = writeRepairedDocument(repair, sourceDoc, connectedPath, { seedPath });
    const closure = verifyExactClosure(doc);
    console.log(`Wrote ${connectedPath}  exact=${closure.ok}  cadQueue=${doc.cadQueue}`);
  } else {
    console.log(`CAD gate not reached (${repair.cadQueue}: ${(repair.cadBlockers || []).join('; ')}). Seed preserved.`);
  }
  if (existsSync(fixturePath)) {
    console.log(`Left fixture ${fixturePath} untouched.`);
  }
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
