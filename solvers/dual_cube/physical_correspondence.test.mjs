import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformVoxel, inverseTransformVoxel } from './json_contract.mjs';
import { analyzePhysicalCorrespondence } from './physical_correspondence.mjs';
import { fitSphere, selectJointSurface } from './joint_quadrics.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const candidate = (name) => JSON.parse(readFileSync(join(dir, 'results', name), 'utf8'));

test('voxel transform inverts on radius-0 placements', () => {
  const raw = candidate('candidate_N8_P8.json');
  const N = raw.gridResolution;
  for (let k = 0; k < raw.pieceCount; k++) {
    const pl = raw.placements[k];
    for (const v of [[0, 0, 0], [3, 4, 2], [N - 1, N - 1, N - 1]]) {
      const b = transformVoxel(v, pl, N);
      const a = inverseTransformVoxel(b, pl, N);
      assert.deepEqual(a, v);
    }
  }
});

test('physical patches are owned by a piece and carry A and B mates', () => {
  const report = analyzePhysicalCorrespondence(candidate('candidate_N8_P8.json'));
  assert.ok(report.correspondence.counts.accepted >= 1);
  for (const p of report.correspondence.patches) {
    assert.ok(p.piece >= 1 && p.piece <= 8);
    assert.ok(p.cubeA.mate === 'exterior' || p.cubeA.mate >= 1);
    assert.ok(p.cubeB.mate === 'exterior' || p.cubeB.mate >= 1);
    assert.ok(p.cubeB.unique);
  }
  const crossed = report.correspondence.patches.filter((p) => p.cubeA.mate !== p.cubeB.mate);
  assert.ok(crossed.length >= 1, 'a reusable piece should change partners between assemblies');
  assert.equal(report.rhinoReady, false);
  assert.ok(!report.correspondence.rejected.some((r) => /not unique/.test(r.reason || '')));
});

test('partner-signature subdivision recovers mixed Cube B contacts as unique subpatches', () => {
  const report = analyzePhysicalCorrespondence(candidate('candidate_N6_P8.json'));
  assert.ok(report.correspondence.counts.partnerSignatureSplits >= 1);
  assert.equal(report.cadEligible, false);
  assert.equal(report.cadQueue, 'rejected-disconnected-source');
  assert.ok(report.cadBlockers.some((r) => /disconnected source topology/.test(r)));
  assert.equal(report.junctions, null);
  assert.equal(report.closure, null);
});

test('N=6 disconnected source remains a regression fixture for closure metrics', () => {
  const report = analyzePhysicalCorrespondence(candidate('candidate_N6_P8.json'), {
    fitAnyway: true,
    junctionsAnyway: true,
  });
  assert.equal(report.cadEligible, false);
  assert.equal(report.cadQueue, 'rejected-disconnected-source');
  assert.ok(report.junctions);
  assert.ok(report.junctions.trims.some((t) => t.intersection?.kind === 'plane-plane'));
});

test('N=6 closure report has dual-assembly gate fields and fewer carriers than patches', () => {
  const report = analyzePhysicalCorrespondence(candidate('candidate_N6_P8.json'), {
    fitAnyway: true,
    junctionsAnyway: true,
  });
  assert.ok(report.closure);
  assert.ok(report.closure.carriers.carrierCount <= report.closure.carriers.patchCount);
  assert.ok(report.closure.carriers.items.some((c) => c.regionCount > 1), 'at least one carrier should cover multiple partner regions');
  assert.ok(report.closure.carriers.frozenCount >= 1);
  assert.equal(typeof report.closure.assemblies.A.junctionRMS, 'number');
  assert.equal(typeof report.closure.assemblies.B.mateRMS, 'number');
  assert.equal(report.closure.pieces.length, 8);
  for (const p of report.closure.pieces) {
    assert.equal(typeof p.openEdges, 'number');
    assert.equal(typeof p.nonmanifoldEdges, 'number');
    assert.equal(typeof p.shells, 'number');
    assert.equal(typeof p.volumePositive, 'boolean');
    assert.equal(typeof p.connectedSolid, 'boolean');
  }
  assert.equal(report.closure.gate.rhinoReady, false);
  assert.equal(report.gate.bothAssembliesClosed, false);
  assert.equal(report.closure.trims.consistent, true);
  assert.equal(
    report.closure.trims.uniqueRecords,
    report.closure.trims.role.intersection + report.closure.trims.role.carrierSeam + report.closure.trims.role.missing,
  );
  assert.equal(report.closure.metrics.discreteMateIdentity.exact, true);
  assert.ok(report.closure.audit.cubeB.geometricRms < 1e-9);
  assert.equal(report.closure.metrics.shellClosure.nonmanifoldBeforeDissolve, 5);
  assert.equal(report.closure.metrics.shellClosure.nonmanifoldAfterDissolve, 0);
  const twoShell = report.closure.metrics.shellClosure.diagnosis.filter((d) => d.piece === 1 || d.piece === 5);
  assert.equal(twoShell.length, 2);
  for (const p of report.closure.pieces) {
    assert.ok(p.shells <= p.shellsBeforeDissolve);
  }
});

test('connected N=6 hunt candidate passes the CAD promotion gate', () => {
  const raw = candidate('candidate_N6_P8_connected.json');
  assert.equal(raw.cadEligible, true);
  assert.equal(raw.cadQueue, 'active');
  assert.equal(raw.cadRole, 'cad-candidate');
  assert.equal(raw.validation.connectivity.connected, 8);
  assert.ok(raw.validation.connectivity.minVol >= 0.05);
  assert.equal(raw.validation.exactClosure.ok, true);
});

test('N=10 empty piece is malformed (voxel and analytic volumes both zero)', () => {
  const report = analyzePhysicalCorrespondence(candidate('candidate_N10_P8.json'));
  const p7 = report.volumes.find((v) => v.piece === 7);
  assert.ok(p7);
  assert.equal(p7.sourceVoxelVolume, 0);
  assert.equal(p7.analyticShellVolume, 0);
  assert.equal(p7.failure, 'malformed-empty');
  assert.equal(report.cadEligible, false);
  assert.equal(report.cadQueue, 'rejected-empty-piece');
  assert.equal(report.junctions, null);
  assert.equal(report.closure, null);
  assert.equal(report.gate.everyPieceNonempty, false);
});

test('joint selector prefers a sphere for spherical samples', () => {
  const pts = [];
  for (let i = 0; i < 30; i++) {
    const th = (i / 30) * Math.PI;
    const ph = i * 0.7;
    pts.push([0.5 + 0.2 * Math.sin(th) * Math.cos(ph), 0.5 + 0.2 * Math.sin(th) * Math.sin(ph), 0.5 + 0.2 * Math.cos(th)]);
  }
  const sph = fitSphere(pts);
  assert.ok(sph);
  assert.ok(sph.rms < 0.002);
  const sel = selectJointSurface(pts, 0.018);
  assert.ok(sel.chosen);
  assert.equal(sel.chosen.type, 'sphere');
});
