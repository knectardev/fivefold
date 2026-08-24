/**
 * Packed trial ABI for global provisional-carrier optimization.
 * Sample residuals reuse the BFG1 fit-job layout so WebGPU can score
 * Cube A/B clouds in batches. Topology, branch IDs, and families stay on CPU.
 */
import { FAMILY, packSurfaceParams, packFitBatch } from './gpu_fit_protocol.mjs';
import { unit, dot, sub, scale } from './plane_only.mjs';

export const OPT_MARGIN = 0.02;
export const OPT_WEIGHTS = {
  A: 1,
  B: 1,
  junction: 0.45,
  trim: 0.2,
  intersection: 8,
  reg: 0.12,
};

export const FAMILY_DOF = {
  sphere: 4,
  cylinder: 7,
  cone: 7,
  generalQuadric: 10,
};

export function spherePlaneGap(center, radius, plane, margin = OPT_MARGIN) {
  const n = unit(plane.normal);
  const d = Math.abs(dot(sub(center, plane.origin), n));
  return Math.max(0, d - radius + margin);
}

export function projectSphereToPlane(vec, plane, margin = OPT_MARGIN) {
  const c = [vec[0], vec[1], vec[2]];
  const r = Math.abs(vec[3]);
  const n = unit(plane.normal);
  const signed = dot(sub(c, plane.origin), n);
  const dist = Math.abs(signed);
  if (dist <= r - margin) return [...c, r];
  const need = dist - (r - margin);
  const shift = 0.55 * need;
  const grow = need - shift;
  const c2 = sub(c, scale(n, Math.sign(signed || 1) * shift));
  return [...c2, r + grow];
}

export function vecFromChosen(chosen) {
  if (!chosen) return [];
  if (chosen.type === 'sphere') return [...chosen.center, chosen.radius];
  if (chosen.type === 'cylinder') return [...unit(chosen.axis), ...chosen.point, chosen.radius];
  if (chosen.type === 'cone') return [...chosen.apex, ...unit(chosen.axis), chosen.angle];
  if (chosen.type === 'generalQuadric') return [...(chosen.coefficients || [])].slice(0, 10);
  return [];
}

export function chosenFromVec(chosen, vec) {
  const p = vec;
  if (chosen.type === 'sphere') {
    return { ...chosen, center: [p[0], p[1], p[2]], radius: Math.abs(p[3]) || 1e-6 };
  }
  if (chosen.type === 'cylinder') {
    return {
      ...chosen,
      axis: unit([p[0], p[1], p[2]]),
      point: [p[3], p[4], p[5]],
      radius: Math.abs(p[6]) || 1e-6,
    };
  }
  if (chosen.type === 'cone') {
    return {
      ...chosen,
      apex: [p[0], p[1], p[2]],
      axis: unit([p[3], p[4], p[5]]),
      angle: p[6],
    };
  }
  return { ...chosen, coefficients: p.slice(0, 10) };
}

export function surfaceFromChosen(chosen) {
  if (!chosen) return null;
  if (chosen.type === 'sphere') {
    return { type: 'sphere', center: chosen.center, radius: chosen.radius };
  }
  if (chosen.type === 'cylinder') {
    return { type: 'cylinder', axis: chosen.axis, point: chosen.point, radius: chosen.radius };
  }
  if (chosen.type === 'cone') {
    return { type: 'cone', apex: chosen.apex, axis: chosen.axis, angle: chosen.angle };
  }
  if (chosen.type === 'generalQuadric') {
    return { type: 'generalQuadric', coefficients: chosen.coefficients };
  }
  return null;
}

export function packTrialJobs(trials) {
  const samples = [];
  const jobs = [];
  for (const trial of trials) {
    const aStart = samples.length;
    samples.push(...(trial.samplesA || []));
    const bStart = samples.length;
    samples.push(...(trial.samplesB || []));
    const loopStart = samples.length;
    samples.push(...(trial.loop || []));
    jobs.push({
      family: FAMILY[trial.family] ?? FAMILY.sphere,
      opening: trial.openingIndex ?? 0,
      initId: trial.initId ?? 0,
      aStart,
      aCount: trial.samplesA?.length || 0,
      bStart,
      bCount: trial.samplesB?.length || 0,
      loopStart,
      loopCount: trial.loop?.length || 0,
      params: packSurfaceParams(trial.surface),
      surface: trial.surface,
    });
  }
  return { samples, jobs, packed: packFitBatch({ samples, jobs }), trials };
}
