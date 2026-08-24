/**
 * CPU batched opening fitter. Same packed jobs the WebGPU kernel consumes.
 * Algebraic family fits stay on the CPU; residual scoring is SoA over all
 * openings × families × initializations × Cube A/B/boundary samples.
 */
import { fitPlane, sub, add, scale, dot, unit, cross } from './plane_only.mjs';
import { evalSurface } from './surface_eval.mjs';
import {
  fitSphere,
  fitCylinder,
  fitCone,
  fitGeneralQuadric,
} from './joint_quadrics.mjs';
import {
  FAMILY,
  FAMILY_NAME,
  FAMILY_PARAMS,
  COMPLEXITY,
  DEGEN,
  packSurfaceParams,
  unpackSurface,
  packFitBatch,
  unpackFitBatch,
} from './gpu_fit_protocol.mjs';

const FITTERS = [fitSphere, fitCylinder, fitCone, fitGeneralQuadric];

function residualStats(surface, points) {
  if (!points.length) {
    return { rms: 0, max: 0, count: 0 };
  }
  let sum = 0;
  let max = 0;
  let degen = 0;
  for (const p of points) {
    const v = evalSurface(surface, p);
    if (!Number.isFinite(v)) {
      degen |= DEGEN.nonfinite;
      continue;
    }
    const a = Math.abs(v);
    sum += a * a;
    if (a > max) max = a;
  }
  return { rms: Math.sqrt(sum / points.length), max, count: points.length, degen };
}

function degeneracyOf(family, surface) {
  let flags = 0;
  if (!surface) return DEGEN.empty;
  if (family === FAMILY.sphere || family === FAMILY.cylinder) {
    if (!(surface.radius > 1e-8) || !Number.isFinite(surface.radius)) flags |= DEGEN.badRadius;
  }
  if (family === FAMILY.cylinder || family === FAMILY.cone) {
    const a = surface.axis;
    const n = Math.hypot(a[0], a[1], a[2]);
    if (n < 1e-8) flags |= DEGEN.badAxis;
  }
  if (family === FAMILY.cone && !Number.isFinite(surface.angle)) flags |= DEGEN.nonfinite;
  return flags;
}

export function evaluateJobsCpu(batchOrBuf) {
  const batch = batchOrBuf instanceof ArrayBuffer ? unpackFitBatch(batchOrBuf) : batchOrBuf;
  const { samples, jobs } = batch;
  const slice = (start, count) => samples.slice(start, start + count);
  return jobs.map((job) => {
    const surface = unpackSurface(job.family, job.params);
    let degeneracy = degeneracyOf(job.family, surface);
    const a = residualStats(surface, slice(job.aStart, job.aCount));
    const b = residualStats(surface, slice(job.bStart, job.bCount));
    const loop = residualStats(surface, slice(job.loopStart, job.loopCount));
    degeneracy |= a.degen || 0;
    degeneracy |= b.degen || 0;
    degeneracy |= loop.degen || 0;
    if (!job.aCount) degeneracy |= DEGEN.empty;
    const penalty = COMPLEXITY * Math.max(0, FAMILY_PARAMS[job.family] - 4);
    const fitRms = a.rms;
    const score = degeneracy
      ? Infinity
      : fitRms * (1 + penalty) + 0.35 * (a.rms + b.rms) + 0.15 * loop.rms;
    return {
      fitRms,
      fitMax: a.max,
      mateARms: a.rms,
      mateAMax: a.max,
      mateBRms: b.rms,
      mateBMax: b.max,
      boundaryRms: loop.rms,
      penalty,
      score,
      degeneracy,
    };
  });
}

export function boundaryLoopSamples(patch, N) {
  if (!patch.faces?.length || !N) return [...(patch.samplesA || [])];
  const edgeCount = new Map();
  for (const f of patch.faces) {
    for (const e of f.edges) edgeCount.set(e, (edgeCount.get(e) || 0) + 1);
  }
  const pts = [];
  for (const f of patch.faces) {
    const order = [0, 1, 3, 2];
    for (let i = 0; i < 4; i++) {
      if ((edgeCount.get(f.edges[i]) || 0) !== 1) continue;
      const c0 = f.corners[order[i]];
      const c1 = f.corners[order[(i + 1) % 4]];
      if (!c0 || !c1) continue;
      pts.push([
        (c0[0] + c1[0]) / (2 * N),
        (c0[1] + c1[1]) / (2 * N),
        (c0[2] + c1[2]) / (2 * N),
      ]);
    }
  }
  return pts.length ? pts : [...(patch.samplesA || [])];
}

function candidateSurfaces(points) {
  const out = [];
  for (let family = 0; family < FITTERS.length; family++) {
    const fit = FITTERS[family](points);
    if (fit) out.push({ family, surface: fit });
  }
  return out;
}

function fitCylinderAlongAxis(points, axis) {
  if (points.length < 6) return null;
  const a = unit(axis);
  const ref = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(a, ref));
  const v = unit(cross(a, u));
  const rows = points.map((p) => [2 * dot(p, u), 2 * dot(p, v), 1]);
  const rhs = points.map((p) => {
    const x = dot(p, u);
    const y = dot(p, v);
    return x * x + y * y;
  });
  const n = 3;
  const AtA = Array.from({ length: n }, () => Array(n).fill(0));
  const Atb = Array(n).fill(0);
  for (let i = 0; i < rows.length; i++) {
    for (let c = 0; c < n; c++) {
      Atb[c] += rows[i][c] * rhs[i];
      for (let d = 0; d < n; d++) AtA[c][d] += rows[i][c] * rows[i][d];
    }
  }
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
  const cx = A[0][3];
  const cy = A[1][3];
  const r2 = A[2][3] + cx * cx + cy * cy;
  if (r2 <= 1e-10) return null;
  const radius = Math.sqrt(r2);
  const center = add(scale(u, cx), scale(v, cy));
  return { type: 'cylinder', axis: a, point: center, radius, params: 5 };
}

function extraAxisCylinders(points) {
  if (points.length < 6) return [];
  const out = [];
  for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    const surface = fitCylinderAlongAxis(points, axis);
    if (surface) out.push({ family: FAMILY.cylinder, surface });
  }
  return out;
}

const INIT_NAME = {
  0: 'samplesA',
  1: 'samplesB',
  2: 'jointAB',
  3: 'mateA',
  4: 'mateB',
  5: 'boundaryLoop',
  6: 'samplesAB',
  7: 'bothAssemblies',
};

function openingClouds(patch, all, N, extraInits) {
  const mateA = typeof patch.cubeA?.matePatch === 'string'
    ? all.find((p) => p.id === patch.cubeA.matePatch)
    : null;
  const mateB = typeof patch.cubeB?.matePatch === 'string'
    ? all.find((p) => p.id === patch.cubeB.matePatch)
    : null;
  const samplesA = patch.samplesA || [];
  const samplesB = patch.samplesJoint || [];
  const mateApts = mateA?.samplesA || [];
  const mateBpts = mateB?.samplesA || [];
  const loop = boundaryLoopSamples(patch, N);
  const clouds = [
    { id: 0, pts: samplesA },
    { id: 1, pts: samplesB },
    { id: 2, pts: [...samplesA, ...samplesB, ...mateApts] },
  ];
  if (extraInits) {
    clouds.push(
      { id: 3, pts: mateApts },
      { id: 4, pts: mateBpts },
      { id: 5, pts: loop },
      { id: 6, pts: [...samplesA, ...samplesB] },
      { id: 7, pts: [...samplesA, ...samplesB, ...mateApts, ...mateBpts] },
    );
  }
  return { samplesA, samplesB, mateApts, mateBpts, loop, clouds, mateA, mateB };
}

export function buildOpeningBatch(correspondence, opts = {}) {
  const N = correspondence.gridResolution;
  const all = correspondence.patches;
  const extraInits = opts.extraInits === true;
  const idSet = opts.patchIds ? new Set(opts.patchIds) : null;
  const openings = all.filter((p) => {
    if (p.kind !== 'curved') return false;
    if (idSet && !idSet.has(p.id)) return false;
    return true;
  });
  const samples = [];
  const jobs = [];
  const meta = [];
  for (let oi = 0; oi < openings.length; oi++) {
    const patch = openings[oi];
    const { samplesA, samplesB, mateApts, loop, clouds } = openingClouds(patch, all, N, extraInits);
    const aStart = samples.length;
    samples.push(...samplesA);
    const bStart = samples.length;
    samples.push(...samplesB);
    const loopStart = samples.length;
    samples.push(...loop);
    const plane = samplesA.length >= 3 ? fitPlane(samplesA) : { rms: Infinity };
    meta.push({
      opening: oi,
      patch: patch.id,
      piece: patch.piece,
      cubeA: patch.cubeA,
      cubeB: patch.cubeB,
      planeRMS: plane.rms,
      sampleCount: samplesA.length + samplesB.length + mateApts.length,
    });
    for (const cloud of clouds) {
      if (cloud.pts.length < 4) continue;
      const cands = [
        ...candidateSurfaces(cloud.pts),
        ...(extraInits ? extraAxisCylinders(cloud.pts) : []),
      ];
      for (const cand of cands) {
        jobs.push({
          opening: oi,
          family: cand.family,
          initId: cloud.id,
          aStart,
          aCount: samplesA.length,
          bStart,
          bCount: samplesB.length,
          loopStart,
          loopCount: loop.length,
          params: packSurfaceParams(cand.surface),
          surface: cand.surface,
        });
      }
    }
  }
  return { samples, jobs, meta, openings, opts, initNames: INIT_NAME };
}

export function acceptJob(result, planeRms, planeTol = 0.018) {
  if (result.degeneracy) return false;
  if (!Number.isFinite(result.fitRms) || !Number.isFinite(result.score)) return false;
  const cap = Math.max(planeTol * 1.75, planeRms * 0.85);
  if (result.fitRms > cap) return false;
  if (result.mateBRms > cap * 1.5) return false;
  return result.fitRms + 1e-9 < planeRms * 0.85 || result.fitRms <= planeTol * 1.75;
}

export function selectOpeningFits(batch, results, planeTol = 0.018) {
  const byOpening = new Map();
  for (let i = 0; i < batch.jobs.length; i++) {
    const job = batch.jobs[i];
    const result = results[i];
    const meta = batch.meta[job.opening];
    if (!acceptJob(result, meta.planeRMS, planeTol)) continue;
    const prev = byOpening.get(job.opening);
    if (!prev || result.score < prev.result.score) {
      byOpening.set(job.opening, { job, result, meta });
    }
  }
  return byOpening;
}

export function selectBestJobs(batch, results) {
  const byOpening = new Map();
  for (let i = 0; i < batch.jobs.length; i++) {
    const job = batch.jobs[i];
    const result = results[i];
    if (result.degeneracy || !Number.isFinite(result.score)) continue;
    const prev = byOpening.get(job.opening);
    if (!prev || result.score < prev.result.score) {
      byOpening.set(job.opening, { job, result, meta: batch.meta[job.opening] });
    }
  }
  return byOpening;
}

function chosenFrom(job, result) {
  const surface = job.surface || unpackSurface(job.family, job.params);
  return {
    type: FAMILY_NAME[job.family],
    rms: result.fitRms,
    params: FAMILY_PARAMS[job.family],
    score: result.score,
    center: surface.center,
    radius: surface.radius,
    axis: surface.axis,
    point: surface.point,
    apex: surface.apex,
    angle: surface.angle,
    coefficients: surface.coefficients,
    mateARms: result.mateARms,
    mateAMax: result.mateAMax,
    mateBRms: result.mateBRms,
    mateBMax: result.mateBMax,
    boundaryRms: result.boundaryRms,
    degeneracy: result.degeneracy,
  };
}

export function fitOpeningsBatched(correspondence, opts = {}) {
  const planeTol = opts.planeTol ?? 0.018;
  const batch = buildOpeningBatch(correspondence, opts);
  const packed = packFitBatch(batch);
  const evaluate = opts.evaluateJobs || evaluateJobsCpu;
  const results = evaluate(packed);
  const selected = selectOpeningFits(batch, results, planeTol);
  const fits = batch.meta.map((meta) => {
    const hit = selected.get(meta.opening);
    const tried = batch.jobs
      .map((job, i) => ({ job, result: results[i] }))
      .filter((x) => x.job.opening === meta.opening)
      .map((x) => ({
        type: FAMILY_NAME[x.job.family],
        rms: x.result.fitRms,
        params: FAMILY_PARAMS[x.job.family],
        score: x.result.score,
        mateBRms: x.result.mateBRms,
        initId: x.job.initId,
        init: INIT_NAME[x.job.initId] || `init${x.job.initId}`,
      }))
      .sort((a, b) => a.score - b.score);
    return {
      patch: meta.patch,
      piece: meta.piece,
      cubeA: meta.cubeA,
      cubeB: meta.cubeB,
      sampleCount: meta.sampleCount,
      planeRMS: meta.planeRMS,
      chosen: hit ? chosenFrom(hit.job, hit.result) : null,
      tried,
      engine: 'batched',
    };
  });
  return {
    fits,
    batch,
    results,
    packed,
    jobCount: batch.jobs.length,
    openingCount: batch.openings.length,
    selectedCount: selected.size,
  };
}

export function unresolvedPatchIds(priorFits) {
  return priorFits.filter((f) => !f.chosen).map((f) => f.patch);
}

export function proposeUnresolvedFits(correspondence, opts = {}) {
  const planeTol = opts.planeTol ?? 0.018;
  const prior = opts.priorFits || fitOpeningsBatched(correspondence, { extraInits: false }).fits;
  const patchIds = opts.patchIds || unresolvedPatchIds(prior);
  const run = fitOpeningsBatched(correspondence, {
    ...opts,
    patchIds,
    extraInits: opts.extraInits !== false,
  });
  const gated = selectOpeningFits(run.batch, run.results, planeTol);
  const best = selectBestJobs(run.batch, run.results);
  const fits = run.fits.map((f, oi) => {
    const hit = gated.get(oi) || best.get(oi);
    const chosen = hit ? chosenFrom(hit.job, hit.result) : null;
    const fitGate = !!gated.get(oi);
    return { ...f, chosen, fitGate };
  });
  const proposals = fits.map((f) => {
    const families = [...new Set(f.tried.map((t) => t.type))];
    const inits = [...new Set(f.tried.map((t) => t.init))];
    const cap = Math.max(planeTol * 1.75, f.planeRMS * 0.85);
    let rejectReason = null;
    if (!f.chosen) rejectReason = 'no-finite-job';
    else if (!f.fitGate && f.chosen.mateBRms > cap * 1.5) rejectReason = 'mateB-residual';
    else if (!f.fitGate) rejectReason = 'fit-gate';
    return {
      patch: f.patch,
      piece: f.piece,
      planeRMS: f.planeRMS,
      proposed: !!f.chosen,
      fitGate: f.fitGate,
      rejectReason,
      chosen: f.chosen,
      familiesScored: families,
      initsScored: inits,
      jobCount: f.tried.length,
      tried: f.tried.slice(0, 12),
    };
  });
  return {
    schema: 'dual-cube-opening-proposals',
    version: 1,
    note: 'Second batched pass over unresolved openings. Every opening gets its best-scoring carrier as a proposal. Topology is unchanged until a later transactional CPU insert.',
    openingCount: run.openingCount,
    jobCount: run.jobCount,
    proposedCount: proposals.filter((p) => p.proposed).length,
    fitGateCount: proposals.filter((p) => p.fitGate).length,
    patchIds,
    proposals,
    fits,
    packed: run.packed,
    results: run.results,
    batch: run.batch,
  };
}
