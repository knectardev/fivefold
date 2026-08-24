/**
 * Joint special-quadric fits in one assembly frame.
 * Families are tried in increasing parameter count; a complexity penalty
 * picks the simplest adequate surface. NURBS are not used.
 */
import { fitPlane, sub, add, scale, dot, norm, unit, cross } from './plane_only.mjs';

const FAMILIES = [
  { type: 'sphere', params: 4 },
  { type: 'cylinder', params: 5 },
  { type: 'cone', params: 6 },
  { type: 'generalQuadric', params: 9 },
];

function solveNormal(AtA, Atb) {
  const n = Atb.length;
  const A = AtA.map((row, i) => [...row, Atb[i]]);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    if (Math.abs(A[i][i]) < 1e-12) return null;
    const piv = A[i][i];
    for (let c = i; c <= n; c++) A[i][c] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = A[r][i];
      for (let c = i; c <= n; c++) A[r][c] -= f * A[i][c];
    }
  }
  return A.map((row) => row[n]);
}

function ls(rows, rhs) {
  const n = rows[0].length;
  const AtA = Array.from({ length: n }, () => Array(n).fill(0));
  const Atb = Array(n).fill(0);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const b = rhs[i];
    for (let a = 0; a < n; a++) {
      Atb[a] += r[a] * b;
      for (let c = 0; c < n; c++) AtA[a][c] += r[a] * r[c];
    }
  }
  return solveNormal(AtA, Atb);
}

function rmsOf(vals) {
  if (!vals.length) return Infinity;
  return Math.sqrt(vals.reduce((s, v) => s + v * v, 0) / vals.length);
}

export function fitSphere(points) {
  if (points.length < 4) return null;
  const rows = points.map((p) => [2 * p[0], 2 * p[1], 2 * p[2], 1]);
  const rhs = points.map((p) => p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
  const x = ls(rows, rhs);
  if (!x) return null;
  const center = [x[0], x[1], x[2]];
  const r2 = x[3] + center[0] ** 2 + center[1] ** 2 + center[2] ** 2;
  if (r2 <= 1e-10) return null;
  const radius = Math.sqrt(r2);
  const rms = rmsOf(points.map((p) => Math.abs(norm(sub(p, center)) - radius)));
  return { type: 'sphere', center, radius, rms, params: 4 };
}

function fitCircle2(points2) {
  if (points2.length < 3) return null;
  const rows = points2.map((p) => [2 * p[0], 2 * p[1], 1]);
  const rhs = points2.map((p) => p[0] * p[0] + p[1] * p[1]);
  const x = ls(rows, rhs);
  if (!x) return null;
  const c = [x[0], x[1]];
  const r2 = x[2] + c[0] ** 2 + c[1] ** 2;
  if (r2 <= 1e-10) return null;
  return { c, r: Math.sqrt(r2) };
}

export function fitCylinder(points) {
  if (points.length < 6) return null;
  const plane = fitPlane(points);
  const axes = [plane.normal, plane.u, plane.v, [1, 0, 0], [0, 1, 0], [0, 0, 1]].map(unit);
  let best = null;
  for (const axis of axes) {
    const a = unit(axis);
    const ref = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = unit(cross(a, ref));
    const v = unit(cross(a, u));
    const pts2 = points.map((p) => [dot(p, u), dot(p, v)]);
    const cir = fitCircle2(pts2);
    if (!cir) continue;
    const center = add(scale(u, cir.c[0]), scale(v, cir.c[1]));
    const rms = rmsOf(points.map((p) => {
      const d = sub(p, center);
      const radial = norm(sub(d, scale(a, dot(d, a))));
      return Math.abs(radial - cir.r);
    }));
    if (!best || rms < best.rms) {
      best = { type: 'cylinder', axis: a, point: center, radius: cir.r, rms, params: 5 };
    }
  }
  return best;
}

export function fitCone(points) {
  if (points.length < 6) return null;
  const plane = fitPlane(points);
  const axis = plane.u;
  const mean = plane.origin;
  let best = null;
  for (const sign of [-1, 1]) {
    for (const dist of [0.2, 0.5, 1, 1.5]) {
      const apex = add(mean, scale(axis, sign * dist));
      const angles = [];
      const radials = [];
      for (const p of points) {
        const w = sub(p, apex);
        const h = dot(w, axis);
        const radial = norm(sub(w, scale(axis, h)));
        const len = norm(w) || 1e-9;
        angles.push(Math.atan2(radial, Math.abs(h) + 1e-9));
        radials.push({ radial, len });
      }
      const alpha = angles.reduce((s, a) => s + a, 0) / angles.length;
      const sa = Math.sin(alpha);
      const rms = rmsOf(points.map((p) => {
        const w = sub(p, apex);
        const h = dot(w, axis);
        const radial = norm(sub(w, scale(axis, h)));
        return radial - Math.abs(h) * Math.tan(alpha);
      }));
      if (!Number.isFinite(rms) || !Number.isFinite(sa) || Math.abs(alpha) < 1e-3) continue;
      if (!best || rms < best.rms) {
        best = { type: 'cone', apex, axis, angle: alpha, rms, params: 6 };
      }
    }
  }
  return best;
}

function jacobiN(A, iters = 80) {
  const n = A.length;
  const M = A.map((r) => [...r]);
  const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let it = 0; it < iters; it++) {
    let p = 0;
    let q = 1;
    let max = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(M[i][j]) > max) {
          max = Math.abs(M[i][j]);
          p = i;
          q = j;
        }
      }
    }
    if (max < 1e-14) break;
    const phi = 0.5 * Math.atan2(2 * M[p][q], M[q][q] - M[p][p]);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    for (let k = 0; k < n; k++) {
      const mp = M[k][p];
      const mq = M[k][q];
      M[k][p] = c * mp - s * mq;
      M[k][q] = s * mp + c * mq;
    }
    for (let k = 0; k < n; k++) {
      const mp = M[p][k];
      const mq = M[q][k];
      M[p][k] = c * mp - s * mq;
      M[q][k] = s * mp + c * mq;
    }
    for (let k = 0; k < n; k++) {
      const vp = V[k][p];
      const vq = V[k][q];
      V[k][p] = c * vp - s * vq;
      V[k][q] = s * vp + c * vq;
    }
  }
  const vals = Array.from({ length: n }, (_, i) => M[i][i]);
  let imin = 0;
  for (let i = 1; i < n; i++) if (vals[i] < vals[imin]) imin = i;
  return Array.from({ length: n }, (_, r) => V[r][imin]);
}

export function quadricEval(coef, p) {
  const [a, b, c, d, e, f, g, h, i, j] = coef;
  const [x, y, z] = p;
  return a * x * x + b * y * y + c * z * z + d * x * y + e * y * z + f * z * x + g * x + h * y + i * z + j;
}

export function quadricGrad(coef, p) {
  const [a, b, c, d, e, f, g, h, i] = coef;
  const [x, y, z] = p;
  return [
    2 * a * x + d * y + f * z + g,
    2 * b * y + d * x + e * z + h,
    2 * c * z + e * y + f * x + i,
  ];
}

export function fitGeneralQuadric(points) {
  if (points.length < 10) return null;
  const ATA = Array.from({ length: 10 }, () => Array(10).fill(0));
  for (const p of points) {
    const [x, y, z] = p;
    const m = [x * x, y * y, z * z, x * y, y * z, z * x, x, y, z, 1];
    for (let a = 0; a < 10; a++) for (let c = 0; c < 10; c++) ATA[a][c] += m[a] * m[c];
  }
  const coef = jacobiN(ATA);
  if (!coef || coef.every((v) => Math.abs(v) < 1e-15)) return null;
  const rms = rmsOf(points.map((p) => {
    const g = norm(quadricGrad(coef, p)) || 1;
    return quadricEval(coef, p) / g;
  }));
  return { type: 'generalQuadric', coefficients: coef, rms, params: 9 };
}

export function selectJointSurface(points, planeTol = 0.018, complexity = 0.12) {
  const plane = points.length >= 3 ? fitPlane(points) : { rms: Infinity };
  const candidates = [
    fitSphere(points),
    fitCylinder(points),
    fitCone(points),
    fitGeneralQuadric(points),
  ].filter(Boolean);
  for (const c of candidates) {
    c.score = c.rms * (1 + complexity * Math.max(0, c.params - 4));
    c.improvesOnPlane = c.rms + 1e-9 < plane.rms * 0.85 || (c.rms <= planeTol && plane.rms > planeTol);
  }
  candidates.sort((a, b) => a.score - b.score);
  const chosen = candidates.find((c) => c.improvesOnPlane && c.rms <= planeTol * 1.75) || null;
  return {
    planeRMS: plane.rms,
    chosen,
    tried: candidates.map((c) => ({ type: c.type, rms: c.rms, params: c.params, score: c.score })),
  };
}

export { FAMILIES };
