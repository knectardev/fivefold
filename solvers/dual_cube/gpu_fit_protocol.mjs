/**
 * Packed batched analytic-fit ABI for CPU and WebGPU.
 *
 * Header (32 bytes, little-endian):
 *   u32 magic 'BFG1' (0x31474642)
 *   u32 version
 *   u32 sampleCount
 *   u32 jobCount
 *   u32 flags
 *   u32 reserved0, reserved1, reserved2
 *
 * Samples: sampleCount × 16 bytes (f32 x,y,z, pad)
 *
 * Jobs: jobCount × 80 bytes
 *   u32 family, aStart, aCount, bStart, bCount, loopStart, loopCount, pad
 *   f32 params[12]
 *
 * Results: jobCount × 48 bytes
 *   f32 fitRms, fitMax, mateARms, mateAMax, mateBRms, mateBMax,
 *       boundaryRms, penalty, score
 *   u32 degeneracy, pad0, pad1
 *
 * Family: 0 sphere, 1 cylinder, 2 cone, 3 generalQuadric.
 * JS evaluateJobsCpu is the correctness oracle. WebGPU consumes this layout.
 */
export const FIT_MAGIC = 0x31474642;
export const FIT_VERSION = 1;
export const JOB_STRIDE = 80;
export const RESULT_STRIDE = 48;
export const SAMPLE_STRIDE = 16;
export const HEADER_BYTES = 32;

export const FAMILY = {
  sphere: 0,
  cylinder: 1,
  cone: 2,
  generalQuadric: 3,
};

export const FAMILY_NAME = ['sphere', 'cylinder', 'cone', 'generalQuadric'];
export const FAMILY_PARAMS = [4, 5, 6, 9];
export const COMPLEXITY = 0.12;

export const DEGEN = {
  nonfinite: 1,
  badRadius: 2,
  badAxis: 4,
  empty: 8,
};

export function packSurfaceParams(surface) {
  const p = new Float32Array(12);
  if (!surface) return p;
  if (surface.type === 'sphere') {
    p.set(surface.center, 0);
    p[3] = surface.radius;
  } else if (surface.type === 'cylinder') {
    p.set(surface.axis, 0);
    p.set(surface.point, 4);
    p[7] = surface.radius;
  } else if (surface.type === 'cone') {
    p.set(surface.apex, 0);
    p.set(surface.axis, 4);
    p[7] = surface.angle;
  } else if (surface.type === 'generalQuadric') {
    p.set(surface.coefficients.slice(0, 12), 0);
  }
  return p;
}

export function unpackSurface(family, params) {
  const p = params;
  if (family === FAMILY.sphere) {
    return { type: 'sphere', center: [p[0], p[1], p[2]], radius: p[3], params: 4 };
  }
  if (family === FAMILY.cylinder) {
    return {
      type: 'cylinder',
      axis: [p[0], p[1], p[2]],
      point: [p[4], p[5], p[6]],
      radius: p[7],
      params: 5,
    };
  }
  if (family === FAMILY.cone) {
    return {
      type: 'cone',
      apex: [p[0], p[1], p[2]],
      axis: [p[4], p[5], p[6]],
      angle: p[7],
      params: 6,
    };
  }
  return {
    type: 'generalQuadric',
    coefficients: [p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9]],
    params: 9,
  };
}

export function packFitBatch({ samples, jobs }) {
  const sampleCount = samples.length;
  const jobCount = jobs.length;
  const bytes = HEADER_BYTES + sampleCount * SAMPLE_STRIDE + jobCount * JOB_STRIDE;
  const buf = new ArrayBuffer(bytes);
  const view = new DataView(buf);
  view.setUint32(0, FIT_MAGIC, true);
  view.setUint32(4, FIT_VERSION, true);
  view.setUint32(8, sampleCount, true);
  view.setUint32(12, jobCount, true);
  view.setUint32(16, 0, true);
  let o = HEADER_BYTES;
  for (const s of samples) {
    view.setFloat32(o, s[0], true);
    view.setFloat32(o + 4, s[1], true);
    view.setFloat32(o + 8, s[2], true);
    view.setFloat32(o + 12, 0, true);
    o += SAMPLE_STRIDE;
  }
  for (const job of jobs) {
    view.setUint32(o, job.family, true);
    view.setUint32(o + 4, job.aStart, true);
    view.setUint32(o + 8, job.aCount, true);
    view.setUint32(o + 12, job.bStart, true);
    view.setUint32(o + 16, job.bCount, true);
    view.setUint32(o + 20, job.loopStart, true);
    view.setUint32(o + 24, job.loopCount, true);
    view.setUint32(o + 28, job.opening ?? 0, true);
    const params = job.params instanceof Float32Array ? job.params : packSurfaceParams(job.surface);
    for (let i = 0; i < 12; i++) view.setFloat32(o + 32 + i * 4, params[i] ?? 0, true);
    o += JOB_STRIDE;
  }
  return buf;
}

export function unpackFitBatch(buf) {
  const view = new DataView(buf);
  const magic = view.getUint32(0, true);
  if (magic !== FIT_MAGIC) throw new Error('bad fit-batch magic');
  const version = view.getUint32(4, true);
  if (version !== FIT_VERSION) throw new Error(`unsupported fit-batch version ${version}`);
  const sampleCount = view.getUint32(8, true);
  const jobCount = view.getUint32(12, true);
  const samples = [];
  let o = HEADER_BYTES;
  for (let i = 0; i < sampleCount; i++) {
    samples.push([
      view.getFloat32(o, true),
      view.getFloat32(o + 4, true),
      view.getFloat32(o + 8, true),
    ]);
    o += SAMPLE_STRIDE;
  }
  const jobs = [];
  for (let i = 0; i < jobCount; i++) {
    const params = new Float32Array(12);
    for (let k = 0; k < 12; k++) params[k] = view.getFloat32(o + 32 + k * 4, true);
    jobs.push({
      family: view.getUint32(o, true),
      aStart: view.getUint32(o + 4, true),
      aCount: view.getUint32(o + 8, true),
      bStart: view.getUint32(o + 12, true),
      bCount: view.getUint32(o + 16, true),
      loopStart: view.getUint32(o + 20, true),
      loopCount: view.getUint32(o + 24, true),
      opening: view.getUint32(o + 28, true),
      params,
    });
    o += JOB_STRIDE;
  }
  return { samples, jobs, sampleCount, jobCount };
}

export function packFitResults(results) {
  const buf = new ArrayBuffer(results.length * RESULT_STRIDE);
  const view = new DataView(buf);
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const o = i * RESULT_STRIDE;
    view.setFloat32(o, r.fitRms, true);
    view.setFloat32(o + 4, r.fitMax, true);
    view.setFloat32(o + 8, r.mateARms, true);
    view.setFloat32(o + 12, r.mateAMax, true);
    view.setFloat32(o + 16, r.mateBRms, true);
    view.setFloat32(o + 20, r.mateBMax, true);
    view.setFloat32(o + 24, r.boundaryRms, true);
    view.setFloat32(o + 28, r.penalty, true);
    view.setFloat32(o + 32, r.score, true);
    view.setUint32(o + 36, r.degeneracy >>> 0, true);
  }
  return buf;
}

export function unpackFitResults(buf) {
  const view = new DataView(buf);
  const n = buf.byteLength / RESULT_STRIDE;
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = i * RESULT_STRIDE;
    out.push({
      fitRms: view.getFloat32(o, true),
      fitMax: view.getFloat32(o + 4, true),
      mateARms: view.getFloat32(o + 8, true),
      mateAMax: view.getFloat32(o + 12, true),
      mateBRms: view.getFloat32(o + 16, true),
      mateBMax: view.getFloat32(o + 20, true),
      boundaryRms: view.getFloat32(o + 24, true),
      penalty: view.getFloat32(o + 28, true),
      score: view.getFloat32(o + 32, true),
      degeneracy: view.getUint32(o + 36, true),
    });
  }
  return out;
}

export function resultsClose(a, b, abs = 2e-4, rel = 2e-3) {
  const keys = ['fitRms', 'fitMax', 'mateARms', 'mateAMax', 'mateBRms', 'mateBMax', 'boundaryRms', 'penalty', 'score'];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if ((a[i].degeneracy >>> 0) !== (b[i].degeneracy >>> 0)) return false;
    for (const k of keys) {
      const x = a[i][k];
      const y = b[i][k];
      if (!Number.isFinite(x) && !Number.isFinite(y)) continue;
      const tol = abs + rel * Math.max(Math.abs(x), Math.abs(y));
      if (Math.abs(x - y) > tol) return false;
    }
  }
  return true;
}
