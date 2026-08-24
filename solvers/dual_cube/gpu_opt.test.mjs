import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateJobsCpu } from './gpu_fit_cpu.mjs';
import { unpackFitBatch } from './gpu_fit_protocol.mjs';
import {
  vecFromChosen,
  chosenFromVec,
  packTrialJobs,
  spherePlaneGap,
  projectSphereToPlane,
  OPT_MARGIN,
} from './gpu_opt_protocol.mjs';
import { buildCorrespondence } from './physical_correspondence.mjs';
import { insertOpeningProposals } from './insert_carriers.mjs';
import { optimizeProvisionals, energyOf, buildOptProblem, rankProvisionals, continueProvisionals, CONTINUATION_STAGES, selectiveRepair } from './gpu_opt_cpu.mjs';
import { planeSphereCircle } from './analytic_junctions.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const candidate = (name) => JSON.parse(readFileSync(join(dir, 'results', name), 'utf8'));

test('sphere/cylinder parameter vectors round-trip', () => {
  const sph = { type: 'sphere', center: [0.5, 0.4, 0.3], radius: 0.2 };
  const back = chosenFromVec(sph, vecFromChosen(sph));
  assert.deepEqual(back.center, sph.center);
  assert.equal(back.radius, sph.radius);
  const cyl = { type: 'cylinder', axis: [0, 2, 0], point: [0.1, 0, 0], radius: 0.15 };
  const c2 = chosenFromVec(cyl, vecFromChosen(cyl));
  assert.ok(Math.abs(c2.axis[1] - 1) < 1e-12);
  assert.equal(c2.radius, 0.15);
});

test('S74-style sphere-plane gap is a feasibility hinge, not a seed residual', () => {
  const plane = { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1] };
  const center = [0.5, 0.5, 0.5];
  const radius = 0.2;
  const gap = spherePlaneGap(center, radius, plane);
  assert.ok(gap > 0.2, 'center z=0.5, r=0.2 cannot meet z=0');
  assert.equal(planeSphereCircle(plane, { center, radius }), null);
  const projected = projectSphereToPlane([...center, radius], plane);
  assert.equal(spherePlaneGap(projected.slice(0, 3), projected[3], plane) < 1e-9, true);
  const cir = planeSphereCircle(plane, { center: projected.slice(0, 3), radius: projected[3] });
  assert.ok(cir, 'projected sphere must produce a real circle');
  assert.ok(cir.radius > OPT_MARGIN * 0.5);
});

test('packed trial jobs reuse the BFG1 residual ABI', () => {
  const pts = [[0.5, 0.5, 0.3], [0.4, 0.5, 0.3], [0.6, 0.5, 0.3]];
  const packed = packTrialJobs([{
    family: 'sphere',
    samplesA: pts,
    samplesB: pts,
    loop: pts,
    surface: { type: 'sphere', center: [0.5, 0.5, 0.3], radius: 0.1 },
  }]);
  const back = unpackFitBatch(packed.packed);
  assert.equal(back.jobCount, 1);
  const [row] = evaluateJobsCpu(packed.packed);
  assert.equal(row.degeneracy, 0);
  assert.ok(Number.isFinite(row.fitRms));
});

test('provisional-only global opt does not worsen the eight-shell topology', () => {
  const raw = candidate('candidate_N6_P8_connected.json');
  const correspondence = buildCorrespondence(raw);
  const insertion = insertOpeningProposals(raw, correspondence);
  assert.equal(insertion.final.openEdges, 1);
  assert.equal(insertion.final.shells, 8);
  const report = optimizeProvisionals(raw, correspondence, insertion, {
    stage1Iters: 5,
    stage2Sweeps: 4,
    keepStarts: 2,
  });
  assert.equal(report.final.topology.nonmanifold, 0);
  assert.equal(report.final.topology.unexplained, 0);
  assert.equal(report.final.topology.piece5Closed, true);
  assert.equal(report.final.topology.shells, 8);
  assert.ok(report.final.topology.openEdges <= insertion.final.openEdges);
  assert.ok(report.s74);
  assert.equal(report.s74.familyTried, 'sphere');
  assert.equal(typeof report.s74.familyFeasible, 'boolean');
  assert.equal(report.s74.topologyStillValid, true);
  const problem = buildOptProblem(raw, correspondence, insertion);
  const e0 = energyOf(problem, problem.free.map((f) => f.seed));
  assert.ok(e0.terms.intersection > 0, 'S74 missing intersection must contribute');
  assert.ok(report.final.energy.terms.intersection <= e0.terms.intersection + 1e-9);
});

test('rankProvisionals reports Cube A/B, junctions, seed trims, and real intersections', () => {
  const raw = candidate('candidate_N6_P8_connected.json');
  const correspondence = buildCorrespondence(raw);
  const insertion = insertOpeningProposals(raw, correspondence);
  const problem = buildOptProblem(raw, correspondence, insertion);
  const rank = rankProvisionals(problem, problem.free.map((f) => [...f.seed]), { skipSensitivity: true });
  assert.equal(rank.length, problem.free.length);
  assert.equal(rank.length, 10);
  for (const row of rank) {
    assert.equal(typeof row.patch, 'string');
    assert.equal(typeof row.cubeA.rms, 'number');
    assert.equal(typeof row.cubeB.rms, 'number');
    assert.equal(typeof row.junctionRms, 'number');
    assert.equal(typeof row.seedSupportedTrims, 'number');
    assert.equal(typeof row.realIntersection, 'boolean');
  }
  for (let i = 1; i < rank.length; i++) {
    assert.ok(rank[i - 1].cubeB.rms + 1e-12 >= rank[i].cubeB.rms);
  }
  assert.ok(CONTINUATION_STAGES.map((s) => s.id).join('') === 'ABCD');
});

test('continuation keeps accepted carriers frozen and does not worsen closed topology', () => {
  const raw = candidate('candidate_N6_P8_connected.json');
  const correspondence = buildCorrespondence(raw);
  const insertion = insertOpeningProposals(raw, correspondence);
  const first = optimizeProvisionals(raw, correspondence, insertion, {
    stage1Iters: 3,
    stage2Sweeps: 2,
    keepStarts: 1,
  });
  const s6Before = first.fits.find((f) => f.patch === 'S6');
  const report = continueProvisionals(raw, correspondence, {
    fits: first.fits,
    branchOverrides: first.branchOverrides,
  }, {
    skipSensitivity: true,
    skipFamily: true,
    skipSeed: true,
    stages: CONTINUATION_STAGES.slice(0, 1).map((s) => ({ ...s, sweeps: 1, iters: 2, focusCount: 3 })),
  });
  assert.equal(report.final.topology.nonmanifold, 0);
  assert.equal(report.final.topology.unexplained, 0);
  assert.equal(report.final.topology.piece5Closed, true);
  assert.equal(report.final.topology.shells, 8);
  assert.ok(report.final.topology.openEdges <= first.final.topology.openEdges);
  assert.equal(report.acceptedCarriersFrozen, true);
  const s6After = report.fits.find((f) => f.patch === 'S6');
  assert.ok(!s6After.topologyProbe);
  assert.equal(s6After.acceptedGeometry !== false, true);
  assert.equal(s6After.chosen.radius, s6Before.chosen.radius);
  assert.ok(report.ranking.length >= 1);
  assert.ok(Array.isArray(report.constraints));
});

test('selective S6 unlock keeps topology and unrelated accepted carriers frozen', () => {
  const raw = candidate('candidate_N6_P8_connected.json');
  const correspondence = buildCorrespondence(raw);
  const insertion = insertOpeningProposals(raw, correspondence);
  const first = optimizeProvisionals(raw, correspondence, insertion, {
    stage1Iters: 3,
    stage2Sweeps: 2,
    keepStarts: 1,
  });
  const s96Before = first.fits.find((f) => f.patch === 'S96');
  const s6Before = first.fits.find((f) => f.patch === 'S6');
  const report = selectiveRepair(raw, correspondence, {
    fits: first.fits,
    branchOverrides: first.branchOverrides,
  }, {
    unlockPatches: ['S6'],
    stage1Iters: 4,
    sweeps: 3,
    keepStarts: 2,
    skipSeed: false,
  });
  assert.equal(report.final.topology.nonmanifold, 0);
  assert.equal(report.final.topology.unexplained, 0);
  assert.equal(report.final.topology.shells, 8);
  assert.ok(report.final.topology.openEdges <= first.final.topology.openEdges);
  assert.equal(report.othersFrozen, true);
  const s6 = report.fits.find((f) => f.patch === 'S6');
  const s96 = report.fits.find((f) => f.patch === 'S96');
  assert.equal(s6.chosen.type, 'cylinder');
  assert.equal(s6Before.chosen.type, 'cylinder');
  assert.equal(s96.chosen.radius, s96Before.chosen.radius);
  assert.equal(typeof report.feasibility.S6.currentCarrierFamilyFeasible, 'boolean');
});
