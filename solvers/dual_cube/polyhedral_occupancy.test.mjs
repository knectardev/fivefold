import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCandidate } from './json_contract.mjs';
import { atomsFaceConnected } from './half_cells.mjs';
import {
  voxelToPolyhedral,
  verifyPolyhedralClosure,
  dualEligibleMask,
  haloMask,
  normalizeAtoms,
  allowedOwners,
} from './polyhedral_occupancy.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('same-owner complementary halves collapse to a whole cell', () => {
  const atoms = normalizeAtoms([
    { kind: 'half', cell: [1, 1, 1], plane: 0, side: 0 },
    { kind: 'half', cell: [1, 1, 1], plane: 0, side: 1 },
  ]);
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].kind, 'full');
});

test('face adjacency: full cubes share a face, diagonal-only contact is not enough', () => {
  assert.equal(
    atomsFaceConnected(
      { kind: 'full', cell: [0, 0, 0] },
      { kind: 'full', cell: [1, 0, 0] },
    ),
    true,
  );
  assert.equal(
    atomsFaceConnected(
      { kind: 'full', cell: [0, 0, 0] },
      { kind: 'full', cell: [1, 1, 0] },
    ),
    false,
  );
});

test('N=8 voxel seed converts to a closed polyhedral dual cover', () => {
  const raw = JSON.parse(readFileSync(join(here, 'results', 'candidate_N8_P8_connected.json'), 'utf8'));
  const parsed = parseCandidate(raw);
  const doc = voxelToPolyhedral(parsed);
  const v = verifyPolyhedralClosure(doc);
  assert.equal(v.ok, true, v.reasons.join('; '));
  assert.equal(v.volumes.reduce((s, x) => s + x, 0), 512);
  assert.ok(v.componentsA.every((c) => c === 1));
  assert.deepEqual(v.componentsA, v.componentsB);
});

test('dual-eligible band is A interfaces union inverse-mapped B interfaces', () => {
  const raw = JSON.parse(readFileSync(join(here, 'results', 'candidate_N8_P8_connected.json'), 'utf8'));
  const parsed = parseCandidate(raw);
  const { eligible, aIface, bIface, N } = dualEligibleMask(parsed);
  const aCount = aIface.reduce((s, x) => s + x, 0);
  const elCount = eligible.reduce((s, x) => s + x, 0);
  assert.equal(N, 8);
  assert.ok(aCount > 0);
  assert.ok(elCount >= aCount);
  const halo = haloMask(eligible, N);
  assert.ok(halo.reduce((s, x) => s + x, 0) >= elCount);
});

test('allowed owners of a cell include itself', () => {
  const labels = [0, 0, 1, 1];
  // 2x1x1 is too small; just check helper on a fake 2^3
  const N = 2;
  const labs = new Array(8).fill(0);
  labs[1] = 1;
  const own = allowedOwners(labs, 0, N);
  assert.ok(own.includes(0));
});
