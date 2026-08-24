import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCorrespondence, analyzePhysicalCorrespondence } from './physical_correspondence.mjs';
import {
  MAX_CHILDREN_PER_CARRIER,
  MAX_NEW_CARRIERS,
  MIN_CHILD_FACES,
  ATTEMPT_A,
  assignFacesToHinges,
  splitPairedPatches,
  extractNonMateFaces,
  reviseMateToOverlap,
  complexityReport,
  attemptPasses,
} from './carrier_split.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(dir, 'results', 'candidate_N6_P8_connected.json'), 'utf8'));

test('default analyzer still reports the locked 86-edge gate', () => {
  const report = analyzePhysicalCorrespondence(raw);
  assert.equal(report.insertion.final.openEdges, 86);
  assert.equal(report.closure.metrics.shellClosure.openEdges, 86);
});

test('paired S6/S96 hinge split mirrors mates and stays inside the child cap', () => {
  const correspondence = buildCorrespondence(raw);
  const s6 = correspondence.patches.find((p) => p.id === 'S6');
  const groups = assignFacesToHinges(s6, correspondence.patches, ATTEMPT_A.hinges.S6, null);
  assert.ok(groups.length >= 1 && groups.length <= MAX_CHILDREN_PER_CARRIER);
  const split = splitPairedPatches(correspondence, ATTEMPT_A);
  assert.equal(split.ok, true);
  assert.ok(split.newCarriers <= MAX_NEW_CARRIERS);
  const childrenA = split.children.filter((c) => c.parentPatch === 'S6');
  assert.ok(childrenA.length <= MAX_CHILDREN_PER_CARRIER);
  assert.ok(childrenA.every((c) => c.areaFaces >= MIN_CHILD_FACES));
  assert.ok(split.correspondence.keepSeparate.includes(childrenA[0].id));
  const mated = split.children.filter((c) => c.cubeA?.matePatch);
  assert.ok(mated.length >= 2);
  for (const a of mated.filter((p) => p.parentPatch === 'S6')) {
    const b = split.children.find((p) => p.id === a.cubeA.matePatch);
    assert.ok(b);
    assert.equal(b.cubeA.matePatch, a.id);
  }
});

test('complexity gate rejects tiny children and extra carriers', () => {
  const report = complexityReport(
    [],
    [{ parentPatch: 'S6', areaFaces: 1 }],
    [],
    [{ chosen: { type: 'generalQuadric' } }],
    9,
  );
  assert.equal(report.overBudget, true);
  assert.ok(report.tinyChildren >= 1);
  assert.equal(attemptPasses({
    budgetHeld: true,
    complexity: { overBudget: false },
    seedTrims: 4,
    progress: 0,
  }, 4), false);
});

test('S50/S21 tiny remainder is rejected; overlap revision keeps two carriers', () => {
  const correspondence = buildCorrespondence(raw);
  const extracted = extractNonMateFaces(correspondence, 'S50', 'S21');
  assert.equal(extracted.ok, false);
  const revised = reviseMateToOverlap(correspondence, 'S50', 'S21');
  assert.equal(revised.ok, true);
  assert.equal(revised.newCarriers, 0);
  assert.ok(revised.revision.overlap >= 1);
  assert.equal(revised.correspondence.patches.filter((p) => p.id === 'S50' || p.id === 'S21').length, 2);
});
