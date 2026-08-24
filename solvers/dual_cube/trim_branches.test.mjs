import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  enumerateIntersectionBranches,
  makeBranchId,
  adjacencyKey,
} from './analytic_junctions.mjs';
import { buildCorrespondence, analyzePhysicalCorrespondence } from './physical_correspondence.mjs';
import { fitOpeningsBatched } from './gpu_fit_cpu.mjs';
import { insertCarriersTransactional } from './insert_carriers.mjs';
import { searchTrimBranches } from './trim_branches.mjs';
import { buildClosureView } from './closure_view.mjs';
import { sub, norm } from './plane_only.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const candidate = (name) => JSON.parse(readFileSync(join(dir, 'results', name), 'utf8'));

const planeX = { type: 'plane', origin: [0, 0, 0], normal: [1, 0, 0] };
const cylY = { type: 'cylinder', axis: [0, 1, 0], point: [0.12, 0, 0], radius: 0.2 };

test('both cylinder generators are enumerated with stable IDs', () => {
  const seeds = [
    [0, 0.1, 0.16],
    [0, 0.4, 0.16],
    [0, 0.7, 0.16],
  ];
  const branches = enumerateIntersectionBranches(planeX, cylY, seeds);
  const gens = [...new Set(branches.map((b) => b.component).filter((c) => c.startsWith('generator_')))];
  assert.deepEqual(gens.sort(), ['generator_0', 'generator_1']);
  const ids = branches.map((b) => makeBranchId('S6', 'S14', b));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id.startsWith('S6__plane_S14__generator_') || id.startsWith('S6__plane_S14__numerical')));
  const again = enumerateIntersectionBranches(planeX, cylY, seeds).map((b) => makeBranchId('S6', 'S14', b));
  assert.deepEqual(again, ids);
});

test('reversing a branch reverses endpoints but preserves geometry', () => {
  const seeds = [[0, 0.1, 0.16], [0, 0.5, 0.16]];
  const branches = enumerateIntersectionBranches(planeX, cylY, seeds).filter((b) => b.accept && b.component === 'generator_0');
  const fwd = branches.find((b) => b.orientation === 'forward');
  const rev = branches.find((b) => b.orientation === 'reverse');
  assert.ok(fwd && rev);
  assert.ok(norm(sub(fwd.hit.a, rev.hit.b)) < 1e-12);
  assert.ok(norm(sub(fwd.hit.b, rev.hit.a)) < 1e-12);
  assert.equal(fwd.hit.samples.length, rev.hit.samples.length);
  assert.equal(fwd.clip, rev.clip);
  assert.ok(Math.abs(fwd.voxelScore - rev.voxelScore) < 1e-12);
});

test('padded clipping is used only when interval clipping degenerates', () => {
  const longSeeds = [[0, 0.1, 0.16], [0, 0.6, 0.16]];
  const long = enumerateIntersectionBranches(planeX, cylY, longSeeds);
  assert.ok(long.some((b) => b.accept && b.clip === 'seed_clip' && b.component.startsWith('generator_')));
  assert.equal(long.filter((b) => b.clip === 'aabb_clip' && b.component.startsWith('generator_')).length, 0);

  const flatSeeds = [[0, 0.3, 0.1], [0, 0.3, 0.2], [0, 0.3, 0.16]];
  const flat = enumerateIntersectionBranches(planeX, cylY, flatSeeds);
  const aabb = flat.filter((b) => b.component.startsWith('generator_') && b.clip === 'aabb_clip' && b.accept);
  const seed = flat.filter((b) => b.component.startsWith('generator_') && b.clip === 'seed_clip' && b.accept);
  assert.ok(aabb.length >= 2, 'degenerate Y-span should fall back to aabb_clip');
  assert.equal(seed.length, 0);
});

test('S6 and S96 trim search resolves the eight fitted-untrimmed edges', () => {
  const raw = candidate('candidate_N6_P8_connected.json');
  const correspondence = buildCorrespondence(raw);
  const batch = fitOpeningsBatched(correspondence);
  const inserted = insertCarriersTransactional(raw, correspondence, batch.fits);
  const before = inserted.openEdges.byFittedUntrimmed || {};
  assert.equal(before.S6, 6);
  assert.equal(before.S96, 2);
  const s6Params = JSON.stringify(inserted.fits.find((f) => f.patch === 'S6').chosen);
  const s96Params = JSON.stringify(inserted.fits.find((f) => f.patch === 'S96').chosen);

  const search = searchTrimBranches(raw, correspondence, inserted.fits);
  const ids1 = Object.values(search.chosen.overrides).sort();
  const ids2 = Object.values(searchTrimBranches(raw, correspondence, inserted.fits, { includeMate: false }).chosen.overrides).sort();
  assert.deepEqual(ids2, ids1);

  assert.equal(search.openEdges.explainedByFittedUntrimmed, 0);
  assert.equal(search.openEdges.unexplainedCount, 0);
  assert.equal(search.chosen.metrics.openEdges, 86);
  assert.equal(search.chosen.metrics.nonmanifold, 0);
  assert.equal(search.openEdges.explainedByUnresolvedOpening, 86);
  const st = Object.fromEntries(search.carrierStatus.map((c) => [c.patch, c]));
  assert.equal(st.S6.trimComplete, true);
  assert.equal(st.S96.trimComplete, true);
  assert.equal(JSON.stringify(inserted.fits.find((f) => f.patch === 'S6').chosen), s6Params);
  assert.equal(JSON.stringify(inserted.fits.find((f) => f.patch === 'S96').chosen), s96Params);
  assert.ok(search.chosen.cubeB.rms <= 0.003);
  assert.ok(search.chosen.cubeB.max <= 0.012);
});

test('connected N=6 analysis locks the 86-edge gate', () => {
  const report = analyzePhysicalCorrespondence(candidate('candidate_N6_P8_connected.json'));
  assert.equal(report.insertion.final.openEdges, 86);
  assert.equal(report.insertion.openEdges.explainedByFittedUntrimmed, 0);
  assert.equal(report.insertion.openEdges.unexplainedCount, 0);
  assert.equal(report.closure.metrics.shellClosure.openEdges, 86);
  assert.equal(report.closure.metrics.shellClosure.nonmanifoldAfterDissolve, 0);
  const p5 = report.closure.pieces.find((p) => p.piece === 5);
  assert.equal(p5.shells, 1);
  assert.equal(p5.openEdges, 0);
  assert.ok(report.closure.metrics.continuousTrimMismatch.rms <= 0.003);
  assert.ok(report.closure.metrics.continuousTrimMismatch.max <= 0.012);
  const st = Object.fromEntries(report.insertion.carrierStatus.map((c) => [c.patch, c]));
  assert.equal(st.S6.trimComplete, true);
  assert.equal(st.S96.trimComplete, true);
  assert.ok(report.insertion.trimRepair.overrides);
  assert.equal(adjacencyKey('S6', 'S14'), 'S14|S6');
  const view = buildClosureView(candidate('candidate_N6_P8_connected.json'), report);
  assert.equal(view.schema, 'dual-cube-closure-view');
  assert.equal(view.summary.openEdges, 86);
  assert.equal(view.summary.explainedByFittedUntrimmed, 0);
  assert.ok(view.visibilityGroups.includes('openEdges'));
  assert.ok(view.voxels.length > 0);
  assert.ok(view.openEdges.length >= 1);
});
