import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pieceShell, exportOBJ } from './polyhedral_export.mjs';
import { transformAtom } from './polyhedral_occupancy.mjs';

test('two adjacent full cubes cancel the internal face', () => {
  const atoms = [
    { kind: 'full', cell: [0, 0, 0] },
    { kind: 'full', cell: [1, 0, 0] },
  ];
  const shell = pieceShell(atoms);
  assert.ok(shell.triangleCount > 0);
  const one = pieceShell([{ kind: 'full', cell: [0, 0, 0] }]);
  assert.ok(shell.faceCount < one.faceCount * 2);
});

test('complementary halves of one cell export as a cube', () => {
  const a = pieceShell([{ kind: 'full', cell: [0, 0, 0] }]);
  const b = pieceShell([
    { kind: 'half', cell: [0, 0, 0], plane: 0, side: 0 },
    { kind: 'half', cell: [0, 0, 0], plane: 0, side: 1 },
  ]);
  assert.equal(a.triangleCount, b.triangleCount);
});

test('OBJ contains vertices and faces', () => {
  const doc = {
    N: 2,
    pieces: [
      {
        id: 0,
        transformB: { r: 0, t: [0, 0, 0] },
        atoms: [{ kind: 'full', cell: [0, 0, 0] }],
      },
    ],
  };
  const obj = exportOBJ(doc, 'A');
  assert.match(obj, /^v /m);
  assert.match(obj, /^f /m);
  void transformAtom;
});
