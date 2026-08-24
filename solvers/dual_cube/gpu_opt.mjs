/**
 * Global GPU/CPU optimization of provisional N=6 carriers.
 *
 *   node solvers/dual_cube/gpu_opt.mjs
 *   node solvers/dual_cube/gpu_opt.mjs solvers/dual_cube/results/candidate_N6_P8_connected.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildCorrespondence } from './physical_correspondence.mjs';
import { insertOpeningProposals } from './insert_carriers.mjs';
import { optimizeProvisionals, continueProvisionals, selectiveUnlock } from './gpu_opt_cpu.mjs';
import { evaluateJobsCpu } from './gpu_fit_cpu.mjs';
import { initGpuFitter } from './gpu_fit_webgpu.mjs';

export {
  optimizeProvisionals,
  continueProvisionals,
  rankProvisionals,
  buildOptProblem,
  energyOf,
  CONTINUATION_STAGES,
  selectiveRepair,
  selectiveUnlock,
} from './gpu_opt_cpu.mjs';
export {
  vecFromChosen,
  chosenFromVec,
  packTrialJobs,
  spherePlaneGap,
  projectSphereToPlane,
} from './gpu_opt_protocol.mjs';

async function batchedEvaluate() {
  const gpu = await initGpuFitter();
  return { evaluateJobs: evaluateJobsCpu, backend: gpu.ok ? 'webgpu' : 'cpu', gpu };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const jsonArg = process.argv.find((a) => a.endsWith('.json') && !a.startsWith('--'))
    || 'solvers/dual_cube/results/candidate_N6_P8_connected.json';
  const raw = JSON.parse(readFileSync(jsonArg, 'utf8'));
  const correspondence = buildCorrespondence(raw);
  const insertion = insertOpeningProposals(raw, correspondence);
  const backend = await batchedEvaluate();
  const continueMode = process.argv.includes('--continue');
  const unlockMode = process.argv.includes('--unlock');
  const opt = optimizeProvisionals(raw, correspondence, insertion, {
    evaluateJobs: backend.evaluateJobs,
  });
  const continued = (continueMode || unlockMode)
    ? continueProvisionals(raw, correspondence, {
      fits: opt.fits,
      branchOverrides: opt.branchOverrides,
    }, {
      evaluateJobs: backend.evaluateJobs,
      constraints: (opt.log || [])
        .filter((e) => e.decision === 'rollback' && e.patch)
        .map((e) => ({ patch: e.patch, reason: e.reason, kind: e.reason, stage: 'opt1' })),
    })
    : opt;
  const report = unlockMode
    ? selectiveUnlock(raw, correspondence, {
      fits: continued.fits,
      branchOverrides: continued.branchOverrides,
    }, { evaluateJobs: backend.evaluateJobs })
    : continued;
  const outPath = jsonArg.replace(/\.json$/i, unlockMode ? '.gpopt-unlock.json' : continueMode ? '.gpopt2.json' : '.gpopt.json');
  const fitRow = (f) => ({
    patch: f.patch,
    type: f.chosen.type,
    acceptedGeometry: f.acceptedGeometry !== false && !f.topologyProbe,
    topologyProbe: !!f.topologyProbe,
    residualGate: f.residualGate || 'pass',
    rms: f.chosen.rms,
    mateARms: f.chosen.mateARms,
    mateBRms: f.chosen.mateBRms,
    center: f.chosen.center,
    point: f.chosen.point,
    radius: f.chosen.radius,
    axis: f.chosen.axis,
    coefficients: f.chosen.coefficients,
  });
  const serializable = unlockMode ? {
    schema: report.schema,
    version: report.version,
    note: report.note,
    backend: backend.backend,
    gpu: backend.gpu,
    success: report.success,
    stages: report.stages,
    gate: report.gate,
    seedSupportedTrims: report.seedSupportedTrims,
    carrierStatus: report.carrierStatus,
    log: (report.log || []).map((e) => ({
      stage: e.stage,
      group: e.group,
      patch: e.patch,
      sweep: e.sweep,
      decision: e.decision,
      reason: e.reason,
      topology: e.topology,
    })),
    fits: report.fits.filter((f) => f.chosen).map(fitRow),
  } : {
    schema: report.schema,
    version: report.version,
    note: report.note,
    backend: backend.backend,
    gpu: backend.gpu,
    success: report.success,
    baseline: {
      energy: report.baseline.energy,
      topology: report.baseline.topology,
    },
    final: {
      energy: report.final.energy,
      topology: report.final.topology,
    },
    gate: report.gate,
    s74: report.s74,
    ranking: report.ranking || null,
    rankingFinal: report.rankingFinal || null,
    constraints: (report.constraints || []).map((c) => ({
      patch: c.patch, reason: c.reason, kind: c.kind, stage: c.stage, familyTried: c.familyTried,
    })),
    acceptedCarriersFrozen: report.acceptedCarriersFrozen,
    promoted: report.promoted,
    remainingProvisional: report.remainingProvisional,
    seedSupportedTrims: report.seedSupportedTrims,
    carrierStatus: report.carrierStatus,
    log: report.log.map((e) => ({
      stage: e.stage,
      patch: e.patch,
      family: e.family,
      sweep: e.sweep,
      decision: e.decision,
      reason: e.reason,
      totalBefore: e.totalBefore,
      totalAfter: e.totalAfter,
      terms: e.terms || e.after,
      topology: e.topology,
    })),
    fits: report.fits.filter((f) => f.chosen).map(fitRow),
  };
  writeFileSync(outPath, JSON.stringify(serializable, null, 2));
  console.log(JSON.stringify(unlockMode ? {
    output: outPath,
    backend: backend.backend,
    success: report.success,
    stages: report.stages,
    gate: report.gate,
    seedSupportedTrims: report.seedSupportedTrims,
  } : {
    output: outPath,
    backend: backend.backend,
    success: report.success,
    baseline: report.baseline.topology,
    final: report.final.topology,
    energy: { before: report.baseline.energy.total, after: report.final.energy.total, terms: report.final.energy.terms },
    gate: report.gate,
    s74: report.s74,
    promoted: report.promoted,
    remainingProvisional: report.remainingProvisional,
    ranking: (report.ranking || []).map((r) => ({
      patch: r.patch,
      family: r.family,
      cubeA: r.cubeA,
      cubeB: r.cubeB,
      seedSupportedTrims: r.seedSupportedTrims,
      realIntersection: r.realIntersection,
      topologySensitive: r.topologySensitive,
    })),
    constraints: (report.constraints || []).map((c) => ({ patch: c.patch, reason: c.reason, kind: c.kind, stage: c.stage })),
    stage1: report.log.filter((e) => e.stage === 1).map((e) => ({
      patch: e.patch,
      decision: e.decision,
      energy: `${Number(e.totalBefore || 0).toFixed(4)}→${Number(e.totalAfter || 0).toFixed(4)}`,
    })),
    continuation: report.log.filter((e) => ['A', 'B', 'C', 'D', 'seed-trim', 'promote', 'family'].includes(e.stage)).map((e) => ({
      stage: e.stage,
      patch: e.patch,
      sweep: e.sweep,
      decision: e.decision,
      reason: e.reason,
    })),
  }, null, 2));
}
