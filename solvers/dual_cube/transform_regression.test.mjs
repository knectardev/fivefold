import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROT,
  applyRot,
  rotTranspose,
  transformVoxel,
  inverseTransformVoxel,
  transformDirection,
  doubledFaceCenter,
  transformDoubledFace,
  inverseDoubledFace,
  transformGeometricPoint,
  inverseGeometricPoint,
  doubledEquals,
} from './json_contract.mjs';

const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const VOXELS = {
  6: [[0, 0, 0], [5, 5, 5], [2, 3, 1], [0, 5, 2]],
  8: [[0, 0, 0], [7, 7, 7], [3, 4, 2]],
};
const TRANSLATIONS = [[0, 0, 0], [1, 0, 0], [0, -1, 1], [-2, 1, 0]];

test('all 24 rotations: voxel, direction, doubled face, and geometric round-trips', () => {
  for (const N of [6, 8]) {
    for (let r = 0; r < ROT.length; r++) {
      for (const t of TRANSLATIONS) {
        const pl = { r, t };
        for (const v of VOXELS[N]) {
          const b = transformVoxel(v, pl, N);
          assert.deepEqual(inverseTransformVoxel(b, pl, N), v);
        }
        for (const d of DIRS) {
          const dB = transformDirection(d, pl);
          const dA = applyRot(dB, rotTranspose(ROT[r])).map((x) => Math.round(x));
          assert.deepEqual(dA, d, `direction round-trip r=${r} d=${d}`);
          for (const v of VOXELS[N]) {
            const f2 = doubledFaceCenter(v, d);
            assert.ok(f2.every(Number.isInteger));
            const f2B = transformDoubledFace(f2, pl, N);
            assert.ok(f2B.every(Number.isInteger));
            assert.deepEqual(inverseDoubledFace(f2B, pl, N), f2);
            const p = [v[0] + 0.5 + 0.5 * d[0], v[1] + 0.5 + 0.5 * d[1], v[2] + 0.5 + 0.5 * d[2]];
            const pB = transformGeometricPoint(p, pl, N);
            const pA = inverseGeometricPoint(pB, pl, N);
            assert.ok(pA.every((x, i) => Math.abs(x - p[i]) < 1e-12));
            const fromDoubled = f2B.map((x) => x / 2);
            assert.ok(fromDoubled.every((x, i) => Math.abs(x - pB[i]) < 1e-12));
          }
        }
      }
    }
  }
});

test('adjacent opposite faces share an exact doubled center before and after every rotation', () => {
  const N = 6;
  for (let r = 0; r < ROT.length; r++) {
    for (const t of TRANSLATIONS) {
      const pl = { r, t };
      for (const d of DIRS) {
        const v = [2, 2, 2];
        const w = [v[0] + d[0], v[1] + d[1], v[2] + d[2]];
        const fP = doubledFaceCenter(v, d);
        const fQ = doubledFaceCenter(w, d.map((x) => -x));
        assert.equal(doubledEquals(fP, fQ), true);
        assert.equal(doubledEquals(transformDoubledFace(fP, pl, N), transformDoubledFace(fQ, pl, N)), true);
        const dB = transformDirection(d, pl);
        const dOpp = transformDirection(d.map((x) => -x), pl);
        assert.deepEqual(dB.map((x) => -x || 0), dOpp.map((x) => x || 0));
      }
    }
  }
});
