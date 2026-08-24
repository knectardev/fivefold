/**
 * Consolidate partner-signature subpatches onto frozen analytic carriers.
 * Trim regions stay separate; only the underlying surface is shared.
 */
import { evalSurface } from './surface_eval.mjs';
import { sub, dot } from './plane_only.mjs';

const PLANE_ALIGN = 0.985;
const PARAM_RMS = 0.018;

function surfaceOf(patch, fit) {
  if (patch.kind === 'cube-exterior' || patch.kind === 'planar-mate') {
    return { type: 'plane', origin: patch.origin, normal: patch.normal, frozen: true };
  }
  if (!fit?.chosen) return { type: 'unfitted-curved', origin: patch.origin, normal: patch.normal };
  const c = fit.chosen;
  if (c.type === 'sphere') return { type: 'sphere', center: c.center, radius: c.radius, frozen: true };
  if (c.type === 'cylinder') return { type: 'cylinder', axis: c.axis, point: c.point, radius: c.radius, frozen: true };
  if (c.type === 'cone') return { type: 'cone', apex: c.apex, axis: c.axis, angle: c.angle, frozen: true };
  if (c.type === 'generalQuadric') return { type: 'generalQuadric', coefficients: c.coefficients, frozen: true };
  return { type: 'unfitted-curved', origin: patch.origin, normal: patch.normal };
}

function sampleRms(surface, points) {
  if (!points.length || surface.type === 'unfitted-curved') return Infinity;
  let s = 0;
  for (const p of points) {
    const v = evalSurface(surface, p);
    if (!Number.isFinite(v)) return Infinity;
    s += v * v;
  }
  return Math.sqrt(s / points.length);
}

function planesCompatible(a, b, tol) {
  if (a.type !== 'plane' || b.type !== 'plane') return false;
  if (dot(a.normal, b.normal) < PLANE_ALIGN) return false;
  return Math.abs(dot(a.normal, sub(b.origin, a.origin))) <= tol;
}

function curvedCompatible(a, b, ptsA, ptsB, tol) {
  if (a.type === 'unfitted-curved' || b.type === 'unfitted-curved') return false;
  if (a.type === 'plane' || b.type === 'plane') return false;
  if (a.type !== b.type) return false;
  return sampleRms(a, ptsB) <= tol && sampleRms(b, ptsA) <= tol;
}

function parent(uf, i) {
  while (uf[i] !== i) {
    uf[i] = uf[uf[i]];
    i = uf[i];
  }
  return i;
}

function union(uf, a, b) {
  const pa = parent(uf, a);
  const pb = parent(uf, b);
  if (pa !== pb) uf[pa] = pb;
}

export function consolidateCarriers(correspondence, fits, opts = {}) {
  const tol = opts.planeTol ?? PARAM_RMS;
  const fitById = new Map(fits.map((f) => [f.patch, f]));
  const patches = correspondence.patches;
  const surfaces = patches.map((p) => surfaceOf(p, fitById.get(p.id)));
  const samples = patches.map((p) => [...(p.samplesA || [])]);
  const byPiece = new Map();
  patches.forEach((p, i) => {
    if (!byPiece.has(p.piece)) byPiece.set(p.piece, []);
    byPiece.get(p.piece).push(i);
  });

  const keepSeparate = new Set(opts.keepSeparate || correspondence.keepSeparate || []);
  const uf = patches.map((_, i) => i);
  for (const idxs of byPiece.values()) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const i = idxs[a];
        const j = idxs[b];
        if (keepSeparate.has(patches[i].id) && keepSeparate.has(patches[j].id)) continue;
        const sa = surfaces[i];
        const sb = surfaces[j];
        if (planesCompatible(sa, sb, tol) || curvedCompatible(sa, sb, samples[i], samples[j], tol)) {
          union(uf, i, j);
        }
      }
    }
  }

  const groups = new Map();
  patches.forEach((_, i) => {
    const r = parent(uf, i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });

  const carriers = [];
  const regionOf = new Map();
  let n = 1;
  for (const members of groups.values()) {
    const root = members.reduce((best, i) => {
      const fit = fitById.get(patches[i].id);
      const rms = fit?.chosen?.rms ?? patches[i].planeRMS ?? Infinity;
      const bestFit = fitById.get(patches[best].id);
      const bestRms = bestFit?.chosen?.rms ?? patches[best].planeRMS ?? Infinity;
      return rms < bestRms ? i : best;
    }, members[0]);
    const id = `C${n++}`;
    const regions = members.map((i) => {
      const p = patches[i];
      regionOf.set(p.id, id);
      return {
        patch: p.id,
        cubeA: { mate: p.cubeA.mate, matePatch: p.cubeA.matePatch },
        cubeB: { mate: p.cubeB.mate, matePatch: p.cubeB.matePatch },
        kind: p.kind,
        areaFaces: p.areaFaces,
      };
    });
    carriers.push({
      id,
      piece: patches[root].piece,
      type: surfaces[root].type,
      frozen: surfaces[root].frozen !== false && surfaces[root].type !== 'unfitted-curved',
      surface: surfaces[root],
      regions,
      regionCount: regions.length,
    });
  }

  return {
    schema: 'dual-cube-carriers',
    version: 1,
    note: 'Partner-signature subpatches remain separate trim regions. Compatible geometry in the physical-piece frame shares one frozen carrier. Surface parameters are not released yet.',
    patchCount: patches.length,
    carrierCount: carriers.length,
    frozenCount: carriers.filter((c) => c.frozen).length,
    unfittedCount: carriers.filter((c) => c.surface.type === 'unfitted-curved').length,
    types: carriers.reduce((m, c) => {
      m[c.surface.type] = (m[c.surface.type] || 0) + 1;
      return m;
    }, {}),
    carriers: carriers.map((c) => ({
      id: c.id,
      piece: c.piece,
      type: c.type,
      frozen: c.frozen,
      regionCount: c.regionCount,
      regions: c.regions,
    })),
    regionToCarrier: Object.fromEntries(regionOf),
    _surfaces: carriers.map((c) => ({ id: c.id, piece: c.piece, surface: c.surface, regions: c.regions })),
    _regionToCarrier: regionOf,
  };
}
