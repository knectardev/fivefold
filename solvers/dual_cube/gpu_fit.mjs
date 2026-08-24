/**
 * Batched analytic opening fitting: CPU oracle + optional WebGPU residuals.
 *
 *   node solvers/dual_cube/gpu_fit.mjs
 *   node solvers/dual_cube/gpu_fit.mjs solvers/dual_cube/results/candidate_N6_P8_connected.json --write
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { analyzePhysicalCorrespondence, buildCorrespondence } from './physical_correspondence.mjs';
import { fitOpeningsBatched, evaluateJobsCpu, proposeUnresolvedFits } from './gpu_fit_cpu.mjs';
import { resultsClose } from './gpu_fit_protocol.mjs';
import { initGpuFitter, evaluateJobsGpu } from './gpu_fit_webgpu.mjs';
import { buildClosureView } from './closure_view.mjs';

export {
  fitOpeningsBatched,
  evaluateJobsCpu,
  buildOpeningBatch,
  proposeUnresolvedFits,
  unresolvedPatchIds,
} from './gpu_fit_cpu.mjs';
export { initGpuFitter, evaluateJobsGpu, gpuFitStatus } from './gpu_fit_webgpu.mjs';
export {
  packFitBatch,
  unpackFitBatch,
  resultsClose,
} from './gpu_fit_protocol.mjs';

export async function scoreBatchWithGpu(packed, { compare = true } = {}) {
  const cpu = evaluateJobsCpu(packed);
  const gpuState = await initGpuFitter();
  if (!gpuState.ok) {
    return {
      backend: 'cpu',
      gpu: gpuState,
      results: cpu,
      compared: false,
      match: null,
    };
  }
  const t0 = performance.now();
  const gpu = await evaluateJobsGpu(packed);
  const gpuMs = performance.now() - t0;
  const t1 = performance.now();
  evaluateJobsCpu(packed);
  const cpuMs = performance.now() - t1;
  const match = compare ? resultsClose(cpu, gpu) : null;
  return {
    backend: match === false ? 'cpu' : 'webgpu',
    gpu: gpuState,
    results: match === false ? cpu : gpu,
    cpu,
    gpuResults: gpu,
    compared: true,
    match,
    gpuMs,
    cpuMs,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const jsonArg = process.argv.find((a) => a.endsWith('.json') && !a.startsWith('--'))
    || 'solvers/dual_cube/results/candidate_N6_P8_connected.json';
  const write = process.argv.includes('--write');
  const unresolved = process.argv.includes('--unresolved');
  const raw = JSON.parse(readFileSync(jsonArg, 'utf8'));
  if (unresolved) {
    const correspondence = buildCorrespondence(raw);
    const proposals = proposeUnresolvedFits(correspondence);
    const gpu = await scoreBatchWithGpu(proposals.packed);
    const out = {
      schema: 'dual-cube-opening-proposals',
      version: 1,
      input: jsonArg,
      pass: 'unresolved-14',
      topologyModified: false,
      backend: gpu.backend,
      gpu: gpu.gpu,
      compared: gpu.compared,
      cpuGpuMatch: gpu.match,
      openingCount: proposals.openingCount,
      jobCount: proposals.jobCount,
      proposedCount: proposals.proposedCount,
      fitGateCount: proposals.fitGateCount,
      topologyUnchanged: true,
      patchIds: proposals.patchIds,
      proposals: proposals.proposals.map((p) => ({
        patch: p.patch,
        piece: p.piece,
        planeRMS: p.planeRMS,
        proposed: p.proposed,
        fitGate: p.fitGate,
        rejectReason: p.rejectReason,
        chosen: p.chosen,
        familiesScored: p.familiesScored,
        initsScored: p.initsScored,
        jobCount: p.jobCount,
        tried: p.tried,
      })),
      note: 'Second batched GPU/CPU fit of unresolved openings only. Carriers are proposed. Topology is unchanged until a later transactional CPU insert.',
    };
    const reportPath = jsonArg.replace(/\.json$/i, '.openings14.json');
    writeFileSync(reportPath, JSON.stringify(out, null, 2));
    console.log(JSON.stringify({
      output: reportPath,
      backend: out.backend,
      gpu: out.gpu?.reason ?? 'cpu',
      topologyModified: false,
      openings: out.openingCount,
      jobs: out.jobCount,
      proposed: out.proposedCount,
      fitGate: out.fitGateCount,
      patches: out.proposals.map((p) => ({
        patch: p.patch,
        proposed: p.proposed,
        fitGate: p.fitGate,
        rejectReason: p.rejectReason,
        type: p.chosen?.type || null,
        rms: p.chosen?.rms ?? null,
        mateBRms: p.chosen?.mateBRms ?? null,
        families: p.familiesScored,
      })),
    }, null, 2));
  } else {
  const report = analyzePhysicalCorrespondence(raw, { batchedFit: true });
  const batchRun = fitOpeningsBatched(buildCorrespondence(raw));
  const gpu = await scoreBatchWithGpu(batchRun.packed);
  const fitted = report.jointFits.filter((f) => f.chosen).length;
  const unfitted = report.jointFits.filter((f) => !f.chosen).length;
  const out = {
    schema: 'dual-cube-gpu-fit-report',
    version: 1,
    input: jsonArg,
    cadEligible: report.cadEligible,
    backend: gpu.backend,
    gpu: gpu.gpu,
    gpuFit: report.gpuFit,
    insertion: report.insertion,
    junctionByCarrierCount: report.closure?.junctions?.byCarrierCount ?? null,
    junctionNewlyFitted: report.closure?.junctions?.newlyFitted ?? null,
    compared: gpu.compared,
    cpuGpuMatch: gpu.match,
    gpuMs: gpu.gpuMs ?? null,
    cpuMs: gpu.cpuMs ?? null,
    openings: batchRun.openingCount,
    jobs: batchRun.jobCount,
    selected: batchRun.selectedCount,
    inserted: report.insertion?.acceptedCount ?? null,
    rolledBack: report.insertion?.rejectedCount ?? null,
    baseline: report.insertion?.baseline ?? null,
    final: report.insertion?.final ?? null,
    openEdges: report.insertion?.openEdges ?? report.closure?.metrics?.shellClosure?.openEdgeAttribution ?? null,
    junctions: {
      rms: report.closure?.junctions.rms ?? null,
      max: report.closure?.junctions.max ?? null,
      byCarrierCount: report.closure?.junctions.byCarrierCount ?? null,
      newlyFitted: report.closure?.junctions.newlyFitted ?? null,
    },
    fitted,
    unfitted,
    families: report.jointFits.filter((f) => f.chosen).reduce((m, f) => {
      m[f.chosen.type] = (m[f.chosen.type] || 0) + 1;
      return m;
    }, {}),
    pieces: report.closure?.pieces.map((p) => ({
      piece: p.piece,
      shells: p.shells,
      openEdges: p.openEdges,
      connectedSolid: p.connectedSolid,
      openings: p.unresolvedCurvedOpenings,
    })) ?? null,
    metrics: report.closure?.metrics ?? null,
    note: 'Topology and shell stitching stay on the CPU. WebGPU scores batched sphere/cylinder/cone/quadric residuals. Search matching is not GPU-accelerated.',
  };
  const reportPath = jsonArg.replace(/\.json$/i, '.gpufit.json');
  writeFileSync(reportPath, JSON.stringify(out, null, 2));
  if (write && report.closure) {
    writeFileSync(jsonArg.replace(/\.json$/i, '.correspondence.json'), JSON.stringify(report, null, 2));
    writeFileSync(jsonArg.replace(/\.json$/i, '.closure.json'), JSON.stringify(report.closure, null, 2));
    if (report.insertion?.trimRepair?.overrides) {
      writeFileSync(jsonArg.replace(/\.json$/i, '.trim_overrides.json'), JSON.stringify({
        schema: 'dual-cube-trim-overrides',
        version: 1,
        overrides: report.insertion.trimRepair.overrides,
      }, null, 2));
    }
    writeFileSync(jsonArg.replace(/\.json$/i, '.closure_view.json'), JSON.stringify(buildClosureView(raw, report)));
  }
  console.log(JSON.stringify({
    output: reportPath,
    backend: out.backend,
    gpu: out.gpu?.reason ?? 'cpu',
    match: out.cpuGpuMatch,
    openings: out.openings,
    jobs: out.jobs,
    fitted: out.fitted,
    unfitted: out.unfitted,
    inserted: out.inserted,
    rolledBack: out.rolledBack,
    baseline: out.baseline,
    final: out.final,
    openEdges: out.openEdges,
    families: out.families,
    junctions: out.junctions,
    mateB: report.closure?.metrics?.continuousTrimMismatch ?? null,
    shells: out.pieces,
  }, null, 2));
  }
}
