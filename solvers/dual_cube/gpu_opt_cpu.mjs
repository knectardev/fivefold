/**
 * CPU-owned global optimization of provisional carriers.
 * GPU/CPU batched jobs score Cube A/B sample residuals. Junction, trim,
 * intersection, and regularization terms, plus trust-region acceptance and
 * topology checkpoints, stay on the CPU. Surface families and trim topology
 * are frozen in this pass.
 */
import { evalSurface } from './surface_eval.mjs';
import { boundaryLoopSamples, evaluateJobsCpu } from './gpu_fit_cpu.mjs';
import {
  topologyMetrics,
  attributeOpenEdges,
  planeSphereCircle,
  planeCylinderConic,
  enumerateIntersectionBranches,
  adjacencyKey,
  buildClosureReport,
} from './analytic_junctions.mjs';
import { searchTrimBranches, carrierStatuses, diagnosePatch } from './trim_branches.mjs';
import { fitSphere, fitCylinder, fitCone, fitGeneralQuadric } from './joint_quadrics.mjs';
import { sub, scale, dot, norm, unit } from './plane_only.mjs';
import {
  OPT_MARGIN,
  OPT_WEIGHTS,
  vecFromChosen,
  chosenFromVec,
  surfaceFromChosen,
  packTrialJobs,
  spherePlaneGap,
  projectSphereToPlane,
} from './gpu_opt_protocol.mjs';

function rms(vals) {
  const xs = vals.filter(Number.isFinite);
  if (!xs.length) return 0;
  return Math.sqrt(xs.reduce((s, v) => s + v * v, 0) / xs.length);
}

function meanSq(vals) {
  const xs = vals.filter(Number.isFinite);
  if (!xs.length) return 0;
  return xs.reduce((s, v) => s + v * v, 0) / xs.length;
}

function absMax(vals) {
  return vals.filter(Number.isFinite).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
}

function sharedEdgeKeys(a, b) {
  const sa = new Set();
  for (const f of a.faces || []) for (const e of f.edges || []) sa.add(e);
  const out = [];
  for (const f of b.faces || []) {
    for (const e of f.edges || []) if (sa.has(e)) out.push(e);
  }
  return [...new Set(out)];
}

function latticeUnit(p, N) {
  return [p[0] / N, p[1] / N, p[2] / N];
}

function edgePoints(edge, N) {
  const [a, b] = edge.split('|');
  return [a.split(',').map(Number), b.split(',').map(Number)].map((p) => latticeUnit(p, N));
}

function planeOf(patch) {
  return { type: 'plane', origin: patch.origin, normal: unit(patch.normal) };
}

function residualsOn(surface, points) {
  return (points || []).map((p) => evalSurface(surface, p));
}

function seedSupported(id) {
  return !!id && (id.includes('seed_polyline') || id.includes('numerical'));
}

function branchIsSeed(b) {
  return seedSupported(b?.component) || seedSupported(b?.id);
}

function hingeIntersect(surface, plane, seeds) {
  if (!surface || !plane) return 0;
  if (surface.type === 'sphere') {
    return spherePlaneGap(surface.center, surface.radius, plane, OPT_MARGIN);
  }
  if (surface.type === 'cylinder') {
    const con = planeCylinderConic(plane, surface);
    if (!con) {
      const n = unit(plane.normal);
      const dist = Math.abs(dot(sub(surface.point, plane.origin), n));
      return Math.max(0, dist - surface.radius + OPT_MARGIN);
    }
    if (seeds?.length) {
      const branches = enumerateIntersectionBranches(surface, plane, seeds);
      if (branches.some((b) => b.accept && !branchIsSeed(b))) return 0;
      return 0.03;
    }
    return 0;
  }
  if (surface.type === 'cone' || surface.type === 'generalQuadric') {
    const branches = enumerateIntersectionBranches(plane, surface, seeds?.length ? seeds : [plane.origin]);
    if (branches.some((b) => b.accept && !branchIsSeed(b))) return 0;
    return 0.05;
  }
  return 0;
}

function copyFits(fits) {
  return fits.map((f) => ({
    ...f,
    chosen: f.chosen ? { ...f.chosen, center: f.chosen.center && [...f.chosen.center], axis: f.chosen.axis && [...f.chosen.axis], point: f.chosen.point && [...f.chosen.point], apex: f.chosen.apex && [...f.chosen.apex], coefficients: f.chosen.coefficients && [...f.chosen.coefficients] } : null,
  }));
}

function applyFree(fits, free, vecs) {
  const out = copyFits(fits);
  for (let i = 0; i < free.length; i++) {
    const rec = free[i];
    const fit = out.find((f) => f.patch === rec.patch);
    if (!fit?.chosen) continue;
    fit.chosen = chosenFromVec(fit.chosen, vecs[i]);
  }
  return out;
}

function snapTopo(state) {
  const attr = attributeOpenEdges(state);
  const p5 = state.pieces.find((p) => p.piece === 5);
  return {
    openEdges: state.openEdges,
    shells: state.shells,
    nonmanifold: state.nonmanifold,
    unexplained: attr.unexplainedCount,
    fittedUntrimmed: attr.explainedByFittedUntrimmed,
    piece5Closed: !!p5 && p5.shells === 1 && p5.openEdges === 0,
  };
}

function topoWorse(prev, next) {
  if (next.nonmanifold > 0 || next.nonmanifold > prev.nonmanifold) return 'nonmanifold';
  if (next.unexplained > 0) return 'unexplained';
  if (next.openEdges > prev.openEdges) return 'open-edges';
  if (!next.piece5Closed) return 'piece-5';
  if (next.shells > prev.shells) return 'shells';
  return null;
}

export function buildOptProblem(raw, correspondence, insertion, opts = {}) {
  const N = correspondence.gridResolution;
  const fits = copyFits(insertion.fits);
  const overrides = { ...(insertion.branchOverrides || {}) };
  const patches = correspondence.patches;
  const byId = new Map(patches.map((p) => [p.id, p]));
  const only = opts.unlockPatches;
  const free = fits.filter((f) => {
    if (!f.chosen) return false;
    if (only) return only.includes(f.patch);
    return !!f.topologyProbe;
  }).map((f) => ({
    patch: f.patch,
    piece: f.piece,
    family: f.chosen.type,
    seed: vecFromChosen(f.chosen),
    residualGate: f.residualGate || 'mateB',
    acceptedUnlock: !!(only && !f.topologyProbe),
  }));
  const samplesA = {};
  const samplesB = {};
  const loops = {};
  const adjacencies = [];
  for (const rec of free) {
    const patch = byId.get(rec.patch);
    samplesA[rec.patch] = [...(patch?.samplesA || [])];
    samplesB[rec.patch] = [...(patch?.samplesJoint || [])];
    loops[rec.patch] = boundaryLoopSamples(patch, N);
    for (const other of patches) {
      if (other.piece !== patch.piece || other.id === patch.id) continue;
      if (other.kind === 'curved') continue;
      const keys = sharedEdgeKeys(patch, other);
      if (!keys.length) continue;
      const seeds = keys.flatMap((e) => edgePoints(e, N));
      adjacencies.push({
        patch: rec.patch,
        planeId: other.id,
        key: adjacencyKey(rec.patch, other.id),
        plane: planeOf(other),
        seeds,
        latticeEnds: seeds.slice(0, 2),
        required: only ? true : rec.patch === 'S74' && other.id === 'S78',
      });
    }
  }
  return {
    raw,
    correspondence,
    fits,
    overrides,
    free,
    samplesA,
    samplesB,
    loops,
    adjacencies,
    weights: { ...OPT_WEIGHTS, ...(opts.weights || {}) },
    evaluateJobs: opts.evaluateJobs || evaluateJobsCpu,
    opts,
  };
}

export function energyOf(problem, vecs) {
  const w = problem.weights;
  const aVals = [];
  const bVals = [];
  const junc = [];
  const trim = [];
  const inter = [];
  const reg = [];
  for (let i = 0; i < problem.free.length; i++) {
    const rec = problem.free[i];
    const chosen = chosenFromVec(
      problem.fits.find((f) => f.patch === rec.patch).chosen,
      vecs[i],
    );
    const surf = surfaceFromChosen(chosen);
    aVals.push(...residualsOn(surf, problem.samplesA[rec.patch]));
    bVals.push(...residualsOn(surf, problem.samplesB[rec.patch]));
    const seed = rec.seed;
    for (let k = 0; k < seed.length; k++) {
      const scaleK = rec.family === 'generalQuadric' ? 0.25 : 1;
      reg.push((vecs[i][k] - seed[k]) * scaleK);
    }
    for (const adj of problem.adjacencies.filter((a) => a.patch === rec.patch)) {
      const h = hingeIntersect(surf, adj.plane, adj.seeds);
      inter.push(adj.required ? h * 5 : h);
      for (const p of adj.latticeEnds || []) {
        junc.push(evalSurface(surf, p));
        junc.push(evalSurface(adj.plane, p));
      }
      if (surf.type === 'sphere') {
        const cir = planeSphereCircle(adj.plane, surf);
        if (cir && adj.latticeEnds?.length) {
          for (const p of adj.latticeEnds) {
            const d = Math.abs(norm(sub(p, cir.center)) - cir.radius);
            trim.push(d);
          }
        }
      }
    }
  }
  const E_A = rms(aVals);
  const E_B = rms(bVals);
  const E_J = rms(junc);
  const E_T = rms(trim);
  const E_I = meanSq(inter);
  const E_R = meanSq(reg);
  const total = w.A * E_A + w.B * E_B + w.junction * E_J + w.trim * E_T + w.intersection * E_I + w.reg * E_R;
  return {
    total,
    terms: { A: E_A, B: E_B, junction: E_J, trim: E_T, intersection: E_I, reg: E_R },
    max: { A: absMax(aVals), B: absMax(bVals) },
  };
}

function localStarts(rec, problem) {
  const seed = [...rec.seed];
  const out = [seed];
  const scales = rec.family === 'sphere' ? [0.02, 0.05, 0.1] : [0.015, 0.04];
  for (const s of scales) {
    for (let i = 0; i < seed.length; i++) {
      const up = [...seed];
      const dn = [...seed];
      up[i] += s;
      dn[i] -= s;
      out.push(up, dn);
    }
  }
  if (rec.family === 'cylinder') {
    const axis = unit(seed.slice(0, 3));
    const point = seed.slice(3, 6);
    const r = seed[6];
    for (const adj of problem.adjacencies.filter((a) => a.patch === rec.patch)) {
      const n = unit(adj.plane.normal);
      const dist = Math.abs(dot(sub(point, adj.plane.origin), n));
      if (dist <= r - OPT_MARGIN) continue;
      const grown = [...seed];
      grown[6] = dist + OPT_MARGIN + 0.01;
      out.push(grown);
      const signed = dot(sub(point, adj.plane.origin), n);
      const shifted = sub(point, scale(n, Math.sign(signed || 1) * Math.max(0, dist - r + OPT_MARGIN)));
      out.push([...axis, ...shifted, r]);
      out.push([...axis, ...shifted, dist + OPT_MARGIN]);
    }
  }
  if (rec.family === 'sphere') {
    for (const adj of problem.adjacencies.filter((a) => a.patch === rec.patch)) {
      out.push(projectSphereToPlane(seed, adj.plane));
      const n = unit(adj.plane.normal);
      const c = seed.slice(0, 3);
      const signed = dot(sub(c, adj.plane.origin), n);
      out.push([...c, Math.abs(signed) + OPT_MARGIN + 0.01]);
      const moved = sub(c, scale(n, signed));
      out.push([...moved, Math.max(seed[3], 0.08)]);
    }
  }
  return out;
}

function packCarrierTrials(problem, rec, vecs) {
  return packTrialJobs(vecs.map((vec, initId) => {
    const chosen = chosenFromVec(problem.fits.find((f) => f.patch === rec.patch).chosen, vec);
    return {
      family: rec.family,
      openingIndex: 0,
      initId,
      samplesA: problem.samplesA[rec.patch],
      samplesB: problem.samplesB[rec.patch],
      loop: problem.loops[rec.patch],
      surface: surfaceFromChosen(chosen),
    };
  }));
}

function coordinateDescent(problem, vecs, index, { iters = 8, step0 = 0.04, reject = null } = {}) {
  let cur = vecs.map((v) => [...v]);
  let best = energyOf(problem, cur);
  let step = step0;
  const n = cur[index].length;
  for (let it = 0; it < iters; it++) {
    let improved = false;
    for (let i = 0; i < n; i++) {
      for (const dir of [-1, 1]) {
        const trial = cur.map((v) => [...v]);
        trial[index][i] += dir * step;
        if (problem.free[index].family === 'sphere' && i === 3) {
          trial[index][i] = Math.abs(trial[index][i]);
        }
        if (reject && reject(trial, index)) continue;
        const e = energyOf(problem, trial);
        if (e.total + 1e-12 < best.total) {
          cur = trial;
          best = e;
          improved = true;
        }
      }
    }
    step *= improved ? 0.85 : 0.5;
    if (step < 1e-5) break;
  }
  return { vecs: cur, energy: best };
}

function projectRequired(problem, vecs) {
  const out = vecs.map((v) => [...v]);
  for (let i = 0; i < problem.free.length; i++) {
    if (problem.free[i].family !== 'sphere') continue;
    for (const adj of problem.adjacencies) {
      if (!adj.required || adj.patch !== problem.free[i].patch) continue;
      out[i] = projectSphereToPlane(out[i], adj.plane);
    }
  }
  return out;
}

function checkpoint(problem, vecs) {
  const fits = applyFree(problem.fits, problem.free, vecs);
  const state = topologyMetrics(problem.raw, problem.correspondence, fits, {
    branchOverrides: problem.overrides,
  });
  return { fits, state, snap: snapTopo(state) };
}

function s74Status(problem, vecs) {
  const rec = problem.free.find((f) => f.patch === 'S74');
  if (!rec) return null;
  const chosen = chosenFromVec(problem.fits.find((f) => f.patch === 'S74').chosen, vecs[problem.free.indexOf(rec)]);
  const surf = surfaceFromChosen(chosen);
  const adj = problem.adjacencies.find((a) => a.required) || problem.adjacencies.find((a) => a.patch === 'S74' && a.planeId === 'S78');
  const cir = adj ? planeSphereCircle(adj.plane, surf) : null;
  const signed = adj ? dot(sub(surf.center, adj.plane.origin), unit(adj.plane.normal)) : null;
  return {
    familyTried: 'sphere',
    familyFeasible: !!cir,
    geometry: {
      center: surf.center,
      radius: surf.radius,
      planeDistance: signed == null ? null : Math.abs(signed),
      circleRadius: cir?.radius ?? null,
    },
  };
}

function regenerateMissing(problem, vecs) {
  const fits = applyFree(problem.fits, problem.free, vecs);
  const need = problem.free.map((f) => f.patch);
  const search = searchTrimBranches(problem.raw, problem.correspondence, fits, {
    patchIds: need,
    startOverrides: problem.overrides,
    includeMate: false,
    allowFallbackBranches: false,
    orientations: ['forward', 'reverse'],
  });
  const trialOverrides = search.chosen.overrides;
  const state = topologyMetrics(problem.raw, problem.correspondence, fits, {
    branchOverrides: trialOverrides,
  });
  const before = topologyMetrics(problem.raw, problem.correspondence, fits, {
    branchOverrides: problem.overrides,
  });
  const worse = topoWorse(snapTopo(before), snapTopo(state));
  if (worse) {
    return { accepted: false, reason: worse, overrides: problem.overrides, state: before, fits };
  }
  return { accepted: true, reason: 'regenerated', overrides: trialOverrides, state, fits, search };
}

export function optimizeProvisionals(raw, correspondence, insertion, opts = {}) {
  const problem = buildOptProblem(raw, correspondence, insertion, opts);
  const stage1Iters = opts.stage1Iters ?? 7;
  const stage2Sweeps = opts.stage2Sweeps ?? 10;
  const keepStarts = opts.keepStarts ?? 3;
  let vecs = problem.free.map((f) => [...f.seed]);
  const baselineEnergy = energyOf(problem, vecs);
  const baselineTopo = checkpoint(problem, vecs).snap;
  const log = [];
  const retained = [];

  for (let i = 0; i < problem.free.length; i++) {
    const rec = problem.free[i];
    const starts = localStarts(rec, problem);
    const packed = packCarrierTrials(problem, rec, starts);
    const scored = problem.evaluateJobs(packed.packed);
    const ranked = starts.map((vec, k) => {
      const trial = vecs.map((v) => [...v]);
      trial[i] = vec;
      const e = energyOf(problem, trial);
      return { vec, energy: e, fitRms: scored[k]?.fitRms, mateBRms: scored[k]?.mateBRms };
    }).sort((a, b) => a.energy.total - b.energy.total);
    const kept = ranked.slice(0, keepStarts);
    let bestLocal = { vecs, energy: energyOf(problem, vecs) };
    for (const cand of kept) {
      const trial0 = vecs.map((v) => [...v]);
      trial0[i] = cand.vec;
      const descended = coordinateDescent(problem, trial0, i, { iters: stage1Iters });
      if (descended.energy.total < bestLocal.energy.total) bestLocal = descended;
    }
    const chk = checkpoint(problem, bestLocal.vecs);
    const worse = topoWorse(baselineTopo, chk.snap);
    const accept = !worse && bestLocal.energy.total <= energyOf(problem, vecs).total + 1e-9;
    log.push({
      stage: 1,
      patch: rec.patch,
      family: rec.family,
      starts: starts.length,
      kept: kept.length,
      before: energyOf(problem, vecs).terms,
      after: bestLocal.energy.terms,
      totalBefore: energyOf(problem, vecs).total,
      totalAfter: bestLocal.energy.total,
      decision: accept ? 'keep' : 'rollback',
      reason: worse || (accept ? 'energy-decreased' : 'no-improvement'),
      topology: chk.snap,
    });
    if (accept) vecs = bestLocal.vecs;
    if (rec.patch === 'S74') {
      const forced = projectRequired(problem, vecs);
      const feas = s74Status(problem, forced);
      const chkF = checkpoint(problem, forced);
      const worseF = topoWorse(baselineTopo, chkF.snap);
      log.push({
        stage: '1-feasibility',
        patch: 'S74',
        family: 'sphere',
        decision: !worseF && feas.familyFeasible ? 'keep' : 'rollback',
        reason: worseF || (feas.familyFeasible ? 'enforced-plane-sphere' : 'projection-still-infeasible'),
        topology: chkF.snap,
        familyFeasible: feas.familyFeasible,
        geometry: feas.geometry,
        totalAfter: energyOf(problem, forced).total,
      });
      if (!worseF && feas.familyFeasible) vecs = forced;
    }
    retained.push({ patch: rec.patch, candidates: kept.map((c) => ({ total: c.energy.total, terms: c.energy.terms })) });
  }

  let joint = energyOf(problem, vecs);
  for (let sweep = 0; sweep < stage2Sweeps; sweep++) {
    let next = vecs;
    for (let i = 0; i < problem.free.length; i++) {
      const descended = coordinateDescent(problem, next, i, { iters: 3, step0: 0.02 });
      next = descended.vecs;
    }
    const e = energyOf(problem, next);
    const chk = checkpoint(problem, next);
    const worse = topoWorse(baselineTopo, chk.snap);
    const accept = !worse && e.total + 1e-12 < joint.total;
    log.push({
      stage: 2,
      sweep,
      totalBefore: joint.total,
      totalAfter: e.total,
      terms: e.terms,
      decision: accept ? 'keep' : 'rollback',
      reason: worse || (accept ? 'energy-decreased' : 'trust-region-reject'),
      topology: chk.snap,
    });
    if (accept) {
      const forced = projectRequired(problem, next);
      const chkF = checkpoint(problem, forced);
      if (!topoWorse(baselineTopo, chkF.snap)) {
        vecs = forced;
        joint = energyOf(problem, vecs);
      } else {
        vecs = next;
        joint = e;
      }
    }
  }

  const regen = regenerateMissing(problem, vecs);
  if (regen.accepted) problem.overrides = regen.overrides;
  const finalFits = applyFree(problem.fits, problem.free, vecs).map((f) => {
    const rec = problem.free.find((x) => x.patch === f.patch);
    if (!rec || !f.chosen) return f;
    const surf = surfaceFromChosen(f.chosen);
    const a = residualsOn(surf, problem.samplesA[f.patch]);
    const b = residualsOn(surf, problem.samplesB[f.patch]);
    f.chosen = { ...f.chosen, mateARms: rms(a), mateBRms: rms(b), rms: rms(a) };
    return f;
  });
  const finalState = topologyMetrics(raw, correspondence, finalFits, {
    branchOverrides: problem.overrides,
  });
  const finalSnap = snapTopo(finalState);
  const statuses = carrierStatuses(finalFits, finalState);
  const closure = buildClosureReport(raw, correspondence, finalFits, null, {
    branchOverrides: problem.overrides,
  });
  const s74 = s74Status(problem, vecs);
  const seedTrims = Object.values(problem.overrides).filter(seedSupported);
  let promoted = 0;
  for (const f of finalFits) {
    if (!f.topologyProbe || !f.chosen) continue;
    const st = statuses.find((c) => c.patch === f.patch);
    const bRms = f.chosen.mateBRms ?? Infinity;
    const aRms = f.chosen.mateARms ?? Infinity;
    const geometric = st?.trimComplete && bRms <= 0.01 && aRms <= 0.01;
    if (geometric && (f.patch !== 'S74' || s74?.familyFeasible)) {
      f.topologyProbe = false;
      f.acceptedGeometry = true;
      f.residualGate = 'pass';
      promoted++;
    }
  }
  const remainingProbe = finalFits.filter((f) => f.topologyProbe && f.chosen).length;
  const finalEnergy = energyOf(problem, vecs);
  const gate = {
    openEdges: finalSnap.openEdges,
    shells: finalSnap.shells,
    nonmanifoldEdges: finalSnap.nonmanifold,
    unexplainedEdges: finalSnap.unexplained,
    provisionalCarriers: remainingProbe,
    seedSupportedTrims: seedTrims.length,
    cubeA: { trimRms: finalEnergy.terms.A, trimMax: finalEnergy.max.A },
    cubeB: { trimRms: finalEnergy.terms.B, trimMax: finalEnergy.max.B },
    trimMax: Math.max(
      finalEnergy.max.A,
      finalEnergy.max.B,
      closure.metrics?.continuousTrimMismatch?.max ?? 0,
    ),
    continuousTrimMismatch: closure.metrics?.continuousTrimMismatch ?? null,
  };
  const success = gate.openEdges === 0
    && gate.shells === 8
    && gate.nonmanifoldEdges === 0
    && gate.unexplainedEdges === 0
    && gate.provisionalCarriers === 0
    && gate.seedSupportedTrims === 0
    && gate.cubeA.trimRms <= 0.01
    && gate.cubeB.trimRms <= 0.01
    && gate.trimMax <= 0.03;
  return {
    schema: 'dual-cube-global-opt',
    version: 1,
    note: 'Stage 1–3 provisional-only solve. Accepted carriers stayed frozen. CPU owns trust-region and topology checkpoints. Batched A/B residuals use the BFG1 ABI.',
    success,
    baseline: { energy: baselineEnergy, topology: baselineTopo },
    final: {
      energy: finalEnergy,
      topology: finalSnap,
    },
    gate,
    s74: s74 && {
      ...s74,
      topologyStillValid: finalSnap.nonmanifold === 0 && finalSnap.unexplained === 0,
    },
    promoted,
    remainingProvisional: remainingProbe,
    seedSupportedTrims: seedTrims,
    log,
    retained,
    branchOverrides: problem.overrides,
    carrierStatus: carrierStatuses(finalFits, finalState),
    fits: finalFits,
    packedTrials: packCarrierTrials(problem, problem.free[0], [vecs[0]]).packed.byteLength,
  };
}

export const CONTINUATION_STAGES = [
  {
    id: 'A',
    label: 'preserve-topology-worst-B',
    weights: { A: 1, B: 2.8, junction: 0.4, trim: 0.15, intersection: 2, reg: 0.3 },
    focus: 'worstB',
    focusCount: 4,
    sweeps: 6,
    step0: 0.03,
    iters: 5,
  },
  {
    id: 'B',
    label: 'balance-A-B',
    weights: { A: 1, B: 1.15, junction: 0.5, trim: 0.3, intersection: 5, reg: 0.15 },
    focus: 'all',
    sweeps: 6,
    step0: 0.02,
    iters: 4,
  },
  {
    id: 'C',
    label: 'analytic-intersections',
    weights: { A: 1, B: 1, junction: 0.65, trim: 0.45, intersection: 14, reg: 0.1 },
    focus: 'missingReal',
    sweeps: 5,
    step0: 0.015,
    iters: 4,
  },
  {
    id: 'D',
    label: 'junction-trim-coincidence',
    weights: { A: 1, B: 1, junction: 1.25, trim: 1.1, intersection: 16, reg: 0.08 },
    focus: 'all',
    sweeps: 4,
    step0: 0.01,
    iters: 3,
  },
];

const STALL_FAMILY = ['S45', 'S9'];
const FAMILY_FITTERS = {
  sphere: fitSphere,
  cylinder: fitCylinder,
  cone: fitCone,
  generalQuadric: fitGeneralQuadric,
};

function vdot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * (b[i] || 0);
  return s;
}

function vsub(a, b) {
  return a.map((x, i) => x - (b[i] || 0));
}

function vnorm(a) {
  return Math.sqrt(vdot(a, a));
}

function isSeedBranch(b) {
  const c = b?.component || '';
  const id = b?.id || b?.selectedBranchId || '';
  return seedSupported(c) || seedSupported(id);
}

function hasRealIntersection(surf, plane, seeds) {
  const branches = enumerateIntersectionBranches(surf, plane, seeds || [plane.origin]);
  return branches.some((b) => b.accept && !isSeedBranch(b));
}

function alternateFamilies(current) {
  const specials = ['sphere', 'cylinder', 'cone'];
  return [...specials.filter((f) => f !== current), 'generalQuadric'].filter((f) => f !== current);
}

function chosenFromFamilyFit(fit) {
  if (!fit) return null;
  if (fit.type === 'sphere') return { type: 'sphere', center: fit.center, radius: fit.radius, rms: fit.rms };
  if (fit.type === 'cylinder') return { type: 'cylinder', axis: fit.axis, point: fit.point, radius: fit.radius, rms: fit.rms };
  if (fit.type === 'cone') return { type: 'cone', apex: fit.apex, axis: fit.axis, angle: fit.angle, rms: fit.rms };
  if (fit.type === 'generalQuadric') return { type: 'generalQuadric', coefficients: fit.coefficients, rms: fit.rms };
  return null;
}

export function violatesRollback(constraints, patch, fromVec, toVec) {
  for (const c of constraints) {
    if (c.patch !== patch || !c.from || !c.failed) continue;
    const dir = vsub(c.failed, c.from);
    const step = vsub(toVec, fromVec);
    const d = vnorm(dir);
    const s = vnorm(step);
    if (d < 1e-10 || s < 1e-10) continue;
    if (vdot(step, dir) / (s * d) > 0.35) return c;
  }
  return null;
}

function patchSeedCount(diag) {
  return (diag?.adjacencies || []).filter((a) => isSeedBranch(a) || isSeedBranch(a.selected) || seedSupported(a.selectedBranchId)).length;
}

export function rankProvisionals(problem, vecs, opts = {}) {
  const skipSensitivity = opts.skipSensitivity === true;
  const baseline = skipSensitivity ? null : checkpoint(problem, vecs);
  const rows = [];
  for (let i = 0; i < problem.free.length; i++) {
    const rec = problem.free[i];
    const chosen = chosenFromVec(problem.fits.find((f) => f.patch === rec.patch).chosen, vecs[i]);
    const surf = surfaceFromChosen(chosen);
    const a = residualsOn(surf, problem.samplesA[rec.patch]);
    const b = residualsOn(surf, problem.samplesB[rec.patch]);
    const adjs = problem.adjacencies.filter((x) => x.patch === rec.patch);
    const junc = [];
    const missingReal = [];
    let seedTrims = 0;
    for (const adj of adjs) {
      for (const p of adj.latticeEnds || []) junc.push(evalSurface(surf, p));
      const ov = problem.overrides[adj.key];
      const real = hasRealIntersection(surf, adj.plane, adj.seeds);
      if (seedSupported(ov) || !real) seedTrims += 1;
      if (!real) missingReal.push(adj.planeId);
    }
    let diag = null;
    if (!opts.skipDiagnose) {
      try {
        diag = diagnosePatch(problem.raw, problem.correspondence, applyFree(problem.fits, problem.free, vecs), rec.patch, {
          branchOverrides: problem.overrides,
        });
        seedTrims = Math.max(seedTrims, patchSeedCount(diag));
      } catch {
        diag = null;
      }
    }
    let topologySensitive = false;
    let topologyReason = null;
    if (!skipSensitivity && baseline) {
      const trial = vecs.map((v) => [...v]);
      trial[i] = trial[i].map((x, k) => (k === 0 ? x + 0.04 : x));
      const worse = topoWorse(baseline.snap, checkpoint(problem, trial).snap);
      topologySensitive = !!worse;
      topologyReason = worse;
    }
    rows.push({
      patch: rec.patch,
      piece: rec.piece,
      family: rec.family,
      cubeA: { rms: rms(a), max: absMax(a) },
      cubeB: { rms: rms(b), max: absMax(b) },
      junctionRms: rms(junc),
      seedSupportedTrims: seedTrims,
      topologySensitive,
      topologyReason,
      realIntersection: missingReal.length === 0,
      missingRealIntersections: missingReal,
      contributionB: meanSq(b),
    });
  }
  rows.sort((a, b) => (b.cubeB.rms - a.cubeB.rms) || (b.cubeB.max - a.cubeB.max));
  return rows;
}

function rebuildProblem(raw, correspondence, fits, overrides, opts) {
  return buildOptProblem(raw, correspondence, { fits, branchOverrides: overrides }, opts);
}

function vecsByPatch(problem, vecs) {
  const map = new Map();
  for (let i = 0; i < problem.free.length; i++) map.set(problem.free[i].patch, vecs[i]);
  return map;
}

function vecsFromMap(problem, map) {
  return problem.free.map((rec) => (map.has(rec.patch) ? [...map.get(rec.patch)] : [...rec.seed]));
}

function tryReplaceSeedTrims(problem, vecs, log, baselineTopo) {
  const fits = applyFree(problem.fits, problem.free, vecs);
  const freeSet = new Set(problem.free.map((f) => f.patch));
  const jobs = [];
  for (const [key, id] of Object.entries(problem.overrides || {})) {
    if (!seedSupported(id)) continue;
    const [a, b] = key.split('|');
    const fa = fits.find((f) => f.patch === a);
    const fb = fits.find((f) => f.patch === b);
    const patch = freeSet.has(a) ? a
      : freeSet.has(b) ? b
        : (fa?.chosen && fa.chosen.type !== 'plane' ? a
          : fb?.chosen && fb.chosen.type !== 'plane' ? b : a);
    jobs.push({ key, id, patch });
  }
  for (const rec of problem.free) {
    let diag;
    try {
      diag = diagnosePatch(problem.raw, problem.correspondence, fits, rec.patch, {
        branchOverrides: problem.overrides,
      });
    } catch {
      continue;
    }
    for (const adj of diag.adjacencies || []) {
      if (!isSeedBranch(adj) && !isSeedBranch(adj.selected) && !seedSupported(adj.selectedBranchId)) continue;
      const key = adjacencyKey(rec.patch, adj.planeId);
      if (jobs.some((j) => j.key === key)) continue;
      jobs.push({ key, id: adj.selectedBranchId, patch: rec.patch, diagAdj: adj });
    }
  }
  const rankPatch = (p) => (p === 'S9' ? 0 : p === 'S45' ? 1 : freeSet.has(p) ? 2 : 3);
  jobs.sort((a, b) => rankPatch(a.patch) - rankPatch(b.patch));
  for (const job of jobs) {
    let diag;
    try {
      diag = diagnosePatch(problem.raw, problem.correspondence, applyFree(problem.fits, problem.free, vecs), job.patch, {
        branchOverrides: problem.overrides,
      });
    } catch {
      log.push({ stage: 'seed-trim', patch: job.patch, adjacency: job.key, decision: 'skip', reason: 'diagnose-failed' });
      continue;
    }
    const planeId = job.key.split('|').find((id) => id !== job.patch);
    const adjDiag = (diag.adjacencies || []).find((a) => a.planeId === planeId) || job.diagAdj;
    const real = (adjDiag?.branches || []).filter((b) => b.accept && !isSeedBranch(b));
    let kept = null;
    for (const br of real) {
      const trialOverrides = { ...problem.overrides, [job.key]: br.id };
      const state = topologyMetrics(problem.raw, problem.correspondence, applyFree(problem.fits, problem.free, vecs), {
        branchOverrides: trialOverrides,
      });
      const worse = topoWorse(baselineTopo, snapTopo(state));
      if (!worse) {
        problem.overrides = trialOverrides;
        kept = br.id;
        break;
      }
    }
    log.push({
      stage: 'seed-trim',
      patch: job.patch,
      adjacency: job.key,
      previous: job.id,
      decision: kept ? 'keep' : (freeSet.has(job.patch) ? 'unresolved' : 'accepted-carrier-frozen'),
      reason: kept ? 'real-analytic-branch' : (real.length ? 'topology-reject' : 'no-real-intersection'),
      replacement: kept,
      frozenAccepted: !freeSet.has(job.patch),
    });
  }
}

function tryPromoteOne(problem, vecs, log, baselineTopo) {
  const fits = applyFree(problem.fits, problem.free, vecs);
  const state = topologyMetrics(problem.raw, problem.correspondence, fits, { branchOverrides: problem.overrides });
  const statuses = carrierStatuses(fits, state);
  const s74 = s74Status(problem, vecs);
  let promoted = 0;
  const remaining = [];
  for (const rec of problem.free) {
    const fit = fits.find((f) => f.patch === rec.patch);
    if (!fit?.chosen || !fit.topologyProbe) continue;
    const st = statuses.find((c) => c.patch === rec.patch);
    const aRms = fit.chosen.mateARms ?? rms(residualsOn(surfaceFromChosen(fit.chosen), problem.samplesA[rec.patch]));
    const bRms = fit.chosen.mateBRms ?? rms(residualsOn(surfaceFromChosen(fit.chosen), problem.samplesB[rec.patch]));
    const surf = surfaceFromChosen(fit.chosen);
    const adjs = problem.adjacencies.filter((x) => x.patch === rec.patch);
    const real = adjs.every((adj) => hasRealIntersection(surf, adj.plane, adj.seeds));
    const seedLeft = adjs.some((adj) => seedSupported(problem.overrides[adj.key]));
    let seedOnDiag = false;
    try {
      const diag = diagnosePatch(problem.raw, problem.correspondence, fits, rec.patch, { branchOverrides: problem.overrides });
      seedOnDiag = patchSeedCount(diag) > 0;
    } catch { /* keep seedOnDiag false */ }
    const residualOk = st?.trimComplete && aRms <= 0.01 && bRms <= 0.01;
    const s74Ok = rec.patch !== 'S74' || s74?.familyFeasible;
    if (!residualOk || !real || seedLeft || seedOnDiag || !s74Ok) {
      remaining.push(rec.patch);
      continue;
    }
    const probeOff = copyFits(fits);
    const target = probeOff.find((f) => f.patch === rec.patch);
    target.topologyProbe = false;
    target.acceptedGeometry = true;
    target.residualGate = 'pass';
    const after = topologyMetrics(problem.raw, problem.correspondence, probeOff, { branchOverrides: problem.overrides });
    if (topoWorse(baselineTopo, snapTopo(after))) {
      log.push({ stage: 'promote', patch: rec.patch, decision: 'rollback', reason: 'topology-changed' });
      remaining.push(rec.patch);
      continue;
    }
    fit.topologyProbe = false;
    fit.acceptedGeometry = true;
    fit.residualGate = 'pass';
    const src = problem.fits.find((f) => f.patch === rec.patch);
    if (src) {
      src.topologyProbe = false;
      src.acceptedGeometry = true;
      src.residualGate = 'pass';
    }
    promoted += 1;
    log.push({ stage: 'promote', patch: rec.patch, decision: 'keep', reason: 'genuine-shared-analytic', cubeA: aRms, cubeB: bRms });
  }
  return { promoted, remaining, fits, statuses };
}

function tryFamilyChange(problem, vecs, recIndex, log, baselineTopo, constraints) {
  const rec = problem.free[recIndex];
  const clouds = [
    problem.samplesA[rec.patch],
    [...(problem.samplesA[rec.patch] || []), ...(problem.samplesB[rec.patch] || [])],
    problem.samplesB[rec.patch],
  ].filter((c) => c?.length >= 4);
  for (const family of alternateFamilies(rec.family)) {
    const fitter = FAMILY_FITTERS[family];
    if (!fitter) continue;
    let bestFit = null;
    for (const pts of clouds) {
      const fit = fitter(pts);
      if (fit && (!bestFit || fit.rms < bestFit.rms)) bestFit = fit;
    }
    const chosen = chosenFromFamilyFit(bestFit);
    if (!chosen) continue;
    const nextFits = copyFits(applyFree(problem.fits, problem.free, vecs));
    const slot = nextFits.find((f) => f.patch === rec.patch);
    slot.chosen = { ...slot.chosen, ...chosen, type: family };
    slot.topologyProbe = true;
    slot.acceptedGeometry = false;
    const next = rebuildProblem(problem.raw, problem.correspondence, nextFits, problem.overrides, {
      evaluateJobs: problem.evaluateJobs,
      weights: problem.weights,
    });
    const map = vecsByPatch(problem, vecs);
    map.set(rec.patch, [...next.free.find((f) => f.patch === rec.patch).seed]);
    const trialVecs = vecsFromMap(next, map);
    const chk = checkpoint(next, trialVecs);
    const worse = topoWorse(baselineTopo, chk.snap);
    const bOld = rms(residualsOn(surfaceFromChosen(chosenFromVec(
      problem.fits.find((f) => f.patch === rec.patch).chosen,
      vecs[recIndex],
    )), problem.samplesB[rec.patch]));
    const bNew = rms(residualsOn(surfaceFromChosen(chosen), problem.samplesB[rec.patch]));
    const rejectB = !worse && bNew > bOld - 1e-6;
    log.push({
      stage: 'family',
      patch: rec.patch,
      familyTried: family,
      fromFamily: rec.family,
      decision: worse || rejectB ? 'rollback' : 'keep',
      reason: worse || (rejectB ? 'no-B-improvement' : 'alternate-special-quadric'),
      rms: bestFit.rms,
      cubeB: { before: bOld, after: bNew },
      topology: chk.snap,
    });
    if (worse || rejectB) {
      if (worse) {
        constraints.push({
          patch: rec.patch,
          reason: worse,
          from: vecs[recIndex],
          failed: trialVecs[Math.max(0, next.free.findIndex((f) => f.patch === rec.patch))],
          kind: worse,
          familyTried: family,
        });
      }
      continue;
    }
    return { problem: next, vecs: trialVecs, family };
  }
  return null;
}

function applyStage(problem, vecs, stage, rank, constraints, log, baselineTopo, opts) {
  problem.weights = { ...OPT_WEIGHTS, ...stage.weights };
  const byPatch = new Map(rank.map((r, i) => [r.patch, i]));
  let indices = problem.free.map((_, i) => i);
  if (stage.focus === 'worstB') {
    const worst = rank.slice(0, stage.focusCount || 4).map((r) => r.patch);
    indices = problem.free.map((rec, i) => (worst.includes(rec.patch) ? i : -1)).filter((i) => i >= 0);
  } else if (stage.focus === 'missingReal') {
    const miss = rank.filter((r) => !r.realIntersection).map((r) => r.patch);
    indices = problem.free.map((rec, i) => (miss.includes(rec.patch) ? i : -1)).filter((i) => i >= 0);
  }
  if (!indices.length) indices = problem.free.map((_, i) => i);
  const sweeps = opts.sweeps ?? stage.sweeps;
  const iters = opts.iters ?? stage.iters;
  let joint = energyOf(problem, vecs);
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let next = vecs;
    for (const i of indices) {
      const rec = problem.free[i];
      const from = next[i];
      const reject = (trial) => !!violatesRollback(constraints, rec.patch, from, trial[i]);
      const descended = coordinateDescent(problem, next, i, { iters, step0: stage.step0, reject });
      const chk = checkpoint(problem, descended.vecs);
      const worse = topoWorse(baselineTopo, chk.snap);
      if (worse) {
        constraints.push({
          patch: rec.patch,
          reason: worse,
          kind: worse,
          from,
          failed: descended.vecs[i],
          stage: stage.id,
        });
        log.push({
          stage: stage.id,
          sweep,
          patch: rec.patch,
          decision: 'rollback',
          reason: worse,
          topology: chk.snap,
          constraint: worse,
          rank: byPatch.get(rec.patch),
        });
        continue;
      }
      next = descended.vecs;
    }
    const forced = projectRequired(problem, next);
    const chkF = checkpoint(problem, forced);
    const worseF = topoWorse(baselineTopo, chkF.snap);
    const e = energyOf(problem, worseF ? next : forced);
    const bHold = e.terms.B <= joint.terms.B + 1e-9;
    const better = !worseF && (
      (stage.id === 'A' || stage.id === 'B')
        ? (bHold && (e.total + 1e-12 < joint.total || e.terms.B + 1e-12 < joint.terms.B))
        : (e.total + 1e-12 < joint.total || e.terms.B + 1e-12 < joint.terms.B)
    );
    log.push({
      stage: stage.id,
      sweep,
      totalBefore: joint.total,
      totalAfter: e.total,
      terms: e.terms,
      decision: better ? 'keep' : 'rollback',
      reason: worseF || (better ? (e.total < joint.total ? 'energy-decreased' : 'cube-B-decreased') : 'trust-region-hold'),
      topology: chkF.snap,
    });
    if (better) {
      vecs = forced;
      joint = e;
    }
  }
  return vecs;
}

function attachLocalResiduals(problem, vecs) {
  return applyFree(problem.fits, problem.free, vecs).map((f) => {
    const rec = problem.free.find((x) => x.patch === f.patch);
    if (!rec || !f.chosen) return f;
    const surf = surfaceFromChosen(f.chosen);
    const a = residualsOn(surf, problem.samplesA[f.patch]);
    const b = residualsOn(surf, problem.samplesB[f.patch]);
    f.chosen = { ...f.chosen, mateARms: rms(a), mateBRms: rms(b), rms: rms(a) };
    return f;
  });
}

export function continueProvisionals(raw, correspondence, insertion, opts = {}) {
  let problem = buildOptProblem(raw, correspondence, insertion, opts);
  let vecs = problem.free.map((f) => [...f.seed]);
  const acceptedFrozen = problem.fits
    .filter((f) => f.chosen && !f.topologyProbe)
    .map((f) => ({ patch: f.patch, type: f.chosen.type, center: f.chosen.center && [...f.chosen.center], radius: f.chosen.radius, axis: f.chosen.axis && [...f.chosen.axis] }));
  const baselineEnergy = energyOf(problem, vecs);
  const baselineTopo = checkpoint(problem, vecs).snap;
  const log = [];
  const constraints = [...(opts.constraints || [])];
  const ranking0 = rankProvisionals(problem, vecs, { skipSensitivity: opts.skipSensitivity });
  log.push({ stage: 'rank', ranking: ranking0 });

  if (opts.skipSeed !== true) tryReplaceSeedTrims(problem, vecs, log, baselineTopo);

  const stages = opts.stages || CONTINUATION_STAGES;
  for (const stage of stages) {
    const rank = rankProvisionals(problem, vecs, { skipSensitivity: true, skipDiagnose: true });
    vecs = applyStage(problem, vecs, stage, rank, constraints, log, baselineTopo, {
      sweeps: opts.sweeps,
      iters: opts.iters,
    });
    const regen = regenerateMissing(problem, vecs);
    log.push({
      stage: `${stage.id}-regen`,
      decision: regen.accepted ? 'keep' : 'rollback',
      reason: regen.reason,
    });
    if (regen.accepted) problem.overrides = regen.overrides;
    if (opts.skipSeed !== true) tryReplaceSeedTrims(problem, vecs, log, baselineTopo);
    problem.fits = attachLocalResiduals(problem, vecs);
    tryPromoteOne(problem, vecs, log, baselineTopo);
    const map = vecsByPatch(problem, vecs);
    problem = rebuildProblem(raw, correspondence, problem.fits, problem.overrides, {
      evaluateJobs: problem.evaluateJobs,
      weights: stage.weights,
    });
    vecs = vecsFromMap(problem, map);
  }

  if (opts.skipFamily !== true) {
    const rank = rankProvisionals(problem, vecs, { skipSensitivity: true });
    for (const patch of STALL_FAMILY) {
      const row = rank.find((r) => r.patch === patch);
      const idx = problem.free.findIndex((f) => f.patch === patch);
      if (idx < 0 || !row) continue;
      const rolled = constraints.some((c) => c.patch === patch);
      const stalled = row.cubeB.rms > 0.04 && (rolled || !row.realIntersection || row.cubeB.rms >= (ranking0.find((r) => r.patch === patch)?.cubeB.rms || 0) - 1e-6);
      if (!stalled) continue;
      const changed = tryFamilyChange(problem, vecs, idx, log, baselineTopo, constraints);
      if (changed) {
        problem = changed.problem;
        vecs = changed.vecs;
      }
    }
  }

  const finalFits = attachLocalResiduals(problem, vecs);
  problem.fits = finalFits;
  const promo = tryPromoteOne(problem, vecs, log, baselineTopo);
  problem.weights = { ...OPT_WEIGHTS };
  const finalState = topologyMetrics(raw, correspondence, promo.fits, { branchOverrides: problem.overrides });
  const finalSnap = snapTopo(finalState);
  const finalEnergy = energyOf(problem, vecs);
  const ranking = rankProvisionals(problem, vecs, { skipSensitivity: opts.skipSensitivity });
  const s74 = s74Status(problem, vecs);
  const seedTrims = Object.values(problem.overrides).filter(seedSupported);
  const remainingProbe = promo.fits.filter((f) => f.topologyProbe && f.chosen).length;
  const frozenOk = acceptedFrozen.every((a) => {
    const f = promo.fits.find((x) => x.patch === a.patch);
    if (!f?.chosen) return false;
    if (f.topologyProbe) return false;
    if (a.radius != null && f.chosen.radius != null && Math.abs(a.radius - f.chosen.radius) > 1e-12) return false;
    if (a.center && f.chosen.center && a.center.some((v, i) => Math.abs(v - f.chosen.center[i]) > 1e-12) ) return false;
    return true;
  });
  const gate = {
    openEdges: finalSnap.openEdges,
    shells: finalSnap.shells,
    nonmanifoldEdges: finalSnap.nonmanifold,
    unexplainedEdges: finalSnap.unexplained,
    provisionalCarriers: remainingProbe,
    seedSupportedTrims: seedTrims.length,
    cubeA: { trimRms: finalEnergy.terms.A, trimMax: finalEnergy.max.A },
    cubeB: { trimRms: finalEnergy.terms.B, trimMax: finalEnergy.max.B },
    trimMax: Math.max(finalEnergy.max.A, finalEnergy.max.B),
    acceptedCarriersFrozen: frozenOk,
  };
  const success = gate.openEdges === 0
    && gate.shells === 8
    && gate.nonmanifoldEdges === 0
    && gate.unexplainedEdges === 0
    && gate.provisionalCarriers === 0
    && gate.seedSupportedTrims === 0
    && gate.cubeA.trimRms <= 0.01
    && gate.cubeB.trimRms <= 0.01
    && gate.trimMax <= 0.03;
  return {
    schema: 'dual-cube-global-opt-continue',
    version: 1,
    note: 'Provisional-only continuation. Ranked by Cube B, then stages A–D. Accepted carriers stayed frozen. Rollbacks became half-space constraints. Seed-supported trims were replaced only when a real branch preserved the eight-shell topology.',
    success,
    ranking: ranking0,
    rankingFinal: ranking,
    baseline: { energy: baselineEnergy, topology: baselineTopo },
    final: { energy: finalEnergy, topology: finalSnap },
    gate,
    s74: s74 && { ...s74, topologyStillValid: finalSnap.nonmanifold === 0 && finalSnap.unexplained === 0 },
    promoted: log.filter((e) => e.stage === 'promote' && e.decision === 'keep').length,
    remainingProvisional: remainingProbe,
    seedSupportedTrims: seedTrims,
    constraints,
    log,
    branchOverrides: problem.overrides,
    carrierStatus: carrierStatuses(promo.fits, finalState),
    fits: promo.fits,
    acceptedCarriersFrozen: frozenOk,
  };
}

export const E1_WEIGHTS = { A: 1.1, B: 1.1, junction: 0.85, trim: 0.5, intersection: 22, reg: 2.8 };
export const E2_WEIGHTS = { A: 1, B: 1.4, junction: 0.7, trim: 0.45, intersection: 28, reg: 0.35 };

function seedTrimIds(overrides) {
  return Object.values(overrides || {}).filter(seedSupported);
}

function realAdjCount(problem, vecs, patch) {
  const rec = problem.free.find((f) => f.patch === patch);
  if (!rec) return { real: 0, missing: [] };
  const chosen = chosenFromVec(problem.fits.find((f) => f.patch === patch).chosen, vecs[problem.free.indexOf(rec)]);
  const surf = surfaceFromChosen(chosen);
  const missing = [];
  let real = 0;
  for (const adj of problem.adjacencies.filter((a) => a.patch === patch)) {
    if (hasRealIntersection(surf, adj.plane, adj.seeds)) real += 1;
    else missing.push(adj.planeId);
  }
  return { real, missing, total: real + missing.length };
}

export function selectiveRepair(raw, correspondence, insertion, opts = {}) {
  const unlockPatches = opts.unlockPatches || ['S6'];
  const weights = opts.weights || ((unlockPatches.length === 1 && (unlockPatches[0] === 'S6' || unlockPatches[0] === 'S96'))
    ? E1_WEIGHTS
    : E2_WEIGHTS);
  const problem = buildOptProblem(raw, correspondence, insertion, { ...opts, unlockPatches, weights });
  if (!problem.free.length) {
    return {
      schema: 'dual-cube-selective-repair',
      unlockPatches,
      skipped: true,
      reason: 'no-free-carriers',
      fits: insertion.fits,
      branchOverrides: insertion.branchOverrides || {},
    };
  }
  const frozenOthers = insertion.fits
    .filter((f) => f.chosen && !unlockPatches.includes(f.patch) && !f.topologyProbe)
    .map((f) => ({ patch: f.patch, type: f.chosen.type, radius: f.chosen.radius, axis: f.chosen.axis && [...f.chosen.axis], point: f.chosen.point && [...f.chosen.point] }));
  let vecs = problem.free.map((f) => [...f.seed]);
  const baselineEnergy = energyOf(problem, vecs);
  const baselineTopo = checkpoint(problem, vecs).snap;
  const seedsBefore = seedTrimIds(problem.overrides);
  const log = [];
  const keepStarts = opts.keepStarts ?? 3;
  const stage1Iters = opts.stage1Iters ?? 8;
  const sweeps = opts.sweeps ?? 8;

  for (let i = 0; i < problem.free.length; i++) {
    const rec = problem.free[i];
    const starts = localStarts(rec, problem);
    const ranked = starts.map((vec) => {
      const trial = vecs.map((v) => [...v]);
      trial[i] = vec;
      return { vec, energy: energyOf(problem, trial) };
    }).sort((a, b) => a.energy.total - b.energy.total);
    let bestLocal = { vecs, energy: energyOf(problem, vecs) };
    for (const cand of ranked.slice(0, keepStarts)) {
      const trial0 = vecs.map((v) => [...v]);
      trial0[i] = cand.vec;
      const descended = coordinateDescent(problem, trial0, i, { iters: stage1Iters, step0: 0.05 });
      if (descended.energy.total < bestLocal.energy.total) bestLocal = descended;
    }
    const chk = checkpoint(problem, bestLocal.vecs);
    const worse = topoWorse(baselineTopo, chk.snap);
    const keep = !worse && bestLocal.energy.total <= energyOf(problem, vecs).total + 1e-9;
    log.push({
      stage: 'E-local',
      patch: rec.patch,
      family: rec.family,
      decision: keep ? 'keep' : 'rollback',
      reason: worse || (keep ? 'energy-decreased' : 'no-improvement'),
      topology: chk.snap,
      totalBefore: energyOf(problem, vecs).total,
      totalAfter: bestLocal.energy.total,
    });
    if (keep) vecs = bestLocal.vecs;
  }

  let joint = energyOf(problem, vecs);
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let next = vecs;
    for (let i = 0; i < problem.free.length; i++) {
      next = coordinateDescent(problem, next, i, { iters: opts.iters ?? 4, step0: 0.025 }).vecs;
    }
    const e = energyOf(problem, next);
    const chk = checkpoint(problem, next);
    const worse = topoWorse(baselineTopo, chk.snap);
    const keep = !worse && e.total + 1e-12 < joint.total;
    log.push({
      stage: 'E-sweep',
      sweep,
      decision: keep ? 'keep' : 'rollback',
      reason: worse || (keep ? 'energy-decreased' : 'trust-region-hold'),
      terms: e.terms,
      totalAfter: e.total,
      topology: chk.snap,
    });
    if (keep) {
      vecs = next;
      joint = e;
    }
  }

  if (opts.skipSeed !== true) tryReplaceSeedTrims(problem, vecs, log, baselineTopo);
  const regen = regenerateMissing(problem, vecs);
  log.push({ stage: 'E-regen', decision: regen.accepted ? 'keep' : 'rollback', reason: regen.reason });
  if (regen.accepted) problem.overrides = regen.overrides;
  if (opts.skipSeed !== true) tryReplaceSeedTrims(problem, vecs, log, baselineTopo);

  const finalFits = attachLocalResiduals(problem, vecs);
  for (const rec of problem.free) {
    const f = finalFits.find((x) => x.patch === rec.patch);
    if (!f?.chosen) continue;
    if (rec.acceptedUnlock) {
      f.topologyProbe = false;
      f.acceptedGeometry = true;
    }
  }
  const finalState = topologyMetrics(raw, correspondence, finalFits, { branchOverrides: problem.overrides });
  const finalSnap = snapTopo(finalState);
  problem.weights = { ...OPT_WEIGHTS };
  const mapped = vecsFromMap(problem, vecsByPatch(problem, vecs));
  const finalEnergy = energyOf({ ...problem, fits: finalFits }, mapped);
  const seedsAfter = seedTrimIds(problem.overrides);
  const feasibility = {};
  for (const rec of problem.free) {
    const idx = problem.free.indexOf(rec);
    const adj = realAdjCount(problem, vecs, rec.patch);
    const fit = finalFits.find((f) => f.patch === rec.patch);
    const bRms = fit?.chosen?.mateBRms ?? Infinity;
    const feasible = adj.missing.length === 0;
    feasibility[rec.patch] = {
      currentCarrierFamilyFeasible: feasible,
      topologyFeasible: !topoWorse(baselineTopo, finalSnap),
      family: rec.family,
      missingRealIntersections: adj.missing,
      cubeB: bRms,
    };
    if (!feasible && rec.family === 'generalQuadric') {
      log.push({
        stage: 'E-classify',
        patch: rec.patch,
        decision: 'infeasible-family',
        reason: 'constrained-quadric-floor',
        missingRealIntersections: adj.missing,
      });
    }
  }
  const othersFrozen = frozenOthers.every((a) => {
    const f = finalFits.find((x) => x.patch === a.patch);
    if (!f?.chosen || f.chosen.type !== a.type) return false;
    if (a.radius != null && f.chosen.radius != null && Math.abs(a.radius - f.chosen.radius) > 1e-12) return false;
    if (a.point && f.chosen.point && a.point.some((v, i) => Math.abs(v - f.chosen.point[i]) > 1e-12)) return false;
    return true;
  });
  return {
    schema: 'dual-cube-selective-repair',
    version: 1,
    unlockPatches,
    note: 'Selective accepted-carrier unlock. Branch topology and unrelated accepted carriers stay frozen. CPU owns checkpoints.',
    success: finalSnap.openEdges === 0 && finalSnap.shells === 8 && finalSnap.nonmanifold === 0 && finalSnap.unexplained === 0,
    baseline: { energy: baselineEnergy, topology: baselineTopo, seedSupportedTrims: seedsBefore },
    final: { energy: finalEnergy, topology: finalSnap, seedSupportedTrims: seedsAfter },
    feasibility,
    othersFrozen,
    log,
    branchOverrides: problem.overrides,
    fits: finalFits,
    carrierStatus: carrierStatuses(finalFits, finalState),
  };
}

export function selectiveUnlock(raw, correspondence, insertion, opts = {}) {
  const order = opts.order || [['S6'], ['S96'], ['S50'], ['S21']];
  let fits = insertion.fits;
  let overrides = insertion.branchOverrides || {};
  const stages = [];
  const log = [];
  for (const group of order) {
    const report = selectiveRepair(raw, correspondence, { fits, branchOverrides: overrides }, {
      ...opts,
      unlockPatches: group,
      weights: (group.length === 1 && (group[0] === 'S6' || group[0] === 'S96')) ? E1_WEIGHTS : E2_WEIGHTS,
    });
    stages.push({
      unlockPatches: group,
      success: report.success,
      topology: report.final?.topology,
      seedSupportedTrims: (report.final?.seedSupportedTrims || []).length,
      feasibility: report.feasibility,
      othersFrozen: report.othersFrozen,
      energy: report.final?.energy?.terms,
    });
    log.push(...(report.log || []).map((e) => ({ ...e, group })));
    if (report.fits) fits = report.fits;
    if (report.branchOverrides) overrides = report.branchOverrides;
  }
  const s50 = stages.find((s) => s.unlockPatches.includes('S50'));
  if (s50?.feasibility?.S50 && s50.feasibility.S50.currentCarrierFamilyFeasible === false) {
    const coupled = selectiveRepair(raw, correspondence, { fits, branchOverrides: overrides }, {
      ...opts,
      unlockPatches: ['S50', 'S49'],
      weights: E2_WEIGHTS,
    });
    stages.push({
      unlockPatches: ['S50', 'S49'],
      success: coupled.success,
      topology: coupled.final?.topology,
      seedSupportedTrims: (coupled.final?.seedSupportedTrims || []).length,
      feasibility: coupled.feasibility,
      othersFrozen: coupled.othersFrozen,
      energy: coupled.final?.energy?.terms,
      note: 'E3 coupled neighborhood after S50 family floor',
    });
    log.push(...(coupled.log || []).map((e) => ({ ...e, group: ['S50', 'S49'] })));
    if (coupled.fits) fits = coupled.fits;
    if (coupled.branchOverrides) overrides = coupled.branchOverrides;
  }
  const last = stages[stages.length - 1] || {};
  const seedTrims = seedTrimIds(overrides);
  const remainingProbe = fits.filter((f) => f.topologyProbe && f.chosen).length;
  return {
    schema: 'dual-cube-selective-unlock',
    version: 1,
    note: 'Phase E: unlock S6, then S96, then constrained S50/S21. Unrelated accepted carriers stay frozen. Topology rollbacks remain hard.',
    success: last.success && seedTrims.length === 0,
    stages,
    gate: {
      openEdges: last.topology?.openEdges,
      shells: last.topology?.shells,
      nonmanifoldEdges: last.topology?.nonmanifold,
      unexplainedEdges: last.topology?.unexplained,
      seedSupportedTrims: seedTrims.length,
      provisionalCarriers: remainingProbe,
    },
    seedSupportedTrims: seedTrims,
    log,
    branchOverrides: overrides,
    fits,
    carrierStatus: last.unlockPatches ? carrierStatuses(fits, topologyMetrics(raw, correspondence, fits, { branchOverrides: overrides })) : [],
  };
}
