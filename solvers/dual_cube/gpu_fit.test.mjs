import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitSphere } from './joint_quadrics.mjs';
import {
  packFitBatch,
  unpackFitBatch,
  packSurfaceParams,
  FAMILY,
  resultsClose,
  packFitResults,
  unpackFitResults,
} from './gpu_fit_protocol.mjs';
import { evaluateJobsCpu, fitOpeningsBatched, proposeUnresolvedFits } from './gpu_fit_cpu.mjs';
import { analyzePhysicalCorrespondence, buildCorrespondence } from './physical_correspondence.mjs';
import { initGpuFitter, evaluateJobsGpu, gpuFitStatus } from './gpu_fit_webgpu.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const candidate = (name) => JSON.parse(readFileSync(join(dir, 'results', name), 'utf8'));

function sphereCloud() {
  const pts = [];
  for (let i = 0; i < 30; i++) {
    const th = (i / 30) * Math.PI;
    const ph = i * 0.7;
    pts.push([
      0.5 + 0.2 * Math.sin(th) * Math.cos(ph),
      0.5 + 0.2 * Math.sin(th) * Math.sin(ph),
      0.5 + 0.2 * Math.cos(th),
    ]);
  }
  return pts;
}

test('packed fit batch round-trips samples and jobs', () => {
  const pts = sphereCloud();
  const sph = fitSphere(pts);
  const samples = [...pts, ...pts.map((p) => [p[0] + 0.001, p[1], p[2]])];
  const packed = packFitBatch({
    samples,
    jobs: [{
      family: FAMILY.sphere,
      aStart: 0,
      aCount: pts.length,
      bStart: pts.length,
      bCount: pts.length,
      loopStart: 0,
      loopCount: pts.length,
      opening: 0,
      params: packSurfaceParams(sph),
    }],
  });
  const back = unpackFitBatch(packed);
  assert.equal(back.sampleCount, samples.length);
  assert.equal(back.jobCount, 1);
  assert.equal(back.jobs[0].family, FAMILY.sphere);
  assert.equal(back.jobs[0].aCount, 30);
});

test('CPU batched residuals recover a known sphere', () => {
  const pts = sphereCloud();
  const sph = fitSphere(pts);
  const packed = packFitBatch({
    samples: pts,
    jobs: [{
      family: FAMILY.sphere,
      aStart: 0,
      aCount: pts.length,
      bStart: 0,
      bCount: pts.length,
      loopStart: 0,
      loopCount: pts.length,
      opening: 0,
      params: packSurfaceParams(sph),
    }],
  });
  const [row] = evaluateJobsCpu(packed);
  assert.equal(row.degeneracy, 0);
  assert.ok(row.fitRms < 0.002);
  assert.ok(row.mateBRms < 0.002);
  assert.equal(row.penalty, 0);
});

test('result pack/unpack is stable', () => {
  const rows = [{
    fitRms: 0.01, fitMax: 0.02, mateARms: 0.01, mateAMax: 0.02,
    mateBRms: 0.03, mateBMax: 0.04, boundaryRms: 0.015, penalty: 0.12,
    score: 0.05, degeneracy: 0,
  }];
  const back = unpackFitResults(packFitResults(rows));
  assert.equal(resultsClose(rows, back, 1e-6, 1e-6), true);
});

test('batched engine scores every curved opening on the connected N=6 candidate', () => {
  const correspondence = buildCorrespondence(candidate('candidate_N6_P8_connected.json'));
  const run = fitOpeningsBatched(correspondence);
  assert.ok(run.openingCount >= 19);
  assert.ok(run.jobCount >= run.openingCount);
  assert.equal(run.results.length, run.jobCount);
  assert.ok(run.results.every((r) => Number.isFinite(r.fitRms) || r.degeneracy));
});

test('second batched pass scores exactly the 14 unresolved openings without changing topology', () => {
  const raw = candidate('candidate_N6_P8_connected.json');
  const correspondence = buildCorrespondence(raw);
  const first = fitOpeningsBatched(correspondence);
  const unfitted = first.fits.filter((f) => !f.chosen).map((f) => f.patch);
  assert.equal(unfitted.length, 14);
  const second = proposeUnresolvedFits(correspondence, { priorFits: first.fits });
  assert.equal(second.openingCount, 14);
  assert.deepEqual(second.patchIds.slice().sort(), unfitted.slice().sort());
  assert.equal(second.proposedCount, 14);
  assert.equal(second.fitGateCount, 4);
  for (const p of second.proposals) {
    assert.equal(p.proposed, true, p.patch);
    assert.ok(p.chosen, p.patch);
    for (const fam of ['sphere', 'cylinder', 'cone', 'generalQuadric']) {
      assert.ok(p.familiesScored.includes(fam), `${p.patch} missing ${fam}`);
    }
    assert.ok(p.initsScored.includes('samplesA'));
    assert.ok(p.initsScored.includes('samplesB'));
  }
  const report = analyzePhysicalCorrespondence(raw);
  assert.equal(report.insertion.final.openEdges, 86);
  assert.equal(report.insertion.openEdges.explainedByFittedUntrimmed, 0);
});

test('CAD-eligible connected N=6 uses batched fitting and transactional insertion', () => {
  const report = analyzePhysicalCorrespondence(candidate('candidate_N6_P8_connected.json'));
  assert.equal(report.cadEligible, true);
  assert.ok(report.gpuFit);
  assert.equal(report.gpuFit.engine, 'batched');
  assert.ok(report.gpuFit.jobs >= 19);
  assert.ok(report.insertion);
  assert.ok(report.insertion.final.nonmanifold <= report.insertion.baseline.nonmanifold);
  assert.ok(report.insertion.final.openEdges <= report.insertion.baseline.openEdges);
  const fitted = report.jointFits.filter((f) => f.chosen).length;
  assert.equal(fitted, report.insertion.acceptedCount);
});

test('WebGPU residuals match the CPU oracle when an adapter exists', {
  skip: globalThis.navigator?.gpu ? false : 'navigator.gpu is not available in this Node runtime',
}, async () => {
  const loaded = await initGpuFitter();
  assert.equal(loaded.ok, true, loaded.reason);
  assert.equal(gpuFitStatus().ready, true);
  const pts = sphereCloud();
  const packed = packFitBatch({
    samples: pts,
    jobs: [{
      family: FAMILY.sphere,
      aStart: 0,
      aCount: pts.length,
      bStart: 0,
      bCount: pts.length,
      loopStart: 0,
      loopCount: pts.length,
      opening: 0,
      params: packSurfaceParams(fitSphere(pts)),
    }],
  });
  const cpu = evaluateJobsCpu(packed);
  const gpu = await evaluateJobsGpu(packed);
  assert.equal(resultsClose(cpu, gpu), true);
});
