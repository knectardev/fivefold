/**
 * Cube A/B mate correspondence audit and frozen-carrier junction feasibility.
 * Residuals are reported; incompatible junctions are not snapped.
 */
import {
  parseCandidate,
  transformVoxel,
  transformDirection,
  inverseTransformVoxel,
  transformDoubledFace,
  doubledFaceCenter,
  doubledEquals,
  transformGeometricPoint,
  inverseGeometricPoint,
  rotTranspose,
  ROT,
  applyRot,
} from './json_contract.mjs';
import { sub, add, scale, norm } from './plane_only.mjs';
import { projectToCarriers } from './surface_eval.mjs';

function inBounds(v, N) {
  return v[0] >= 0 && v[1] >= 0 && v[2] >= 0 && v[0] < N && v[1] < N && v[2] < N;
}

function faceCenterIndex(v, d) {
  return [v[0] + 0.5 + 0.5 * d[0], v[1] + 0.5 + 0.5 * d[1], v[2] + 0.5 + 0.5 * d[2]];
}

function toUnit(p, N) {
  return p.map((x) => x / N);
}

function toIndex(p, N) {
  return p.map((x) => x * N);
}

export function mapIndexThroughB(pIndex, plFrom, plTo, N) {
  const b = transformGeometricPoint(pIndex, plFrom, N);
  return { b, aMate: inverseGeometricPoint(b, plTo, N) };
}

function inverseDirection(d, pl) {
  return applyRot(d, rotTranspose(ROT[pl.r])).map((x) => Math.round(x));
}

function rms(vals) {
  if (!vals.length) return 0;
  return Math.sqrt(vals.reduce((s, v) => s + v * v, 0) / vals.length);
}

export function auditCubeBMates(raw, correspondence) {
  const cand = parseCandidate(raw);
  const N = cand.gridResolution;
  const patches = correspondence.patches;
  const patchById = new Map(patches.map((p) => [p.id, p]));
  const pairs = [];

  for (const p of patches) {
    const mateId = p.cubeB.matePatch;
    if (typeof mateId !== 'string' || p.id >= mateId) continue;
    const q = patchById.get(mateId);
    if (!q) continue;
    const plP = cand.placements[p.piece - 1];
    const plQ = cand.placements[q.piece - 1];
    const samples = [];
    let orientAgree = 0;
    let orientN = 0;
    for (const f of p.faces || []) {
      const vB = transformVoxel(f.v, plP, N);
      const dB = transformDirection(f.d, plP);
      const wB = [vB[0] + dB[0], vB[1] + dB[1], vB[2] + dB[2]];
      const cP = faceCenterIndex(f.v, f.d);
      if (!inBounds(wB, N)) {
        samples.push({
          voxelGap: Infinity,
          geometricGap: Infinity,
          branch: 'transformed-face-leaves-B',
          endpointIdentity: false,
        });
        continue;
      }
      const dOpp = [-dB[0], -dB[1], -dB[2]];
      const vQ = inverseTransformVoxel(wB, plQ, N);
      const dQ = inverseDirection(dOpp, plQ);
      const wFromQ = transformVoxel(vQ, plQ, N);
      const dQb = transformDirection(dQ, plQ);
      const voxelGap = norm(sub(wB, wFromQ));
      const fP = transformDoubledFace(doubledFaceCenter(f.v, f.d), plP, N);
      const fQ = transformDoubledFace(doubledFaceCenter(vQ, dQ), plQ, N);
      const discreteEqual = doubledEquals(fP, fQ);
      const normalsOpposite = dB[0] === -dQb[0] && dB[1] === -dQb[1] && dB[2] === -dQb[2];
      const cQ = faceCenterIndex(vQ, dQ);
      const yP = transformGeometricPoint(cP, plP, N);
      const yQ = transformGeometricPoint(cQ, plQ, N);
      const geometricGap = norm(sub(yP, yQ)) / N;
      orientN++;
      if (normalsOpposite) orientAgree++;
      samples.push({
        voxelGap,
        discreteEqual,
        normalsOpposite,
        doubledGap: discreteEqual ? 0 : 1,
        geometricGap,
        orientationDot: normalsOpposite ? 1 : 0,
        branch: 'doubled-lattice-face-center',
        endpointIdentity: discreteEqual && normalsOpposite,
        seedA: toUnit(cP, N),
        seedB: toUnit(yP, N),
        mateA: toUnit(cQ, N),
        mateB: toUnit(yQ, N),
        f2B: fP,
        f2Mate: fQ,
      });
    }
    const gaps = samples.map((s) => s.voxelGap).filter(Number.isFinite);
    const geom = samples.map((s) => s.geometricGap).filter(Number.isFinite);
    const discreteFails = samples.filter((s) => s.discreteEqual === false || s.normalsOpposite === false).length;
    pairs.push({
      patch: p.id,
      matePatch: q.id,
      piece: p.piece,
      matePiece: q.piece,
      cubeA: { mate: p.cubeA.mate, matePatch: p.cubeA.matePatch },
      cubeB: { mate: p.cubeB.mate, matePatch: p.cubeB.matePatch },
      transformP: { r: plP.r, t: [...plP.t] },
      transformQ: { r: plQ.r, t: [...plQ.t] },
      orientationReversal: orientN ? orientAgree / orientN : 0,
      discreteFails,
      voxelRms: rms(gaps),
      voxelMax: gaps.length ? Math.max(...gaps) : Infinity,
      geometricRms: rms(geom),
      geometricMax: geom.length ? Math.max(...geom) : Infinity,
      sampleCount: samples.length,
      samples: samples.slice(0, 4),
    });
  }

  pairs.sort((a, b) => (b.discreteFails - a.discreteFails) || (b.geometricMax - a.geometricMax));
  const checked = pairs.reduce((s, p) => s + p.sampleCount, 0);
  const discreteFails = pairs.reduce((s, p) => s + p.discreteFails, 0);
  return {
    schema: 'dual-cube-mate-audit',
    version: 2,
    note: 'Discrete mate identity is exact doubled-lattice equality f2B(i)=f2B(j) and dB(i)=-dB(j). Continuous geometricGap uses rotation about N/2.',
    pairCount: pairs.length,
    discrete: { checked, mismatches: discreteFails, exact: discreteFails === 0 },
    voxelRms: rms(pairs.map((p) => p.voxelRms).filter(Number.isFinite)),
    voxelMax: pairs.reduce((m, p) => Math.max(m, Number.isFinite(p.voxelMax) ? p.voxelMax : 0), 0),
    geometricRms: rms(pairs.map((p) => p.geometricRms).filter(Number.isFinite)),
    geometricMax: pairs.reduce((m, p) => Math.max(m, Number.isFinite(p.geometricMax) ? p.geometricMax : 0), 0),
    worst10: pairs.slice(0, 10).map((p) => ({
      patch: p.patch,
      matePatch: p.matePatch,
      piece: p.piece,
      matePiece: p.matePiece,
      cubeA: p.cubeA,
      cubeB: p.cubeB,
      transformP: p.transformP,
      transformQ: p.transformQ,
      orientationReversal: p.orientationReversal,
      discreteFails: p.discreteFails,
      voxelRms: p.voxelRms,
      voxelMax: p.voxelMax,
      geometricRms: p.geometricRms,
      geometricMax: p.geometricMax,
      branch: p.samples[0]?.branch || null,
      endpointIdentity: p.samples.every((s) => s.endpointIdentity),
      sample: p.samples[0] || null,
    })),
  };
}

export function solveFrozenMateFeasibility(raw, correspondence, surfOf) {
  const cand = parseCandidate(raw);
  const N = cand.gridResolution;
  const patches = correspondence.patches;
  const patchById = new Map(patches.map((p) => [p.id, p]));
  const records = [];

  for (const p of patches) {
    const mateId = p.cubeB.matePatch;
    if (typeof mateId !== 'string' || p.id >= mateId) continue;
    const q = patchById.get(mateId);
    if (!q) continue;
    const sP = surfOf(p);
    const sQ = surfOf(q);
    if (!sP || !sQ || sP.type === 'unfitted-curved' || sQ.type === 'unfitted-curved') continue;
    const plP = cand.placements[p.piece - 1];
    const plQ = cand.placements[q.piece - 1];
    const faces = p.faces || [];
    if (!faces.length) continue;
    const f = faces[Math.floor(faces.length / 2)];
    const cP = faceCenterIndex(f.v, f.d);
    const y0 = toUnit(transformGeometricPoint(cP, plP, N), N);
    const vB = transformVoxel(f.v, plP, N);
    const dB = transformDirection(f.d, plP);
    const wB = [vB[0] + dB[0], vB[1] + dB[1], vB[2] + dB[2]];
    if (!inBounds(wB, N)) continue;
    const dOpp = [-dB[0], -dB[1], -dB[2]];
    const vQ = inverseTransformVoxel(wB, plQ, N);
    const dQ = inverseDirection(dOpp, plQ);
    const cQ = faceCenterIndex(vQ, dQ);

    const xP0 = toUnit(cP, N);
    const xQ0 = toUnit(cQ, N);
    const indP = projectToCarriers([sP], xP0, { pull: 0.02 });
    const indQ = projectToCarriers([sQ], xQ0, { pull: 0.02 });
    const yP0 = toUnit(transformGeometricPoint(toIndex(indP.point, N), plP, N), N);
    const yQ0 = toUnit(transformGeometricPoint(toIndex(indQ.point, N), plQ, N), N);
    const initialB = norm(sub(yP0, yQ0));

    let y = [...y0];
    let finalP = indP;
    let finalQ = indQ;
    let finalB = initialB;
    for (let it = 0; it < 8; it++) {
      const xP = toUnit(inverseGeometricPoint(toIndex(y, N), plP, N), N);
      const xQ = toUnit(inverseGeometricPoint(toIndex(y, N), plQ, N), N);
      finalP = projectToCarriers([sP], xP, { pull: 0.05 });
      finalQ = projectToCarriers([sQ], xQ, { pull: 0.05 });
      const yP = toUnit(transformGeometricPoint(toIndex(finalP.point, N), plP, N), N);
      const yQ = toUnit(transformGeometricPoint(toIndex(finalQ.point, N), plQ, N), N);
      finalB = norm(sub(yP, yQ));
      y = scale(add(yP, yQ), 0.5);
    }
    const surfMax = Math.max(finalP.max || 0, finalQ.max || 0);
    const incompatible = surfMax > 0.05 && finalB > 0.03;
    records.push({
      patch: p.id,
      matePatch: q.id,
      piece: p.piece,
      matePiece: q.piece,
      carrierP: sP.type,
      carrierQ: sQ.type,
      initialB,
      finalB,
      surfaceRmsP: finalP.rms,
      surfaceRmsQ: finalQ.rms,
      surfaceMax: surfMax,
      incompatible,
      snapped: false,
    });
  }

  const finals = records.map((r) => r.finalB);
  const initials = records.map((r) => r.initialB);
  return {
    schema: 'dual-cube-frozen-solve',
    version: 1,
    note: 'One Cube-B variable per mated sample, transformed about N/2. Carriers stay frozen. Incompatible pairs are reported, not snapped.',
    pairCount: records.length,
    initialRms: rms(initials),
    initialMax: initials.length ? Math.max(...initials) : 0,
    finalRms: rms(finals),
    finalMax: finals.length ? Math.max(...finals) : 0,
    incompatibleCount: records.filter((r) => r.incompatible).length,
    perCarrier: summarizeCarrier(records),
    worst: [...records].sort((a, b) => b.finalB - a.finalB).slice(0, 10),
  };
}

function summarizeCarrier(records) {
  const m = new Map();
  for (const r of records) {
    for (const t of [r.carrierP, r.carrierQ]) {
      if (!m.has(t)) m.set(t, []);
      m.get(t).push(r.finalB);
    }
  }
  const out = {};
  for (const [t, vals] of m) out[t] = { rms: rms(vals), max: Math.max(...vals), n: vals.length };
  return out;
}

export function aMateResiduals(patches, surfOf, N) {
  const patchById = new Map(patches.map((p) => [p.id, p]));
  const vals = [];
  const pairs = [];
  for (const p of patches) {
    const mateId = p.cubeA.matePatch;
    if (typeof mateId !== 'string' || p.id >= mateId) continue;
    const q = patchById.get(mateId);
    if (!q) continue;
    const sP = [surfOf(p)].filter((s) => s && s.type !== 'unfitted-curved');
    const sQ = [surfOf(q)].filter((s) => s && s.type !== 'unfitted-curved');
    if (!sP.length || !sQ.length) continue;
    const cornersP = new Set();
    for (const f of p.faces || []) for (const c of f.corners || []) cornersP.add(c.join(','));
    const shared = [];
    for (const f of q.faces || []) {
      for (const c of f.corners || []) if (cornersP.has(c.join(','))) shared.push(c);
    }
    for (const vertex of shared.slice(0, 6)) {
      const seed = toUnit(vertex, N);
      const sp = projectToCarriers(sP, seed, { pull: 0.02 });
      const sq = projectToCarriers(sQ, seed, { pull: 0.02 });
      const gap = norm(sub(sp.point, sq.point));
      vals.push(gap);
      pairs.push({
        patch: p.id,
        matePatch: q.id,
        piece: p.piece,
        matePiece: q.piece,
        initial: gap,
        final: gap,
        surfaceMax: Math.max(sp.max || 0, sq.max || 0),
      });
    }
  }
  return {
    rms: rms(vals),
    max: vals.length ? Math.max(...vals) : 0,
    count: vals.length,
    worst: [...pairs].sort((a, b) => b.final - a.final).slice(0, 8),
  };
}

export { rms };
