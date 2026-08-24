/**
 * Frozen-carrier evaluation. Surface parameters are not optimized here.
 */
import { sub, add, scale, dot, cross, norm, unit } from './plane_only.mjs';
import { quadricEval, quadricGrad } from './joint_quadrics.mjs';

export function evalSurface(s, p) {
  if (!s || s.type === 'unfitted-curved') return Infinity;
  if (s.type === 'plane') return dot(sub(p, s.origin), s.normal);
  if (s.type === 'sphere') return norm(sub(p, s.center)) - s.radius;
  if (s.type === 'cylinder') {
    const a = unit(s.axis);
    const w = sub(p, s.point);
    return norm(sub(w, scale(a, dot(w, a)))) - s.radius;
  }
  if (s.type === 'cone') {
    const a = unit(s.axis);
    const w = sub(p, s.apex);
    const h = dot(w, a);
    const radial = norm(sub(w, scale(a, h)));
    return radial - Math.abs(h) * Math.tan(s.angle);
  }
  if (s.type === 'generalQuadric') {
    const g = norm(quadricGrad(s.coefficients, p)) || 1;
    return quadricEval(s.coefficients, p) / g;
  }
  return Infinity;
}

export function gradSurface(s, p) {
  if (!s || s.type === 'unfitted-curved') return [0, 0, 0];
  if (s.type === 'plane') return unit(s.normal);
  if (s.type === 'sphere') {
    const g = sub(p, s.center);
    return unit(g);
  }
  if (s.type === 'cylinder') {
    const a = unit(s.axis);
    const w = sub(p, s.point);
    return unit(sub(w, scale(a, dot(w, a))));
  }
  if (s.type === 'cone') {
    const eps = 1e-6;
    return unit([
      evalSurface(s, [p[0] + eps, p[1], p[2]]) - evalSurface(s, [p[0] - eps, p[1], p[2]]),
      evalSurface(s, [p[0], p[1] + eps, p[2]]) - evalSurface(s, [p[0], p[1] - eps, p[2]]),
      evalSurface(s, [p[0], p[1], p[2] + eps]) - evalSurface(s, [p[0], p[1], p[2] - eps]),
    ]);
  }
  if (s.type === 'generalQuadric') return unit(quadricGrad(s.coefficients, p));
  return [0, 0, 0];
}

function gnStep(x, residuals, grads, seed, pull) {
  const rows = residuals.map((r, i) => ({ r, g: grads[i] }));
  if (pull && seed) {
    const d = sub(x, seed);
    rows.push({ r: pull * d[0], g: [pull, 0, 0] });
    rows.push({ r: pull * d[1], g: [0, pull, 0] });
    rows.push({ r: pull * d[2], g: [0, 0, pull] });
  }
  const AtA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const Atb = [0, 0, 0];
  for (const { r, g } of rows) {
    if (!g || !g.every(Number.isFinite) || !Number.isFinite(r)) continue;
    for (let i = 0; i < 3; i++) {
      Atb[i] += g[i] * r;
      for (let j = 0; j < 3; j++) AtA[i][j] += g[i] * g[j];
    }
  }
  for (let i = 0; i < 3; i++) AtA[i][i] += 1e-8;
  const A = AtA.map((row, i) => [...row, Atb[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    if (Math.abs(A[i][i]) < 1e-12) return x;
    const piv = A[i][i];
    for (let c = i; c <= 3; c++) A[i][c] /= piv;
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = A[r][i];
      for (let c = i; c <= 3; c++) A[r][c] -= f * A[i][c];
    }
  }
  return sub(x, [A[0][3], A[1][3], A[2][3]]);
}

export function projectToCarriers(carriers, seed, { iters = 12, pull = 0.02 } = {}) {
  const usable = carriers.filter((c) => c && c.type !== 'unfitted-curved');
  if (!usable.length) return { point: seed, residuals: [], rms: Infinity, max: Infinity };
  let x = [...seed];
  for (let k = 0; k < iters; k++) {
    const rs = usable.map((c) => evalSurface(c, x));
    const gs = usable.map((c) => gradSurface(c, x));
    x = gnStep(x, rs, gs, seed, pull);
  }
  const residuals = usable.map((c) => evalSurface(c, x));
  const rms = Math.sqrt(residuals.reduce((s, v) => s + v * v, 0) / residuals.length);
  const max = Math.max(...residuals.map(Math.abs));
  return { point: x, residuals, rms, max };
}

export function meanPoint(pts) {
  const n = pts.length || 1;
  return [
    pts.reduce((s, p) => s + p[0], 0) / n,
    pts.reduce((s, p) => s + p[1], 0) / n,
    pts.reduce((s, p) => s + p[2], 0) / n,
  ];
}

export function aabbOf(pts, pad = 0) {
  if (!pts.length) return null;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], p[i]);
      hi[i] = Math.max(hi[i], p[i]);
    }
  }
  return { lo: lo.map((v) => v - pad), hi: hi.map((v) => v + pad) };
}

export function inAabb(p, box) {
  if (!box) return true;
  return p.every((v, i) => v >= box.lo[i] && v <= box.hi[i]);
}

export { add, sub, scale, dot, cross, norm, unit };
