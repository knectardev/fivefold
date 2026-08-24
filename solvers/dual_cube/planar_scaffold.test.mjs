import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlanarScaffold } from './planar_scaffold.mjs';
import { planeOnlyAnalyze } from './plane_only.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const candidate = (name) => JSON.parse(readFileSync(join(dir, 'results', name), 'utf8'));

test('trimmed shells are an open B-rep and are not Rhino-ready', () => {
  const raw = candidate('candidate_N6_P8.json');
  const report = buildPlanarScaffold(raw);
  assert.equal(report.schema, 'dual-cube-trimmed-shell');
  assert.equal(report.rhinoReady, false);
  assert.ok(report.representation.includes('trimmed-open-shell'));
  assert.ok(report.pieces.filter((p) => !p.empty).every((p) => p.shells >= 1));
  assert.ok(report.pieces.some((p) => p.curvedOpenings >= 1));
  assert.equal(report.gate.solidFeasibility.closed, false);
  assert.equal(report.gate.solidFeasibility.passed, false);
  const planar = report.interfaces.filter((i) => i.kind === 'planar');
  assert.ok(planar.every((i) => i.loopVertexCounts.length >= 1));
  const curved = report.interfaces.filter((i) => i.kind === 'curved');
  assert.ok(curved.every((i) => i.openLoops >= 1));
});

test('coplanar and curved merges do not drop interfaces, and half-spaces are not a gate', () => {
  const raw = candidate('candidate_N8_P8.json');
  const plane = planeOnlyAnalyze(raw);
  const scaffold = buildPlanarScaffold(raw);
  const planarPatchesA = plane.patches.filter((p) => p.state === 'A' && p.planar).length;
  const curvedPatchesA = plane.patches.filter((p) => p.state === 'A' && !p.planar).length;
  assert.ok(scaffold.cubeA.planarInterfaces <= planarPatchesA);
  assert.ok(scaffold.cubeA.curvedRegions <= curvedPatchesA);
  assert.equal(scaffold.cubeA.mergedPlanarFrom, planarPatchesA);
  assert.equal(scaffold.cubeA.mergedCurvedFrom, curvedPatchesA);
  assert.equal(scaffold.gate.patchGraph.dualAssemblyTopology, true);
  assert.equal(scaffold.gate.solidFeasibility.passed, false);
  assert.ok(!JSON.stringify(scaffold.gate.patchGraph.reasons).includes('half-space'));
});

test('empty piece fails solid feasibility even if the patch graph passes', () => {
  const raw = candidate('candidate_N10_P8.json');
  const report = buildPlanarScaffold(raw);
  assert.ok(report.diagnostics.oppositeOrientation.every((o) => o.antiparallel));
  assert.equal(report.gate.patchGraph.identicalSurfacesOppositeOrientation, true);
  assert.ok(report.risks.emptyPieces.length >= 1);
  assert.equal(report.gate.solidFeasibility.nonempty, false);
  assert.equal(report.gate.solidFeasibility.passed, false);
  assert.ok(report.gate.solidFeasibility.reasons.some((r) => r.includes('empty piece')));
  assert.equal(report.rhinoReady, false);
});
