import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareKey } from './exact_cover_kernel.mjs';
import { verifyExactClosure, cadEligibility } from './json_contract.mjs';
import { cadMinCells, repairVolume, evaluateLabels, applyVolumeRepairPostPass } from './volume_repair.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const seedPath = join(here, 'results', 'candidate_N8_P8_connected.volume_seed.json');
const fixturePath = join(here, 'results', 'candidate_N8_P8.json');

function stub(overrides) {
  return {
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
    seed: 1,
    jobIndex: 0,
    ...overrides,
  };
}

test('connected 24-cell min ranks ahead of connected 12-cell min', () => {
  const a = stub({ counts: [163, 59, 24, 55, 56, 57, 24, 74], minVol: 24 / 512, maxVol: 163 / 512 });
  const b = stub({
    counts: [200, 80, 12, 40, 40, 40, 50, 50],
    minVol: 12 / 512,
    maxVol: 200 / 512,
    fragileRatio: 0.001,
    roughA: 0.1,
    roughB: 0.1,
  });
  assert.ok(compareKey(a, b, 8) < 0);
});

test('among equal min volume, smaller whale ranks first', () => {
  const a = stub({ counts: [120, 56, 56, 56, 56, 56, 56, 56], minVol: 56 / 512, maxVol: 120 / 512 });
  const b = stub({ counts: [160, 50, 50, 50, 50, 50, 52, 50], minVol: 50 / 512, maxVol: 160 / 512 });
  assert.ok(compareKey(a, b, 8) < 0);
});

test('N=8 CAD floor is 26 cells', () => {
  assert.equal(cadMinCells(8), 26);
});

test('volume repair of the N=8 seed reaches 26-cell min without breaking exact dual occupancy', () => {
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
  assert.equal(Math.min(...seed.counts), 24);
  const repair = repairVolume(seed);
  assert.equal(repair.ok, true);
  assert.ok(repair.minCells >= 26, `minCells ${repair.minCells}`);
  assert.equal(repair.candidate.connected, 8);
  assert.equal(repair.cadEligible, true);
  const ev = evaluateLabels(repair.candidate.labelsA, seed.placements, 8);
  const closure = verifyExactClosure({
    N: 8,
    gridResolution: 8,
    pieceCount: 8,
    placements: seed.placements,
    labelsA: ev.labelsA,
    labelsB: ev.labelsB,
    destOf: ev.destOf,
  });
  assert.equal(closure.ok, true);
  const cad = cadEligibility(ev.counts, 8, ev);
  assert.equal(cad.cadEligible, true);
  assert.ok(Math.min(...repair.seedCounts) < 26);
});

test('disconnected N=8 regression fixture stays disconnected', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.ok(fixture.validation.connectivity.connected < 8);
  assert.equal(fixture.cadEligible, false);
});

test('volume-repair post-pass lifts a 22–25-cell connected hit without touching the disconnected fixture', () => {
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
  const hit = {
    ...seed,
    N: seed.gridResolution,
    gridResolution: seed.gridResolution,
    pieceCount: seed.pieceCount,
    connected: 8,
  };
  const post = applyVolumeRepairPostPass([hit], { N: 8, P: 8 });
  assert.equal(post.considered, 1);
  assert.ok(post.best);
  assert.ok(post.best.repair.minCells >= 26);
  assert.equal(post.best.repair.cadEligible, true);
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.ok(fixture.validation.connectivity.connected < 8);
});
