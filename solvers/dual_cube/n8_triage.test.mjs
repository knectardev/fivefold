import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareKey } from './exact_cover_kernel.mjs';
import { analyzePhysicalCorrespondence, buildCorrespondence } from './physical_correspondence.mjs';
import { n8Preflight } from './n8_preflight.mjs';
import {
  N8_COMPLEXITY_BUDGET,
  oppositeBuckets,
  classifyNeighborhood,
  triageN8,
  decideGoNoGo,
  analyticDifficultyOfCandidate,
} from './n8_triage.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const n8 = JSON.parse(readFileSync(join(dir, 'results', 'candidate_N8_P8_connected.json'), 'utf8'));
const n6 = JSON.parse(readFileSync(join(dir, 'results', 'candidate_N6_P8_connected.json'), 'utf8'));

test('default N=6 analyzer still reports the locked 86-edge gate', () => {
  const report = analyzePhysicalCorrespondence(n6);
  assert.equal(report.insertion.final.openEdges, 86);
});

test('N=8 triage classifies all 13 neighborhoods and sets a go/no-go', () => {
  const report = triageN8(n8);
  assert.equal(report.neighborhoods.length, 13);
  for (const n of report.neighborhoods) {
    assert.ok(['A', 'B', 'C', 'D'].includes(n.category), n.patch);
    assert.ok(n.piece >= 1 && n.piece <= 8);
    assert.ok(Array.isArray(n.patchesInvolved) && n.patchesInvolved.length >= 1);
    assert.ok(n.cubeA);
    assert.ok(n.cubeB);
  }
  const cats = report.decision.categories;
  assert.equal(cats.A + cats.B + cats.C + cats.D, 13);
  assert.equal(typeof report.decision.go, 'boolean');
  assert.equal(report.reconstruction.allowed, report.decision.go);
  if (!report.decision.go) {
    assert.ok(!report.reconstruction.stages.includes('global-residual-optimization'));
  }
});

test('S2 is a many-bucket split and S39 is a tiny-leftover correspondence revision', () => {
  const correspondence = buildCorrespondence(n8);
  const pre = n8Preflight(n8);
  const s2row = pre.contradictoryNeighborhoods.find((r) => r.patch === 'S2');
  const s39row = pre.contradictoryNeighborhoods.find((r) => r.patch === 'S39');
  const s2 = classifyNeighborhood(s2row, correspondence.patches);
  const s39 = classifyNeighborhood(s39row, correspondence.patches);
  const { buckets } = oppositeBuckets(correspondence.patches.find((p) => p.id === 'S2'), correspondence.patches);
  assert.ok(buckets.length >= 3, 'S2 maps onto several opposite patches');
  assert.equal(s2.category, 'D');
  assert.ok(s2.additionalCarriers >= 2);
  assert.equal(s39.category, 'C');
  assert.equal(s39.additionalCarriers, 0);
});

test('complexity budget is explicit and decideGoNoGo fails on category D', () => {
  assert.equal(N8_COMPLEXITY_BUDGET.maxNewCarriers, 8);
  assert.equal(N8_COMPLEXITY_BUDGET.maxChildrenPerCarrier, 3);
  assert.equal(N8_COMPLEXITY_BUDGET.minChildFaces, 3);
  assert.equal(N8_COMPLEXITY_BUDGET.maxNewGeneralQuadrics, 2);
  const fake = [
    { category: 'B', additionalCarriers: 1, newGeneralQuadrics: 0, minChildFaces: 4, localSplit: true, mirroredAcrossMate: true },
    { category: 'D', additionalCarriers: 4, newGeneralQuadrics: 3, minChildFaces: 1, localSplit: true, mirroredAcrossMate: false },
  ];
  const d = decideGoNoGo(fake);
  assert.equal(d.go, false);
});

test('compareKey prefers lower analytic difficulty after volume', () => {
  const a = {
    connected: 8,
    counts: [64, 64, 64, 64, 64, 64, 64, 64],
    minVol: 64 / 512,
    maxVol: 64 / 512,
    fragileRatio: 0.02,
    roughA: 0.5,
    roughB: 0.5,
    imbalance: 0,
    regularity: 0,
    similarity: 0.2,
    adjacencyDifference: 0.1,
    moved: 8,
    analyticDifficulty: 100,
  };
  const b = { ...a, analyticDifficulty: 900 };
  assert.ok(compareKey(a, b, 8) < 0);
});

test('analytic difficulty of the N=8 occupancy is positive', () => {
  const d = analyticDifficultyOfCandidate(n8, 8, 8);
  assert.ok(d.score > 0);
  assert.ok(d.signals.contradictoryNeighborhoods >= 13);
});
