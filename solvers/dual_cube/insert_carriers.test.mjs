import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCorrespondence, analyzePhysicalCorrespondence } from './physical_correspondence.mjs';
import { fitOpeningsBatched } from './gpu_fit_cpu.mjs';
import { insertCarriersTransactional, insertOpeningProposals, TIER1_ORDER, TIER2_ORDER } from './insert_carriers.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const candidate = (name) => JSON.parse(readFileSync(join(dir, 'results', name), 'utf8'));

test('transactional insertion never increases nonmanifold or open edges', () => {
  const raw = candidate('candidate_N6_P8_connected.json');
  const correspondence = buildCorrespondence(raw);
  const batch = fitOpeningsBatched(correspondence);
  const inserted = insertCarriersTransactional(raw, correspondence, batch.fits);
  assert.ok(inserted.proposedCount >= 1);
  assert.ok(inserted.final.nonmanifold <= inserted.baseline.nonmanifold);
  assert.ok(inserted.final.openEdges <= inserted.baseline.openEdges);
  for (const step of inserted.log) {
    if (step.accept) {
      assert.ok(step.after.nonmanifold <= step.before.nonmanifold);
      assert.ok(step.after.openEdges <= step.before.openEdges);
    }
  }
});

test('remaining open edges are attributed to unresolved openings', () => {
  const raw = candidate('candidate_N6_P8_connected.json');
  const correspondence = buildCorrespondence(raw);
  const batch = fitOpeningsBatched(correspondence);
  const inserted = insertCarriersTransactional(raw, correspondence, batch.fits);
  const attr = inserted.openEdges;
  assert.equal(attr.openEdges, inserted.final.openEdges);
  assert.equal(
    attr.explainedByUnresolvedOpening + attr.explainedByFittedUntrimmed + attr.unexplainedCount,
    attr.openEdges,
  );
  assert.equal(attr.unexplainedCount, 0, `unexplained open edges: ${JSON.stringify(attr.unexplained)}`);
});

test('closure junction report decomposes residuals by constraint count', () => {
  const raw = candidate('candidate_N6_P8_connected.json');
  const report = analyzePhysicalCorrespondence(raw);
  const j = report.closure.junctions;
  assert.equal(typeof j.rms, 'number');
  assert.equal(typeof j.max, 'number');
  assert.ok(j.byCarrierCount);
  assert.ok(j.worst.length >= 1);
  const row = j.worst[0];
  assert.equal(typeof row.incidenceRms, 'number');
  assert.equal(typeof row.incidenceMax, 'number');
  assert.equal(typeof row.incidentCarrierCount, 'number');
  assert.ok(Array.isArray(row.carrierFamilies));
  assert.equal(typeof row.neighboringOpenings.resolvedCount, 'number');
  assert.equal(typeof row.neighboringOpenings.unresolvedCount, 'number');
  assert.equal(typeof row.assemblies.A, 'boolean');
  assert.equal(typeof row.assemblies.B, 'boolean');
  assert.equal(typeof row.bordersNewSurface, 'boolean');
  assert.ok(report.insertion);
  assert.ok(report.insertion.final.nonmanifold <= report.insertion.baseline.nonmanifold);
  assert.ok(report.closure.metrics.shellClosure.openEdgeAttribution);
});

test('two-tier insertion keeps accepted geometry separate from Cube B probes', () => {
  const raw = candidate('candidate_N6_P8_connected.json');
  const correspondence = buildCorrespondence(raw);
  const report = insertOpeningProposals(raw, correspondence);
  assert.equal(report.baseline.openEdges, 86);
  assert.equal(report.baseline.nonmanifold, 0);
  assert.equal(report.baseline.unexplained, 0);
  assert.equal(report.final.nonmanifold, 0);
  assert.equal(report.final.unexplained, 0);
  assert.ok(report.final.openEdges <= report.baseline.openEdges);
  assert.equal(report.piece5.closed, true);
  assert.equal(report.tier1.attempted, TIER1_ORDER.length);
  assert.ok(report.tier1.kept + report.tier1.rolledBack === TIER1_ORDER.length);
  const kept = report.log.filter((e) => e.decision === 'keep');
  for (const e of kept) {
    assert.equal(e.acceptedGeometry, true);
    assert.equal(e.topologyProbe, false);
    assert.equal(e.residualGate, 'pass');
    assert.ok(TIER1_ORDER.includes(e.opening));
  }
  for (const e of report.log.filter((x) => x.decision === 'provisional')) {
    assert.equal(e.acceptedGeometry, false);
    assert.equal(e.topologyProbe, true);
    assert.equal(e.residualGate, 'mateB');
    assert.ok(TIER2_ORDER.includes(e.opening));
    assert.ok(e.notes);
  }
  for (const e of report.log) {
    assert.ok(['keep', 'provisional', 'rollback'].includes(e.decision));
    assert.equal(typeof e.trimComplete, 'boolean');
    assert.ok(e.after.nonmanifold === 0 || e.decision === 'rollback');
  }
  const st = Object.fromEntries(report.carrierStatus.map((c) => [c.patch, c]));
  assert.equal(st.S6.acceptedGeometry, true);
  assert.equal(st.S6.trimComplete, true);
  for (const id of kept.map((e) => e.opening)) {
    assert.equal(st[id].acceptedGeometry, true);
    assert.equal(st[id].residualGate, 'pass');
  }
  for (const id of report.tier2.usable) {
    assert.equal(st[id].acceptedGeometry, false);
    assert.equal(st[id].topologyProbe, true);
  }
});
