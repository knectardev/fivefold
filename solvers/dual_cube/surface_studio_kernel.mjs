/** Headless baseline of the current mesh-deformation studio (to be discarded, not GPU-ported). */

import { ROT, applyRot } from './json_contract.mjs';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => {
  const n = norm(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

function applyInvRot(v, M) {
  return [
    M[0][0] * v[0] + M[1][0] * v[1] + M[2][0] * v[2],
    M[0][1] * v[0] + M[1][1] * v[1] + M[2][1] * v[2],
    M[0][2] * v[0] + M[1][2] * v[1] + M[2][2] * v[2],
  ];
}

export const STUDIO_DEFAULTS = {
  minPatch: 3,
  planeTol: 0.018,
  quadTol: 0.032,
  complexity: 0.28,
  iters: 35,
  surfaceWeight: 0.62,
  retain: 0.2,
  lap: 0.1,
  maxMove: 0.09,
};

function idx(x, y, z, N) {
  return x + N * (y + N * z);
}

function transformPoint(p, k, cand, N) {
  const pl = cand.placements[k];
  const M = ROT[pl.r];
  const c = sub(p, [0.5, 0.5, 0.5]);
  const q = applyRot(c, M);
  return add(add(q, [0.5, 0.5, 0.5]), pl.t.map((v) => v / N));
}

function inversePoint(p, k, cand, N) {
  const pl = cand.placements[k];
  const M = ROT[pl.r];
  const q = sub(sub(p, [0.5, 0.5, 0.5]), pl.t.map((v) => v / N));
  const c = applyInvRot(q, M);
  return add(c, [0.5, 0.5, 0.5]);
}

function inverseNormal(n, k, cand) {
  return applyInvRot(n, ROT[cand.placements[k].r]);
}

function faceGeom(x, y, z, axis, side, N) {
  const c = [x + 0.5, y + 0.5, z + 0.5];
  const normal = [0, 0, 0];
  normal[axis] = side;
  c[axis] += side * 0.5;
  const axes = [0, 1, 2].filter((a) => a !== axis);
  const verts = [];
  for (const s0 of [-0.5, 0.5]) {
    for (const s1 of [-0.5, 0.5]) {
      const p = [x + 0.5, y + 0.5, z + 0.5];
      p[axis] += side * 0.5;
      p[axes[0]] += s0;
      p[axes[1]] += s1;
      verts.push(p.map((v) => v / N));
    }
  }
  return { center: c.map((v) => v / N), normal, verts: [verts[0], verts[1], verts[3], verts[2]] };
}

function edgeKeys(face, N) {
  const vv = face.verts.map((p) => p.map((v) => Math.round(v * N * 2)).join(','));
  const out = [];
  for (let i = 0; i < 4; i++) {
    const a = vv[i];
    const b = vv[(i + 1) % 4];
    out.push(a < b ? `${a}|${b}` : `${b}|${a}`);
  }
  return out;
}

function canonicalFaceKey(piece, center, normal, N) {
  const c = center.map((v) => Math.round(v * N * 2));
  const n = normal.map((v) => Math.round(v));
  return `${piece}|${c.join(',')}|${n.join(',')}`;
}

function extractState(labels, state, cand, N, constraints) {
  const faces = [];
  const byPair = new Map();
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const a = labels[idx(x, y, z, N)];
        for (let di = 0; di < 6; di++) {
          const d = dirs[di];
          const X = x + d[0];
          const Y = y + d[1];
          const Z = z + d[2];
          const axis = Math.floor(di / 2);
          const side = di % 2 === 0 ? 1 : -1;
          if (X >= 0 && Y >= 0 && Z >= 0 && X < N && Y < N && Z < N) {
            const b = labels[idx(X, Y, Z, N)];
            if (a === b || a > b) continue;
            const g = faceGeom(x, y, z, axis, side, N);
            const face = { ...g, state, a, b, edges: [], pieceKeys: [] };
            face.edges = edgeKeys(face, N);
            if (state === 'A') {
              face.pieceKeys = [
                canonicalFaceKey(a, face.center, face.normal, N),
                canonicalFaceKey(b, face.center, mul(face.normal, -1), N),
              ];
            } else {
              const ca = inversePoint(face.center, a, cand, N);
              const na = inverseNormal(face.normal, a, cand);
              const cb = inversePoint(face.center, b, cand, N);
              const nb = inverseNormal(mul(face.normal, -1), b, cand);
              face.pieceKeys = [canonicalFaceKey(a, ca, na, N), canonicalFaceKey(b, cb, nb, N)];
            }
            faces.push(face);
            const key = `${state}:${a}-${b}`;
            if (!byPair.has(key)) byPair.set(key, []);
            byPair.get(key).push(face);
          } else {
            const g = faceGeom(x, y, z, axis, side, N);
            if (state === 'A') {
              addConstraint(constraints, canonicalFaceKey(a, g.center, g.normal, N), {
                type: 'exterior',
                state: 'A',
                piece: a,
                axis,
                side,
                planeCoord: g.center[axis],
              });
            } else {
              const cc = inversePoint(g.center, a, cand, N);
              const nn = inverseNormal(g.normal, a, cand);
              addConstraint(constraints, canonicalFaceKey(a, cc, nn, N), {
                type: 'exterior',
                state: 'B',
                piece: a,
                axis,
                side,
                planeCoord: g.center[axis],
              });
            }
          }
        }
      }
    }
  }
  return { faces, byPair };
}

function addConstraint(constraints, key, ref) {
  if (!constraints.has(key)) constraints.set(key, []);
  constraints.get(key).push(ref);
}

function connectedComponentsFaces(list) {
  const edgeMap = new Map();
  list.forEach((f, i) => f.edges.forEach((e) => {
    if (!edgeMap.has(e)) edgeMap.set(e, []);
    edgeMap.get(e).push(i);
  }));
  const adj = Array.from({ length: list.length }, () => []);
  for (const ids of edgeMap.values()) {
    if (ids.length > 1) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          adj[ids[i]].push(ids[j]);
          adj[ids[j]].push(ids[i]);
        }
      }
    }
  }
  const seen = new Uint8Array(list.length);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (seen[i]) continue;
    const q = [i];
    const comp = [];
    seen[i] = 1;
    for (let h = 0; h < q.length; h++) {
      const u = q[h];
      comp.push(list[u]);
      for (const v of adj[u]) {
        if (!seen[v]) {
          seen[v] = 1;
          q.push(v);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

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

function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(M[j][i]) > Math.abs(M[p][i])) p = j;
    if (Math.abs(M[p][i]) < 1e-12) return null;
    [M[i], M[p]] = [M[p], M[i]];
    const d = M[i][i];
    for (let j = i; j <= n; j++) M[i][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = M[r][i];
      for (let j = i; j <= n; j++) M[r][j] -= f * M[i][j];
    }
  }
  return M.map((r) => r[n]);
}

function fitPatch(p, settings) {
  const pts = p.points;
  const n = pts.length;
  const cent = [0, 0, 0];
  for (const q of pts) {
    cent[0] += q[0];
    cent[1] += q[1];
    cent[2] += q[2];
  }
  for (let i = 0; i < 3; i++) cent[i] /= n;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const q of pts) {
    const d = sub(q, cent);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += (d[i] * d[j]) / n;
  }
  const eig = jacobi3(C);
  const normal = eig.vectors[0];
  const u = eig.vectors[2];
  const v = unit(cross(normal, u));
  let ePlane = 0;
  for (const q of pts) {
    const w = dot(sub(q, cent), normal);
    ePlane += w * w;
  }
  ePlane = Math.sqrt(ePlane / n);
  const ATA = Array.from({ length: 6 }, () => Array(6).fill(0));
  const ATb = Array(6).fill(0);
  for (const q of pts) {
    const d = sub(q, cent);
    const U = dot(d, u);
    const V = dot(d, v);
    const W = dot(d, normal);
    const r = [U * U, U * V, V * V, U, V, 1];
    for (let i = 0; i < 6; i++) {
      ATb[i] += r[i] * W;
      for (let j = 0; j < 6; j++) ATA[i][j] += r[i] * r[j];
    }
  }
  const coef = solveLinear(ATA, ATb) || [0, 0, 0, 0, 0, 0];
  let eQuad = 0;
  for (const q of pts) {
    const d = sub(q, cent);
    const U = dot(d, u);
    const V = dot(d, v);
    const W = dot(d, normal);
    const P = coef[0] * U * U + coef[1] * U * V + coef[2] * V * V + coef[3] * U + coef[4] * V + coef[5];
    eQuad += (W - P) ** 2;
  }
  eQuad = Math.sqrt(eQuad / n);
  let type = 'freeform';
  if (ePlane <= settings.planeTol) type = 'plane';
  else if (eQuad <= settings.quadTol && eQuad < ePlane * (1 - settings.complexity)) type = 'quadric';
  else if (ePlane <= settings.quadTol) type = 'plane';
  return { type, origin: cent, n: normal, u, v, coef, planeRMS: ePlane, quadRMS: eQuad, rms: type === 'quadric' ? eQuad : ePlane };
}

function buildCanonicalMesh(cand, N, K) {
  const vmap = new Map();
  const verts = [];
  const orig = [];
  const faces = Array.from({ length: K }, () => []);
  const adj = [];
  function vid(p) {
    const key = p.map((v) => Math.round(v * N)).join(',');
    if (!vmap.has(key)) {
      vmap.set(key, verts.length);
      verts.push([...p]);
      orig.push([...p]);
      adj.push(new Set());
    }
    return vmap.get(key);
  }
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const k = cand.labelsA[idx(x, y, z, N)];
        for (let di = 0; di < 6; di++) {
          const d = dirs[di];
          const X = x + d[0];
          const Y = y + d[1];
          const Z = z + d[2];
          const axis = Math.floor(di / 2);
          const side = di % 2 === 0 ? 1 : -1;
          if (X >= 0 && Y >= 0 && Z >= 0 && X < N && Y < N && Z < N && cand.labelsA[idx(X, Y, Z, N)] === k) continue;
          const g = faceGeom(x, y, z, axis, side, N);
          const ids = g.verts.map(vid);
          const tri1 = side > 0 ? [ids[0], ids[1], ids[2]] : [ids[0], ids[2], ids[1]];
          const tri2 = side > 0 ? [ids[0], ids[2], ids[3]] : [ids[0], ids[3], ids[2]];
          faces[k].push(tri1, tri2);
          for (let i = 0; i < 4; i++) {
            const a = ids[i];
            const b = ids[(i + 1) % 4];
            adj[a].add(b);
            adj[b].add(a);
          }
        }
      }
    }
  }
  return { verts, orig, faces, adj };
}

function projectModel(point, ref, cand, N) {
  if (ref.type === 'exterior') {
    if (ref.state === 'A') {
      const q = [...point];
      q[ref.axis] = ref.planeCoord;
      return q;
    }
    const y = transformPoint(point, ref.piece, cand, N);
    y[ref.axis] = ref.planeCoord;
    return inversePoint(y, ref.piece, cand, N);
  }
  const m = ref.patch.model;
  if (m.type === 'freeform') return point;
  let y = ref.state === 'A' ? point : transformPoint(point, ref.piece, cand, N);
  const d = sub(y, m.origin);
  const U = dot(d, m.u);
  const V = dot(d, m.v);
  let W = 0;
  if (m.type === 'quadric') {
    W = m.coef[0] * U * U + m.coef[1] * U * V + m.coef[2] * V * V + m.coef[3] * U + m.coef[4] * V + m.coef[5];
  }
  const q = add(add(add(m.origin, mul(m.u, U)), mul(m.v, V)), mul(m.n, W));
  return ref.state === 'A' ? q : inversePoint(q, ref.piece, cand, N);
}

function vertexConstraintRefs(mesh, cand, N, constraints) {
  const out = Array.from({ length: mesh.verts.length }, () => []);
  const coordToId = new Map(mesh.orig.map((p, i) => [p.map((v) => Math.round(v * N)).join(','), i]));
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const k = cand.labelsA[idx(x, y, z, N)];
        for (let di = 0; di < 6; di++) {
          const d = dirs[di];
          const X = x + d[0];
          const Y = y + d[1];
          const Z = z + d[2];
          const axis = Math.floor(di / 2);
          const side = di % 2 === 0 ? 1 : -1;
          if (X >= 0 && Y >= 0 && Z >= 0 && X < N && Y < N && Z < N && cand.labelsA[idx(X, Y, Z, N)] === k) continue;
          const g = faceGeom(x, y, z, axis, side, N);
          const key = canonicalFaceKey(k, g.center, g.normal, N);
          const refs = constraints.get(key) || [];
          for (const p of g.verts) {
            const id = coordToId.get(p.map((v) => Math.round(v * N)).join(','));
            if (id !== undefined) for (const r of refs) if (!out[id].includes(r)) out[id].push(r);
          }
        }
      }
    }
  }
  return out;
}

function bMatingResidual(m, cand, N, patches) {
  if (!m || !cand) return { rms: Infinity, max: Infinity, count: 0 };
  const coordToId = new Map(m.orig.map((p, i) => [p.map((v) => Math.round(v * N)).join(','), i]));
  let sum = 0;
  let max = 0;
  let count = 0;
  for (const p of patches) {
    if (p.state !== 'B') continue;
    for (const f of p.faces) {
      for (const corner of f.verts) {
        const ca = inversePoint(corner, p.a, cand, N);
        const cb = inversePoint(corner, p.b, cand, N);
        const ia = coordToId.get(ca.map((v) => Math.round(v * N)).join(','));
        const ib = coordToId.get(cb.map((v) => Math.round(v * N)).join(','));
        if (ia === undefined || ib === undefined) continue;
        const d = norm(sub(transformPoint(m.verts[ia], p.a, cand, N), transformPoint(m.verts[ib], p.b, cand, N)));
        sum += d * d;
        max = Math.max(max, d);
        count++;
      }
    }
  }
  return { rms: count ? Math.sqrt(sum / count) : 0, max, count };
}

export function runStudioBaseline(candidate, settings = STUDIO_DEFAULTS) {
  const N = candidate.gridResolution ?? candidate.N;
  const K = candidate.pieceCount;
  const cand = {
    labelsA: candidate.labelsA,
    labelsB: candidate.labelsB,
    placements: candidate.placements,
  };
  const constraints = new Map();
  const tExtract = performance.now();
  const A = extractState(cand.labelsA, 'A', cand, N, constraints);
  const B = extractState(cand.labelsB, 'B', cand, N, constraints);
  const patches = [];
  let id = 0;
  for (const stateData of [A, B]) {
    for (const list of stateData.byPair.values()) {
      for (const faces of connectedComponentsFaces(list)) {
        patches.push({
          id: id++,
          state: faces[0].state,
          a: faces[0].a,
          b: faces[0].b,
          faces,
          points: faces.map((f) => f.center),
          model: null,
        });
      }
    }
  }
  const mesh = buildCanonicalMesh(cand, N, K);
  const extractMs = performance.now() - tExtract;

  const tFit = performance.now();
  for (const p of patches) {
    p.small = p.faces.length < settings.minPatch;
    p.model = fitPatch(p, settings);
  }
  for (const p of patches) {
    for (const f of p.faces) {
      addConstraint(constraints, f.pieceKeys[0], { type: 'patch', patch: p, piece: p.a, state: p.state });
      addConstraint(constraints, f.pieceKeys[1], { type: 'patch', patch: p, piece: p.b, state: p.state });
    }
  }
  const fitMs = performance.now() - tFit;

  const tOpt = performance.now();
  const m = {
    verts: mesh.verts.map((p) => [...p]),
    orig: mesh.orig.map((p) => [...p]),
    faces: mesh.faces,
    adj: mesh.adj,
  };
  const refs = vertexConstraintRefs(m, cand, N, constraints);
  const { iters, surfaceWeight: wS, retain: wO, lap: wL, maxMove } = settings;
  for (let it = 0; it < iters; it++) {
    const next = m.verts.map((p, i) => {
      let target = [0, 0, 0];
      let ws = 0;
      for (const r of refs[i]) {
        if (r.type === 'patch' && r.patch.model.type === 'freeform') continue;
        target = add(target, projectModel(p, r, cand, N));
        ws++;
      }
      const q = ws ? mul(target, 1 / ws) : p;
      let avg = [0, 0, 0];
      let deg = 0;
      for (const j of m.adj[i]) {
        avg = add(avg, m.verts[j]);
        deg++;
      }
      avg = deg ? mul(avg, 1 / deg) : p;
      let r = mul(add(add(mul(q, wS), mul(m.orig[i], wO)), mul(avg, wL)), 1 / (wS + wO + wL || 1));
      const d = sub(r, m.orig[i]);
      const dn = norm(d);
      if (dn > maxMove) r = add(m.orig[i], mul(d, maxMove / dn));
      return r.map((v) => clamp(v, -0.05, 1.05));
    });
    m.verts = next;
  }
  const optimizeMs = performance.now() - tOpt;
  const tRes = performance.now();
  const bres = bMatingResidual(m, cand, N, patches);
  const residualMs = performance.now() - tRes;
  const plane = patches.filter((p) => p.model.type === 'plane').length;
  const quadric = patches.filter((p) => p.model.type === 'quadric').length;
  const freeform = patches.filter((p) => p.model.type === 'freeform').length;
  return {
    extractMs,
    fitMs,
    optimizeMs,
    residualMs,
    optimizeMsPerIter: optimizeMs / Math.max(1, iters),
    patchCount: patches.length,
    plane,
    quadric,
    freeform,
    unresolvedPatches: freeform,
    smallPatches: patches.filter((p) => p.small).length,
    vertexCount: m.verts.length,
    cubeB_matingRMS: bres.rms,
    cubeB_matingMax: bres.max,
    rhinoReady: false,
    note: 'Mesh-deformation baseline; not Rhino-ready. Analytic reconstruction is the replacement.',
  };
}
