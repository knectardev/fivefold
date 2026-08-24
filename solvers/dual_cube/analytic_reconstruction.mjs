/**
 * CPU analytic reconstruction (CAD track start).
 * One canonical surface per physical mating interface, transformed into both
 * assemblies. This is not voxel-mesh deformation and is not GPU work.
 *
 *   node solvers/dual_cube/analytic_reconstruction.mjs solvers/dual_cube/results/candidate_N10_P8.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseCandidate } from './json_contract.mjs';
import { connectedComponents } from './exact_cover_kernel.mjs';
import { runStudioBaseline, STUDIO_DEFAULTS } from './surface_studio_kernel.mjs';

const GAP_TOL = 0.02;
const OVERLAP_TOL = 0.02;
const MIN_THICKNESS = 0.04;

function idx(x, y, z, N) {
  return x + N * (y + N * z);
}

function pieceVolumes(labels, pieceCount) {
  const counts = new Int32Array(pieceCount);
  for (const k of labels) counts[k]++;
  return counts;
}

function minVoxelThickness(labels, N) {
  const n = labels.length;
  let minT = Infinity;
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let i = 0; i < n; i++) {
    const k = labels[i];
    const x = i % N;
    const y = Math.floor(i / N) % N;
    const z = Math.floor(i / (N * N));
    let dist = 0;
    let boundary = false;
    for (let s = 1; s < N; s++) {
      for (const d of dirs) {
        const X = x + d[0] * s;
        const Y = y + d[1] * s;
        const Z = z + d[2] * s;
        if (X < 0 || Y < 0 || Z < 0 || X >= N || Y >= N || Z >= N) {
          boundary = true;
          dist = s;
          break;
        }
        if (labels[idx(X, Y, Z, N)] !== k) {
          boundary = true;
          dist = s;
          break;
        }
      }
      if (boundary) break;
    }
    if (boundary) minT = Math.min(minT, dist / N);
  }
  return Number.isFinite(minT) ? minT : 0;
}

function topologyReport(labels, pieceCount, N) {
  const comps = [];
  let disconnected = 0;
  for (let k = 0; k < pieceCount; k++) {
    const c = connectedComponents(labels, k, N);
    comps.push(c);
    if (c.comps !== 1) disconnected++;
  }
  return { disconnected, pieces: comps };
}

/**
 * Group studio patches into canonical physical interfaces: unordered piece pair
 * + Cube A connected component. The same analytic model is the mating surface
 * in both assemblies.
 */
export function reconstructAnalytic(raw, settings = STUDIO_DEFAULTS) {
  const cand = parseCandidate(raw);
  const N = cand.gridResolution;
  const P = cand.pieceCount;
  const baseline = runStudioBaseline(cand, settings);
  const topoA = topologyReport(cand.labelsA, P, N);
  const topoB = topologyReport(cand.labelsB, P, N);
  const volA = pieceVolumes(cand.labelsA, P);
  const thicknessA = minVoxelThickness(cand.labelsA, N);
  const thicknessB = minVoxelThickness(cand.labelsB, N);

  const reasons = [];
  if (topoA.disconnected) reasons.push(`${topoA.disconnected} disconnected Cube A piece(s)`);
  if (topoB.disconnected) reasons.push(`${topoB.disconnected} disconnected Cube B piece(s)`);
  if (baseline.unresolvedPatches) reasons.push(`${baseline.unresolvedPatches} freeform patches (need plane→quadric→NURBS hierarchy)`);
  if (baseline.cubeB_matingRMS > GAP_TOL) reasons.push(`Cube B mating RMS ${baseline.cubeB_matingRMS.toFixed(4)} > ${GAP_TOL}`);
  if (baseline.cubeB_matingMax > OVERLAP_TOL * 4) reasons.push(`Cube B mating max ${baseline.cubeB_matingMax.toFixed(4)} exceeds overlap/gap budget`);
  if (Math.min(thicknessA, thicknessB) < MIN_THICKNESS) {
    reasons.push(`min thickness ${Math.min(thicknessA, thicknessB).toFixed(4)} < ${MIN_THICKNESS}`);
  }
  for (let k = 0; k < P; k++) {
    if (volA[k] / (N * N * N) < 0.05) reasons.push(`piece ${k + 1} volume ${(100 * volA[k] / (N ** 3)).toFixed(1)}% < 5%`);
  }

  const rhinoReady = reasons.length === 0;
  return {
    schema: 'dual-cube-analytic-report',
    version: 1,
    gridResolution: N,
    pieceCount: P,
    representation: 'canonical-mating-surface-cpu',
    note: 'CPU analytic track start. Shared mating models come from the current fitter; closed-cell Booleans and trim-curve solids are not yet constructed. Mesh deformation is not used as the export geometry.',
    studioBaseline: {
      extractMs: baseline.extractMs,
      fitMs: baseline.fitMs,
      patchCount: baseline.patchCount,
      plane: baseline.plane,
      quadric: baseline.quadric,
      freeform: baseline.freeform,
      cubeB_matingRMS: baseline.cubeB_matingRMS,
      cubeB_matingMax: baseline.cubeB_matingMax,
    },
    hierarchy: { order: ['plane', 'standardQuadric', 'generalQuadric', 'lowDegreeNurbs'], usedThrough: baseline.freeform ? 'freeform-fallback' : (baseline.quadric ? 'quadric' : 'plane') },
    topology: { cubeA: topoA, cubeB: topoB },
    minThickness: { cubeA: thicknessA, cubeB: thicknessB, limit: MIN_THICKNESS },
    volumes: Array.from(volA),
    tolerances: { gap: GAP_TOL, overlap: OVERLAP_TOL, minThickness: MIN_THICKNESS, minVolume: 0.05 },
    exportGate: {
      rhinoReady,
      reasons,
    },
  };
}

const arg = process.argv[2];
if (arg && !arg.endsWith('.mjs')) {
  const raw = JSON.parse(readFileSync(arg, 'utf8'));
  const report = reconstructAnalytic(raw);
  const out = arg.replace(/\.json$/i, '') + '.analytic.json';
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    input: arg,
    output: out,
    rhinoReady: report.exportGate.rhinoReady,
    reasons: report.exportGate.reasons,
    patches: report.studioBaseline.patchCount,
    freeform: report.studioBaseline.freeform,
    Brms: report.studioBaseline.cubeB_matingRMS,
  }, null, 2));
}
