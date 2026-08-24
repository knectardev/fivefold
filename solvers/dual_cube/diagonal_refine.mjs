/**
 * Bounded dual-interface half-cube refinement.
 * Short split cycles diagnose; CP-SAT (Python OR-Tools, with a JS enumerator
 * fallback) is the Phase 1 solver. The all-whole voxel seed is not success.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { idx, unidx, transformVoxel, parseCandidate } from './json_contract.mjs';
import {
  HALF_COUNT,
  complementHalf,
  halfIndex,
  rotateHalfByR,
  splitHalf,
} from './half_cells.mjs';
import {
  POLY_SCHEMA,
  POLY_VERSION,
  voxelToPolyhedral,
  verifyPolyhedralClosure,
  dualEligibleMask,
  haloMask,
  allowedOwners,
  allCellsEligible,
  destValidOwners,
  applyCellStates,
  statesFromDoc,
  inBounds,
  transformAtom,
  atomComponents,
  FACE,
} from './polyhedral_occupancy.mjs';
import { geometryMetrics, exportOBJ, exportSTL, attachBAtoms } from './polyhedral_export.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const LEX = [
  'exactCover',
  'manifoldPieces',
  'geometryGates',
  'mergedDiagonalArea',
  'boundaryEdgeCount',
  'faceCount',
  'splitCellCount',
  'minFaceArea',
];

export function freezeLexScore(metrics, closure) {
  const comps = closure.componentsA || closure.componentsA || [];
  const manifold = comps.length > 0 && comps.every((c) => c === 1);
  const gates = !!closure.ok && manifold && (metrics.minFaceArea || 0) > 1e-6;
  return {
    exactCover: closure.ok ? 1 : 0,
    manifoldPieces: manifold ? 1 : 0,
    geometryGates: gates ? 1 : 0,
    mergedDiagonalArea: metrics.mergedDiagonalArea || 0,
    boundaryEdgeCount: metrics.boundaryEdgeCount || 0,
    faceCount: metrics.faceCount || 0,
    splitCellCount: metrics.splitCellCount || 0,
    minFaceArea: metrics.minFaceArea || 0,
  };
}

/** Higher is better. Returns negative if a is worse than b. */
export function compareLex(a, b) {
  if (a.exactCover !== b.exactCover) return a.exactCover - b.exactCover;
  if (a.manifoldPieces !== b.manifoldPieces) return a.manifoldPieces - b.manifoldPieces;
  if (a.geometryGates !== b.geometryGates) return a.geometryGates - b.geometryGates;
  if (a.mergedDiagonalArea !== b.mergedDiagonalArea) return a.mergedDiagonalArea - b.mergedDiagonalArea;
  if (a.boundaryEdgeCount !== b.boundaryEdgeCount) return b.boundaryEdgeCount - a.boundaryEdgeCount;
  if (a.faceCount !== b.faceCount) return b.faceCount - a.faceCount;
  if (a.splitCellCount !== b.splitCellCount) return b.splitCellCount - a.splitCellCount;
  return a.minFaceArea - b.minFaceArea;
}

function evaluateDoc(doc) {
  const closure = verifyPolyhedralClosure(doc);
  const metrics = geometryMetrics(doc, transformAtom);
  const score = freezeLexScore(metrics, closure);
  return { closure, metrics, score };
}

function cloneStates(states) {
  return states.map((s) => (s.kind === 'full'
    ? { kind: 'full', owner: s.owner }
    : { kind: 'split', plane: s.plane, owners: [...s.owners] }));
}

export function enumerateSelfClosingSplits(seedDoc, eligible) {
  const N = seedDoc.N;
  const placements = seedDoc.pieces.map((p) => p.transformB);
  const labels = new Int32Array(N * N * N);
  for (const piece of seedDoc.pieces) {
    for (const atom of piece.atoms) {
      if (atom.kind === 'full') labels[idx(...atom.cell, N)] = piece.id;
    }
  }
  const found = [];
  for (let i = 0; i < eligible.length; i++) {
    if (!eligible[i]) continue;
    const cell = unidx(i, N);
    const k = labels[i];
    const owners = allowedOwners(labels, i, N).filter((o) => o !== k);
    for (const j of owners) {
      const destK = transformVoxel(cell, placements[k], N);
      const destJ = transformVoxel(cell, placements[j], N);
      if (!inBounds(destK, N) || !inBounds(destJ, N)) continue;
      if (destK[0] !== destJ[0] || destK[1] !== destJ[1] || destK[2] !== destJ[2]) continue;
      for (let plane = 0; plane < 6; plane++) {
        for (const sideK of [0, 1]) {
          const sideJ = 1 - sideK;
          const hK = rotateHalfByR(halfIndex(plane, sideK), placements[k].r);
          const hJ = rotateHalfByR(halfIndex(plane, sideJ), placements[j].r);
          if (hJ !== complementHalf(hK)) continue;
          if (splitHalf(hK).planeIdx !== splitHalf(hJ).planeIdx) continue;
          found.push({
            cellIndex: i,
            cell,
            plane,
            owners: sideK === 0 ? [k, j] : [j, k],
          });
        }
      }
    }
  }
  return found;
}

function applySplit(states, split) {
  const next = cloneStates(states);
  next[split.cellIndex] = {
    kind: 'split',
    plane: split.plane,
    owners: [...split.owners],
  };
  return next;
}

export function searchSingleSplits(seedDoc, eligible) {
  const states0 = statesFromDoc(seedDoc);
  const base = evaluateDoc(seedDoc);
  let best = { doc: seedDoc, ...base, splits: [] };
  const candidates = enumerateSelfClosingSplits(seedDoc, eligible);
  for (const split of candidates) {
    const doc = applyCellStates(seedDoc, applySplit(states0, split), seedDoc.N);
    const ev = evaluateDoc(doc);
    if (ev.closure.ok && compareLex(ev.score, best.score) > 0) {
      best = { doc, ...ev, splits: [split] };
    }
  }
  return { ...best, candidateCount: candidates.length };
}

function runPythonSat(instancePath, outPath) {
  const py = join(here, 'diagonal_refine_sat.py');
  if (!existsSync(py)) return null;
  try {
    execFileSync('python', [py, instancePath, outPath], {
      encoding: 'utf8',
      timeout: 150000,
      killSignal: 'SIGKILL',
    });
    if (!existsSync(outPath)) return null;
    return JSON.parse(readFileSync(outPath, 'utf8'));
  } catch {
    return null;
  }
}

export function destTables(seedDoc) {
  const N = seedDoc.N;
  const P = seedDoc.pieceCount;
  const n = N * N * N;
  const dest = Array.from({ length: P }, () => Array(n).fill(-1));
  for (let k = 0; k < P; k++) {
    const pl = seedDoc.pieces[k].transformB;
    for (let i = 0; i < n; i++) {
      const d = transformVoxel(unidx(i, N), pl, N);
      dest[k][i] = inBounds(d, N) ? idx(...d, N) : -1;
    }
  }
  return dest;
}

export function diagnoseCycles(seedDoc, eligible) {
  const N = seedDoc.N;
  const dest = destTables(seedDoc);
  const labels = new Int32Array(N * N * N);
  for (const piece of seedDoc.pieces) {
    for (const atom of piece.atoms) {
      if (atom.kind === 'full') labels[idx(...atom.cell, N)] = piece.id;
    }
  }
  const inv = new Int32Array(labels.length).fill(-1);
  for (let i = 0; i < labels.length; i++) {
    const y = dest[labels[i]][i];
    if (y >= 0) inv[y] = i;
  }
  const selfClosing = enumerateSelfClosingSplits(seedDoc, eligible);
  let depth2 = 0;
  for (let i = 0; i < eligible.length; i++) {
    if (!eligible[i]) continue;
    const k = labels[i];
    for (const j of allowedOwners(labels, i, N)) {
      if (j === k) continue;
      const yK = dest[k][i];
      const yJ = dest[j][i];
      if (yK < 0 || yJ < 0 || yK === yJ) continue;
      const i2 = inv[yJ];
      if (i2 >= 0 && i2 !== i && eligible[i2]) depth2++;
    }
  }
  return {
    selfClosing: selfClosing.length,
    depth2,
    samples: selfClosing.slice(0, 8),
  };
}

export function buildSatInstance(seedDoc, eligible, opts = {}) {
  const N = seedDoc.N;
  const P = seedDoc.pieceCount;
  const dest = destTables(seedDoc);
  const labels = new Int32Array(N * N * N);
  for (const piece of seedDoc.pieces) {
    for (const atom of piece.atoms) {
      if (atom.kind === 'full') labels[idx(...atom.cell, N)] = piece.id;
    }
  }
  const cells = [];
  for (let i = 0; i < eligible.length; i++) {
    if (!eligible[i]) continue;
    cells.push({
      index: i,
      cell: unidx(i, N),
      owner: labels[i],
      allowed: opts.native ? destValidOwners(dest, i, P) : allowedOwners(labels, i, N),
    });
  }
  return {
    N,
    P,
    dest,
    placements: seedDoc.pieces.map((p) => p.transformB),
    labels: [...labels],
    eligibleCells: cells,
    rotationTable: Array.from({ length: 24 }, (_, r) => {
      const row = [];
      for (let h = 0; h < HALF_COUNT; h++) row.push(rotateHalfByR(h, r));
      return row;
    }),
    native: !!opts.native,
    requireSeedOwner: opts.requireSeedOwner !== false,
    exactVolume: !!opts.exactVolume,
    minPairs: opts.minPairs || 0,
  };
}

export async function refineCandidate(raw, opts = {}) {
  const parsed = parseCandidate(raw);
  const seedDoc = voxelToPolyhedral(parsed);
  seedDoc.N = parsed.gridResolution ?? parsed.N;
  const closure0 = verifyPolyhedralClosure(seedDoc);
  if (!closure0.ok) {
    return { ok: false, stage: 'seed', reasons: closure0.reasons, seedDoc };
  }
  const bandInfo = dualEligibleMask(parsed);
  const N = bandInfo.N;
  const labelsA = bandInfo.labelsA;
  const band = bandInfo.eligible;
  const eligible = opts.halo ? haloMask(band, N) : band;
  const baseline = evaluateDoc(seedDoc);
  let best = { doc: seedDoc, ...baseline, splits: [], solver: 'seed' };

  const js = searchSingleSplits(seedDoc, eligible);
  if (compareLex(js.score, best.score) > 0) best = { ...js, solver: 'js-self-closing' };

  if (opts.usePython !== false) {
    const tmpDir = join(here, 'results');
    mkdirSync(tmpDir, { recursive: true });
    const instPath = join(tmpDir, 'diagonal_sat_instance.json');
    const outPath = join(tmpDir, 'diagonal_sat_solution.json');
    writeFileSync(instPath, JSON.stringify(buildSatInstance(seedDoc, eligible)));
    const sat = runPythonSat(instPath, outPath);
    if (sat && sat.ok && sat.states) {
      const doc = applyCellStates(seedDoc, sat.states, N);
      const ev = evaluateDoc(doc);
      if (ev.closure.ok && compareLex(ev.score, best.score) > 0) {
        best = { doc, ...ev, splits: sat.splits || [], solver: 'cp-sat' };
      }
    }
  }

  const improved = compareLex(best.score, baseline.score) > 0
    && best.score.exactCover === 1
    && best.score.mergedDiagonalArea > baseline.score.mergedDiagonalArea;
  const cycles = diagnoseCycles(seedDoc, eligible);
  const report = proofReport({
    parsed,
    seedDoc,
    best,
    baseline,
    improved,
    eligible,
    halo: !!opts.halo,
    labelsA,
    cycles,
  });
  return {
    ok: improved,
    improved,
    stage: opts.halo ? 'halo' : 'dual-interface',
    solver: best.solver,
    baseline: baseline.score,
    score: best.score,
    doc: best.doc,
    report,
    eligibleCount: eligible.reduce((s, x) => s + x, 0),
  };
}

export function proofReport({ parsed, seedDoc, best, baseline, improved, eligible, halo, labelsA, cycles }) {
  const N = seedDoc.N;
  return {
    schema: POLY_SCHEMA,
    version: POLY_VERSION,
    seed: {
      N,
      pieceCount: seedDoc.pieceCount,
      placements: seedDoc.pieces.map((p) => p.transformB),
      voxelSchema: parsed.schema,
    },
    stage: halo ? 'halo' : 'dual-interface',
    solver: best.solver,
    improved,
    eligibleCount: eligible.reduce((s, x) => s + x, 0),
    pieces: best.doc.pieces.map((p) => ({
      id: p.id,
      transformB: p.transformB,
      atoms: p.atoms,
    })),
    coverA: best.closure.coverA,
    coverB: best.closure.coverB,
    volumes: best.closure.volumes,
    componentsA: best.closure.componentsA,
    componentsB: best.closure.componentsB,
    splitCellCount: best.score.splitCellCount,
    mergedDiagonalArea: best.score.mergedDiagonalArea,
    faceCount: best.score.faceCount,
    boundaryEdgeCount: best.score.boundaryEdgeCount,
    minFaceArea: best.score.minFaceArea,
    baseline: baseline.score,
    comparison: {
      lexBetter: compareLex(best.score, baseline.score) > 0,
      diagonalAreaDelta: best.score.mergedDiagonalArea - baseline.score.mergedDiagonalArea,
      faceDelta: best.score.faceCount - baseline.score.faceCount,
      edgeDelta: best.score.boundaryEdgeCount - baseline.score.boundaryEdgeCount,
    },
    goNogo: {
      pass: improved,
      reason: improved
        ? 'exact dual cover with merged diagonal area above voxel baseline'
        : halo
          ? 'dual-interface and halo found no improving exact split'
          : 'direct dual-interface band found no improving exact split',
    },
    cycles: cycles || { selfClosing: 0, depth2: 0, samples: [] },
    labelsAChecksum: checksum(labelsA),
  };
}

function checksum(arr) {
  let h = 0;
  for (let i = 0; i < arr.length; i++) h = (h * 33 + (arr[i] + 1)) >>> 0;
  return h;
}

export function writeOutputs(result, outDir) {
  mkdirSync(outDir, { recursive: true });
  const tag = result.improved ? 'improved' : 'baseline';
  const jsonPath = join(outDir, `polyhedral_N${result.doc.N}_P${result.doc.pieceCount}.${tag}.json`);
  const reportPath = join(outDir, `polyhedral_N${result.doc.N}_P${result.doc.pieceCount}.proof.json`);
  const objA = join(outDir, `polyhedral_N${result.doc.N}_P${result.doc.pieceCount}.A.obj`);
  const objB = join(outDir, `polyhedral_N${result.doc.N}_P${result.doc.pieceCount}.B.obj`);
  attachBAtoms(result.doc, transformAtom, result.doc.N);
  writeFileSync(jsonPath, JSON.stringify({ ...result.doc, proof: result.report }, null, 2));
  writeFileSync(reportPath, JSON.stringify(result.report, null, 2));
  writeFileSync(objA, exportOBJ(result.doc, 'A'));
  const bDoc = {
    ...result.doc,
    pieces: result.doc.pieces.map((p) => ({
      ...p,
      atoms: p.atoms.map((a) => transformAtom(a, p.transformB, result.doc.N)),
    })),
  };
  writeFileSync(objB, exportOBJ(bDoc, 'A'));
  const stlA = join(outDir, `polyhedral_N${result.doc.N}_P${result.doc.pieceCount}.A.stl`);
  const stlB = join(outDir, `polyhedral_N${result.doc.N}_P${result.doc.pieceCount}.B.stl`);
  writeFileSync(stlA, exportSTL(result.doc, 'A'));
  writeFileSync(stlB, exportSTL(bDoc, 'A'));
  return { jsonPath, reportPath, objA, objB, stlA, stlB };
}

export async function runPhase1(raw, outDir) {
  const direct = await refineCandidate(raw, { halo: false });
  writeOutputs(direct, outDir);
  if (direct.improved) return { ...direct, halt: 'adopt-hybrid' };
  const halo = await refineCandidate(raw, { halo: true });
  writeOutputs(halo, outDir);
  if (halo.improved) return { ...halo, halt: 'adopt-hybrid-halo' };
  return {
    ...halo,
    halt: 'native-hybrid-or-abandon-seed',
    note: 'Phase 1 two-stage stop: dual-interface and one-cell halo found no improving exact split. Do not patch the N³ matching kernel.',
  };
}

export function productScore(metrics, closure) {
  const score = freezeLexScore(metrics, closure);
  score.maxDiagonalFace = metrics.maxDiagonalFace || 0;
  const tiny = (metrics.minFaceArea || 0) < 0.25;
  const excess = (metrics.splitCellCount || 0) > 24;
  if (tiny || excess) score.geometryGates = 0;
  return score;
}

export function compareProduct(a, b) {
  if (a.exactCover !== b.exactCover) return a.exactCover - b.exactCover;
  if (a.manifoldPieces !== b.manifoldPieces) return a.manifoldPieces - b.manifoldPieces;
  if (a.geometryGates !== b.geometryGates) return a.geometryGates - b.geometryGates;
  const aMax = a.maxDiagonalFace || 0;
  const bMax = b.maxDiagonalFace || 0;
  if (aMax !== bMax) return aMax - bMax;
  if (a.mergedDiagonalArea !== b.mergedDiagonalArea) return a.mergedDiagonalArea - b.mergedDiagonalArea;
  if (a.boundaryEdgeCount !== b.boundaryEdgeCount) return b.boundaryEdgeCount - a.boundaryEdgeCount;
  if (a.faceCount !== b.faceCount) return b.faceCount - a.faceCount;
  if (a.splitCellCount !== b.splitCellCount) return b.splitCellCount - a.splitCellCount;
  return a.minFaceArea - b.minFaceArea;
}

export function connectivityCuts(doc) {
  const N = doc.N;
  const cuts = [];
  for (const piece of doc.pieces) {
    const groups = atomComponents(piece.atoms);
    if (groups.length <= 1) continue;
    for (const atoms of groups) {
      const cells = [];
      const seen = new Set();
      for (const atom of atoms) {
        const i = idx(...atom.cell, N);
        if (!seen.has(i)) {
          seen.add(i);
          cells.push(i);
        }
      }
      const neighbors = [];
      const nSeen = new Set();
      for (const i of cells) {
        const [x, y, z] = unidx(i, N);
        for (const d of FACE) {
          const v = [x + d[0], y + d[1], z + d[2]];
          if (!inBounds(v, N)) continue;
          const j = idx(...v, N);
          if (!seen.has(j) && !nSeen.has(j)) {
            nSeen.add(j);
            neighbors.push(j);
          }
        }
      }
      cuts.push({ piece: piece.id, component: cells, neighbors });
    }
  }
  return cuts;
}

function assignmentNogood(states, eligible) {
  const keep = [];
  const splits = [];
  for (let i = 0; i < states.length; i++) {
    if (!eligible[i]) continue;
    const st = states[i];
    if (!st || st.kind === 'full') keep.push(i);
    else splits.push({ index: i, plane: st.plane, owners: [...st.owners] });
  }
  return { keep, splits };
}

export function preservePhase1Fixture(outDir, N, P) {
  const src = join(outDir, `polyhedral_N${N}_P${P}.improved.json`);
  const dst = join(outDir, `polyhedral_N${N}_P${P}.phase1.json`);
  if (!existsSync(src) || existsSync(dst)) return dst;
  copyFileSync(src, dst);
  const proofSrc = join(outDir, `polyhedral_N${N}_P${P}.proof.json`);
  const proofDst = join(outDir, `polyhedral_N${N}_P${P}.phase1.proof.json`);
  if (existsSync(proofSrc)) copyFileSync(proofSrc, proofDst);
  for (const ext of ['A.obj', 'B.obj', 'A.stl', 'B.stl']) {
    const a = join(outDir, `polyhedral_N${N}_P${P}.${ext}`);
    const b = join(outDir, `polyhedral_N${N}_P${P}.phase1.${ext}`);
    if (existsSync(a) && !existsSync(b)) copyFileSync(a, b);
  }
  return dst;
}

function evaluateProduct(doc) {
  const closure = verifyPolyhedralClosure(doc);
  const metrics = geometryMetrics(doc, transformAtom);
  const score = productScore(metrics, closure);
  return { closure, metrics, score };
}

function connectedSatSearch(seedDoc, eligible, fixture, stage, extras = {}) {
  const N = seedDoc.N;
  const cuts = [];
  const nogoods = [];
  const log = [];
  let best = null;
  let connected = 0;
  let fragmented = 0;
  const tmpDir = join(here, 'results');
  mkdirSync(tmpDir, { recursive: true });
  const tag = extras.tag || 'product';
  const instPath = join(tmpDir, `diagonal_sat_${tag}_instance.json`);
  const outPath = join(tmpDir, `diagonal_sat_${tag}_solution.json`);
  const maxIter = extras.maxIter ?? 30;
  const maxFragmented = extras.maxFragmented ?? 12;

  for (let iter = 0; iter < maxIter; iter++) {
    const inst = {
      ...buildSatInstance(seedDoc, eligible, extras),
      mode: extras.mode || 'product',
      maxSplits: extras.maxSplits ?? 16,
      minPairs: extras.minPairs ?? 0,
      requireSeedOwner: extras.requireSeedOwner !== false,
      exactVolume: !!extras.exactVolume,
      minPieceMilli: extras.minPieceMilli || 0,
      cuts,
      nogoods,
      timeLimit: extras.timeLimit ?? 30,
    };
    writeFileSync(instPath, JSON.stringify(inst));
    const sat = runPythonSat(instPath, outPath);
    if (!sat || !sat.ok || !sat.states) {
      log.push({ iter, stage, status: sat?.status ?? 'fail', note: 'infeasible-or-timeout' });
      break;
    }
    const doc = applyCellStates(seedDoc, sat.states, N);
    const ev = evaluateProduct(doc);
    const newCuts = connectivityCuts(doc);
    if (newCuts.length) {
      fragmented++;
      cuts.push(...newCuts);
      nogoods.push(assignmentNogood(sat.states, eligible));
      log.push({
        iter, stage, splits: sat.splits?.length || 0, disconnected: newCuts.length, fragmented,
      });
      if (fragmented >= maxFragmented) {
        log.push({ iter, stage, note: 'stop-fragmented' });
        break;
      }
      continue;
    }
    connected++;
    const better = ev.closure.ok
      && ev.score.geometryGates === 1
      && compareProduct(ev.score, fixture.score) > 0;
    log.push({
      iter, stage, splits: sat.splits?.length || 0, connected: true, better,
      score: ev.score,
    });
    if (better && (!best || compareProduct(ev.score, best.score) > 0)) {
      best = {
        doc, ...ev, better: true, solver: 'cp-sat-connected', splits: sat.splits || [], stage,
      };
    }
    nogoods.push(assignmentNogood(sat.states, eligible));
    if (connected >= 6) break;
  }
  return { best, log, connected, fragmented };
}

export function writeProductOutputs(result, outDir) {
  mkdirSync(outDir, { recursive: true });
  const N = result.doc.N;
  const P = result.doc.pieceCount;
  const jsonPath = join(outDir, `polyhedral_N${N}_P${P}.product.json`);
  const reportPath = join(outDir, `polyhedral_N${N}_P${P}.product.proof.json`);
  attachBAtoms(result.doc, transformAtom, N);
  writeFileSync(jsonPath, JSON.stringify({ ...result.doc, proof: result.report }, null, 2));
  writeFileSync(reportPath, JSON.stringify(result.report, null, 2));
  writeFileSync(join(outDir, `polyhedral_N${N}_P${P}.product.A.obj`), exportOBJ(result.doc, 'A'));
  const bDoc = {
    ...result.doc,
    pieces: result.doc.pieces.map((p) => ({
      ...p,
      atoms: p.atoms.map((a) => transformAtom(a, p.transformB, N)),
    })),
  };
  writeFileSync(join(outDir, `polyhedral_N${N}_P${P}.product.B.obj`), exportOBJ(bDoc, 'A'));
  writeFileSync(join(outDir, `polyhedral_N${N}_P${P}.product.A.stl`), exportSTL(result.doc, 'A'));
  writeFileSync(join(outDir, `polyhedral_N${N}_P${P}.product.B.stl`), exportSTL(bDoc, 'A'));
  return { jsonPath, reportPath };
}

export async function runProductSearch(raw, outDir) {
  const parsed = parseCandidate(raw);
  const seedDoc = voxelToPolyhedral(parsed);
  seedDoc.N = parsed.gridResolution ?? parsed.N;
  const out = outDir || join(here, 'results');
  preservePhase1Fixture(out, seedDoc.N, seedDoc.pieceCount);
  const bandInfo = dualEligibleMask(parsed);
  const N = bandInfo.N;
  const phase1Path = join(out, `polyhedral_N${seedDoc.N}_P${seedDoc.pieceCount}.phase1.json`);
  let fixtureDoc = seedDoc;
  if (existsSync(phase1Path)) {
    fixtureDoc = JSON.parse(readFileSync(phase1Path, 'utf8'));
    fixtureDoc.N = fixtureDoc.N || seedDoc.N;
  }
  const fixture = evaluateProduct(fixtureDoc);
  const log = [];

  const band = connectedSatSearch(seedDoc, bandInfo.eligible, fixture, 'dual-interface');
  log.push(...band.log);
  if (band.best) {
    const report = {
      schema: POLY_SCHEMA,
      version: POLY_VERSION,
      phase: 'product-search',
      halt: 'product-improved',
      stage: 'dual-interface',
      solver: band.best.solver,
      score: band.best.score,
      fixture: fixture.score,
      log,
    };
    const packed = { ...band.best, report };
    writeProductOutputs(packed, out);
    return { ...packed, halt: 'product-improved', log, fixture: fixture.score };
  }

  const halo = connectedSatSearch(seedDoc, haloMask(bandInfo.eligible, N), fixture, 'halo');
  log.push(...halo.log);
  if (halo.best) {
    const report = {
      schema: POLY_SCHEMA,
      version: POLY_VERSION,
      phase: 'product-search',
      halt: 'product-improved-halo',
      stage: 'halo',
      solver: halo.best.solver,
      score: halo.best.score,
      fixture: fixture.score,
      log,
    };
    const packed = { ...halo.best, report };
    writeProductOutputs(packed, out);
    return { ...packed, halt: 'product-improved-halo', log, fixture: fixture.score };
  }

  const report = {
    schema: POLY_SCHEMA,
    version: POLY_VERSION,
    phase: 'product-search',
    halt: 'keep-phase1',
    reason: 'no connected SAT assignment beat the one-split Phase 1 fixture',
    fixture: fixture.score,
    log,
  };
  writeFileSync(join(out, `polyhedral_N${seedDoc.N}_P${seedDoc.pieceCount}.product.proof.json`), JSON.stringify(report, null, 2));
  return { halt: 'keep-phase1', improved: false, report, log, fixture: fixture.score, score: fixture.score };
}

export function writeNativeOutputs(result, outDir) {
  mkdirSync(outDir, { recursive: true });
  const N = result.doc.N;
  const P = result.doc.pieceCount;
  attachBAtoms(result.doc, transformAtom, N);
  const jsonPath = join(outDir, `polyhedral_N${N}_P${P}.native.json`);
  const reportPath = join(outDir, `polyhedral_N${N}_P${P}.native.proof.json`);
  writeFileSync(jsonPath, JSON.stringify({ ...result.doc, proof: result.report }, null, 2));
  writeFileSync(reportPath, JSON.stringify(result.report, null, 2));
  writeFileSync(join(outDir, `polyhedral_N${N}_P${P}.native.A.obj`), exportOBJ(result.doc, 'A'));
  const bDoc = {
    ...result.doc,
    pieces: result.doc.pieces.map((p) => ({
      ...p,
      atoms: p.atoms.map((a) => transformAtom(a, p.transformB, N)),
    })),
  };
  writeFileSync(join(outDir, `polyhedral_N${N}_P${P}.native.B.obj`), exportOBJ(bDoc, 'A'));
  writeFileSync(join(outDir, `polyhedral_N${N}_P${P}.native.A.stl`), exportSTL(result.doc, 'A'));
  writeFileSync(join(outDir, `polyhedral_N${N}_P${P}.native.B.stl`), exportSTL(bDoc, 'A'));
  return { jsonPath, reportPath };
}

export async function runNativeSearch(raw, outDir) {
  const parsed = parseCandidate(raw);
  const seedDoc = voxelToPolyhedral(parsed);
  seedDoc.N = parsed.gridResolution ?? parsed.N;
  const out = outDir || join(here, 'results');
  preservePhase1Fixture(out, seedDoc.N, seedDoc.pieceCount);
  const N = seedDoc.N;
  const P = seedDoc.pieceCount;
  const eligible = allCellsEligible(N);
  const phase1Path = join(out, `polyhedral_N${N}_P${P}.phase1.json`);
  let fixtureDoc = seedDoc;
  if (existsSync(phase1Path)) {
    fixtureDoc = JSON.parse(readFileSync(phase1Path, 'utf8'));
    fixtureDoc.N = fixtureDoc.N || N;
  }
  const fixture = evaluateProduct(fixtureDoc);
  const log = [];
  const tiers = [8, 16, 32];
  let best = null;

  for (const maxSplits of tiers) {
    const found = connectedSatSearch(seedDoc, eligible, fixture, `native-${maxSplits}`, {
      native: true,
      mode: 'native',
      tag: `native${maxSplits}`,
      maxSplits,
      minPairs: 1,
      requireSeedOwner: true,
      exactVolume: false,
      minPieceMilli: 48,
      timeLimit: 45,
      maxIter: 6,
      maxFragmented: 6,
    });
    log.push(...found.log);
    if (found.best && (!best || compareProduct(found.best.score, best.score) > 0)) {
      best = found.best;
    }
    if (best && (best.score.maxDiagonalFace || 0) > (fixture.score.maxDiagonalFace || 0) + 0.5) {
      break;
    }
  }

  const sheet = best && (best.score.maxDiagonalFace || 0) > (fixture.score.maxDiagonalFace || 0) + 0.5;
  if (best && sheet) {
    const report = {
      schema: POLY_SCHEMA,
      version: POLY_VERSION,
      phase: 'native-stage1',
      halt: 'native-improved',
      solver: best.solver,
      score: best.score,
      fixture: fixture.score,
      log,
      note: 'Any-cell 45° splits with frozen transforms produced a connected coplanar sheet.',
    };
    const packed = { ...best, report };
    writeNativeOutputs(packed, out);
    return { ...packed, halt: 'native-improved', improved: true, log, fixture: fixture.score };
  }

  const report = {
    schema: POLY_SCHEMA,
    version: POLY_VERSION,
    phase: 'native-stage1',
    halt: 'native-no-sheet',
    reason: 'no connected any-cell assignment formed a coplanar diagonal sheet under the frozen eight transforms',
    fixture: fixture.score,
    bestAttempt: best?.score || null,
    log,
  };
  writeFileSync(join(out, `polyhedral_N${N}_P${P}.native.proof.json`), JSON.stringify(report, null, 2));
  return {
    halt: 'native-no-sheet',
    improved: false,
    report,
    log,
    fixture: fixture.score,
    score: best?.score || fixture.score,
  };
}

function isMain() {
  const self = fileURLToPath(import.meta.url);
  const arg = process.argv[1] ? process.argv[1].replaceAll('\\', '/') : '';
  return arg.endsWith('diagonal_refine.mjs');
}

if (isMain()) {
  const product = process.argv.includes('--product');
  const native = process.argv.includes('--native');
  const args = process.argv.slice(2).filter((a) => a !== '--product' && a !== '--native');
  const def = join(here, 'results', 'candidate_N8_P8_connected.json');
  const src = args[0] || def;
  const outDir = args[1] || join(here, 'results');
  const raw = JSON.parse(readFileSync(src, 'utf8'));
  const run = native
    ? runNativeSearch(raw, outDir)
    : product
      ? runProductSearch(raw, outDir)
      : runPhase1(raw, outDir);
  run.then((r) => {
    console.log(JSON.stringify({
      halt: r.halt,
      improved: r.improved,
      solver: r.solver,
      eligibleCount: r.eligibleCount,
      score: r.score,
      baseline: r.baseline,
      fixture: r.fixture,
      goNogo: r.report?.goNogo,
      logTail: Array.isArray(r.log) ? r.log.slice(-8) : undefined,
    }, null, 2));
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
