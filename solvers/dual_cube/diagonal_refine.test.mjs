import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCandidate, idx, unidx } from './json_contract.mjs';
import { voxelToPolyhedral, allCellsEligible, destValidOwners, FACE } from './polyhedral_occupancy.mjs';
import {
  compareLex,
  freezeLexScore,
  refineCandidate,
  compareProduct,
  connectivityCuts,
  buildSatInstance,
  destTables,
} from './diagonal_refine.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('lex score prefers merged diagonal area after cover and gates', () => {
  const base = {
    exactCover: 1,
    manifoldPieces: 1,
    geometryGates: 1,
    mergedDiagonalArea: 0,
    boundaryEdgeCount: 100,
    faceCount: 80,
    splitCellCount: 0,
    minFaceArea: 1,
  };
  const better = { ...base, mergedDiagonalArea: 4, boundaryEdgeCount: 90 };
  assert.ok(compareLex(better, base) > 0);
  assert.ok(compareLex(base, better) < 0);
});

test('cycle diagnostics count self-closing and depth-2 candidates', async () => {
  const raw = JSON.parse(readFileSync(join(here, 'results', 'candidate_N8_P8_connected.json'), 'utf8'));
  const result = await refineCandidate(raw, { usePython: false, halo: false });
  assert.ok(result.report.cycles);
  assert.ok(result.report.cycles.selfClosing >= 0);
  assert.ok(result.report.cycles.depth2 >= 0);
});

test('all-whole voxel seed is exact cover but not a Phase 1 pass', async () => {
  const raw = JSON.parse(readFileSync(join(here, 'results', 'candidate_N8_P8_connected.json'), 'utf8'));
  const result = await refineCandidate(raw, { usePython: false, halo: false });
  assert.equal(result.baseline.exactCover, 1);
  assert.equal(result.baseline.manifoldPieces, 1);
  assert.ok('goNogo' in result.report);
  if (!result.improved) {
    assert.equal(result.report.goNogo.pass, false);
  }
});

test('product lex prefers a broader merged diagonal over extra splits', () => {
  const base = {
    exactCover: 1,
    manifoldPieces: 1,
    geometryGates: 1,
    maxDiagonalFace: 1.4,
    mergedDiagonalArea: 2.8,
    boundaryEdgeCount: 0,
    faceCount: 242,
    splitCellCount: 1,
    minFaceArea: 0.5,
  };
  const broader = { ...base, maxDiagonalFace: 4, mergedDiagonalArea: 8, splitCellCount: 3, faceCount: 230 };
  const manyTiny = { ...base, geometryGates: 0, maxDiagonalFace: 1.4, mergedDiagonalArea: 80, splitCellCount: 40 };
  assert.ok(compareProduct(broader, base) > 0);
  assert.ok(compareProduct(base, manyTiny) > 0);
});

test('connectivity cuts are empty on the connected voxel seed', async () => {
  const raw = JSON.parse(readFileSync(join(here, 'results', 'candidate_N8_P8_connected.json'), 'utf8'));
  const parsed = parseCandidate(raw);
  const doc = voxelToPolyhedral(parsed);
  assert.equal(connectivityCuts(doc).length, 0);
});

test('connectivity cuts fire on a disconnected two-island piece', () => {
  const doc = {
    N: 4,
    pieceCount: 1,
    pieces: [{
      id: 0,
      transformB: { r: 0, t: [0, 0, 0] },
      atoms: [
        { kind: 'full', cell: [0, 0, 0] },
        { kind: 'full', cell: [3, 3, 3] },
      ],
    }],
  };
  const cuts = connectivityCuts(doc);
  assert.ok(cuts.length >= 2);
  assert.equal(cuts[0].piece, 0);
  assert.ok(cuts[0].component.length >= 1);
  assert.ok(cuts[0].neighbors.length >= 1);
});

test('native Stage 1 instance marks every cell eligible and allows non-neighbor owners', () => {
  const raw = JSON.parse(readFileSync(join(here, 'results', 'candidate_N8_P8_connected.json'), 'utf8'));
  const parsed = parseCandidate(raw);
  const seed = voxelToPolyhedral(parsed);
  seed.N = parsed.gridResolution ?? parsed.N ?? 8;
  const N = seed.N;
  const P = seed.pieceCount;
  const dest = destTables(seed);
  const labels = parsed.labelsA || parsed.labelsA;
  let interior = -1;
  for (let i = 0; i < labels.length; i++) {
    const [x, y, z] = unidx(i, N);
    if (FACE.every((d) => {
      const v = [x + d[0], y + d[1], z + d[2]];
      return v[0] >= 0 && v[1] >= 0 && v[2] >= 0 && v[0] < N && v[1] < N && v[2] < N
        && labels[idx(...v, N)] === labels[i];
    })) {
      interior = i;
      break;
    }
  }
  assert.ok(interior >= 0);
  const neighborOwners = new Set([labels[interior]]);
  const [x, y, z] = unidx(interior, N);
  for (const d of FACE) {
    const v = [x + d[0], y + d[1], z + d[2]];
    neighborOwners.add(labels[idx(...v, N)]);
  }
  const nativeOwners = destValidOwners(dest, interior, P);
  assert.ok(nativeOwners.length > neighborOwners.size);
  const inst = buildSatInstance(seed, allCellsEligible(N), { native: true, minPairs: 1 });
  assert.equal(inst.eligibleCells.length, N * N * N);
  assert.equal(inst.native, true);
  assert.equal(inst.minPairs, 1);
});
