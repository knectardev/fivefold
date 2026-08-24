/**
 * Plane-only analytic patch graph (CAD track).
 * Quadrics are not used. A plane-only failure is informative: those interfaces need curvature.
 *
 *   node solvers/dual_cube/plane_only.mjs solvers/dual_cube/results/candidate_N8_P8.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseCandidate } from './json_contract.mjs';

export const idx = (x, y, z, N) => x + N * (y + N * z);
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a) => {
  const n = norm(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

function jacobi3(A) {
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const M = A.map((r) => [...r]);
  for (let it = 0; it < 40; it++) {
    let p = 0;
    let q = 1;
    let max = Math.abs(M[0][1]);
    for (const [i, j] of [[0, 2], [1, 2]]) {
      if (Math.abs(M[i][j]) > max) {
        max = Math.abs(M[i][j]);
        p = i;
        q = j;
      }
    }
    if (max < 1e-12) break;
    const phi = 0.5 * Math.atan2(2 * M[p][q], M[q][q] - M[p][p]);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    for (let k = 0; k < 3; k++) {
      const mp = M[k][p];
      const mq = M[k][q];
      M[k][p] = c * mp - s * mq;
      M[k][q] = s * mp + c * mq;
    }
    for (let k = 0; k < 3; k++) {
      const mp = M[p][k];
      const mq = M[q][k];
      M[p][k] = c * mp - s * mq;
      M[q][k] = s * mp + c * mq;
    }
    for (let k = 0; k < 3; k++) {
      const vp = V[k][p];
      const vq = V[k][q];
      V[k][p] = c * vp - s * vq;
      V[k][q] = s * vp + c * vq;
    }
  }
  const vals = [M[0][0], M[1][1], M[2][2]];
  const order = [0, 1, 2].sort((a, b) => vals[a] - vals[b]);
  return { values: order.map((i) => vals[i]), vectors: order.map((i) => unit([V[0][i], V[1][i], V[2][i]])) };
}

export function fitPlane(points) {
  const n = points.length;
  const cent = [0, 0, 0];
  for (const q of points) {
    cent[0] += q[0];
    cent[1] += q[1];
    cent[2] += q[2];
  }
  for (let i = 0; i < 3; i++) cent[i] /= n;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const q of points) {
    const d = sub(q, cent);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += (d[i] * d[j]) / n;
  }
  const eig = jacobi3(C);
  const normal = eig.vectors[0];
  let rms = 0;
  for (const q of points) rms += dot(sub(q, cent), normal) ** 2;
  rms = Math.sqrt(rms / n);
  return { origin: cent, normal, u: eig.vectors[2], v: unit(cross(normal, eig.vectors[2])), rms };
}

export function faceGeom(x, y, z, axis, N) {
  const axes = [0, 1, 2].filter((a) => a !== axis);
  const lattice = [];
  for (const s0 of [0, 1]) {
    for (const s1 of [0, 1]) {
      const p = [x, y, z];
      p[axis] += 1;
      p[axes[0]] += s0;
      p[axes[1]] += s1;
      lattice.push(p);
    }
  }
  const order = [0, 1, 3, 2];
  const corners = order.map((i) => lattice[i]);
  const keys = corners.map((p) => p.join(','));
  const edges = [];
  for (let i = 0; i < 4; i++) {
    const a = keys[i];
    const b = keys[(i + 1) % 4];
    edges.push(a < b ? `${a}|${b}` : `${b}|${a}`);
  }
  const center = [
    (x + (axis === 0 ? 1 : 0.5)) / N,
    (y + (axis === 1 ? 1 : 0.5)) / N,
    (z + (axis === 2 ? 1 : 0.5)) / N,
  ];
  return { center, edges, corners, keys, cell: [x, y, z], axis };
}

export function extractInterfaces(labels, N) {
  const faces = [];
  const dirs = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const a = labels[idx(x, y, z, N)];
        for (let di = 0; di < 3; di++) {
          const d = dirs[di];
          const X = x + d[0];
          const Y = y + d[1];
          const Z = z + d[2];
          if (X >= N || Y >= N || Z >= N) continue;
          const b = labels[idx(X, Y, Z, N)];
          if (a === b) continue;
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const geom = faceGeom(x, y, z, di, N);
          faces.push({
            lo,
            hi,
            a,
            b,
            center: geom.center,
            key: `${x},${y},${z},${di}`,
            edges: geom.edges,
            corners: geom.corners,
            keys: geom.keys,
            cell: geom.cell,
            axis: geom.axis,
          });
        }
      }
    }
  }
  return faces;
}

export function connectedPatches(faces) {
  const byPair = new Map();
  for (const f of faces) {
    const pk = `${f.lo}-${f.hi}`;
    if (!byPair.has(pk)) byPair.set(pk, []);
    byPair.get(pk).push(f);
  }
  const patches = [];
  for (const [pair, list] of byPair) {
    const edgeMap = new Map();
    list.forEach((f, i) => f.edges.forEach((e) => {
      if (!edgeMap.has(e)) edgeMap.set(e, []);
      edgeMap.get(e).push(i);
    }));
    const adj = Array.from({ length: list.length }, () => []);
    for (const ids of edgeMap.values()) {
      if (ids.length < 2) continue;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          adj[ids[i]].push(ids[j]);
          adj[ids[j]].push(ids[i]);
        }
      }
    }
    const seen = new Uint8Array(list.length);
    for (let i = 0; i < list.length; i++) {
      if (seen[i]) continue;
      const q = [i];
      seen[i] = 1;
      const comp = [];
      for (let h = 0; h < q.length; h++) {
        const u = q[h];
        comp.push(list[u]);
        for (const v of adj[u]) {
          if (seen[v]) continue;
          seen[v] = 1;
          q.push(v);
        }
      }
      const [lo, hi] = pair.split('-').map(Number);
      patches.push({ lo, hi, faces: comp, points: comp.map((f) => f.center) });
    }
  }
  return patches;
}

export function planeOnlyAnalyze(raw, planeTol = 0.018) {
  const cand = parseCandidate(raw);
  const N = cand.gridResolution;
  const patchesA = connectedPatches(extractInterfaces(cand.labelsA, N));
  const patchesB = connectedPatches(extractInterfaces(cand.labelsB, N));
  const annotate = (patches, state) =>
    patches.map((p, i) => {
      const plane = fitPlane(p.points);
      return {
        id: `${state}:${p.lo}-${p.hi}:${i}`,
        state,
        pieces: [p.lo + 1, p.hi + 1],
        areaFaces: p.faces.length,
        planeRMS: plane.rms,
        planar: plane.rms <= planeTol,
        origin: plane.origin,
        normal: plane.normal,
      };
    });
  const a = annotate(patchesA, 'A');
  const b = annotate(patchesB, 'B');
  const all = [...a, ...b];
  const curved = all.filter((p) => !p.planar);
  const canonicalPairs = new Map();
  for (const p of a) {
    const k = `${Math.min(p.pieces[0], p.pieces[1])}-${Math.max(p.pieces[0], p.pieces[1])}`;
    if (!canonicalPairs.has(k)) canonicalPairs.set(k, []);
    canonicalPairs.get(k).push(p);
  }
  return {
    schema: 'dual-cube-plane-only-report',
    version: 1,
    gridResolution: N,
    pieceCount: cand.pieceCount,
    planeTolerance: planeTol,
    patchCountA: a.length,
    patchCountB: b.length,
    planarCount: all.filter((p) => p.planar).length,
    curvedCount: curved.length,
    planeOnlyFeasible: curved.length === 0 && all.length > 0,
    note: curved.length
      ? 'Plane-only model is not feasible. Curved interfaces listed below should receive quadrics only after the plane-only validator is trusted.'
      : 'All connected interface patches meet the plane tolerance. Closed-cell Boolean construction is the next CAD step.',
    curvedInterfaces: curved.map((p) => ({
      id: p.id,
      pieces: p.pieces,
      areaFaces: p.areaFaces,
      planeRMS: p.planeRMS,
    })),
    canonicalMatingPairs: [...canonicalPairs.entries()].map(([k, list]) => ({
      pair: k,
      patches: list.length,
      allPlanar: list.every((p) => p.planar),
      maxPlaneRMS: Math.max(...list.map((p) => p.planeRMS)),
    })),
    patches: all,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const arg = process.argv[2];
if (isMain && arg && arg.endsWith('.json') && !arg.includes('plane-only')) {
  const raw = JSON.parse(readFileSync(arg, 'utf8'));
  const report = planeOnlyAnalyze(raw);
  const out = arg.replace(/\.json$/i, '.plane-only.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    input: arg,
    output: out,
    planeOnlyFeasible: report.planeOnlyFeasible,
    planar: report.planarCount,
    curved: report.curvedCount,
    pairs: report.canonicalMatingPairs.length,
  }, null, 2));
}
