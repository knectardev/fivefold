import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HALF_COUNT,
  HALF_VOLUME,
  PLANES,
  ROTATION_TABLE,
  complementHalf,
  cutPolygon,
  halfCorners,
  halfFacePolygons,
  identifyHalf,
  polygonArea,
  probePoint,
  rotateHalfByR,
  splitHalf,
} from './half_cells.mjs';
import { ROT } from './json_contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('12 halves, 6 planes, exact half volume', () => {
  assert.equal(PLANES.length, 6);
  assert.equal(HALF_COUNT, 12);
  assert.equal(HALF_VOLUME, 0.5);
  for (let h = 0; h < 12; h++) {
    assert.equal(complementHalf(complementHalf(h)), h);
    assert.notEqual(complementHalf(h), h);
    assert.equal(splitHalf(h).planeIdx, h >> 1);
  }
});

test('probe point identifies its own half and not the complement', () => {
  for (let h = 0; h < 12; h++) {
    assert.equal(identifyHalf(probePoint(h)), h);
    assert.notEqual(identifyHalf(probePoint(h)), complementHalf(h));
  }
});

test('each half has 6 integer corners and a rectangular cut of area √2', () => {
  for (let h = 0; h < 12; h++) {
    const corners = halfCorners(h);
    assert.equal(corners.length, 6);
    const cut = cutPolygon(h);
    assert.equal(cut.length, 4);
    assert.ok(Math.abs(polygonArea(cut) - Math.SQRT2) < 1e-9);
    const faces = halfFacePolygons(h);
    assert.ok(faces.length >= 5);
    const area = faces.reduce((s, f) => s + polygonArea(f), 0);
    assert.ok(area > 4);
  }
});

test('complementary halves union to the 8 cube corners', () => {
  for (let p = 0; p < 6; p++) {
    const a = new Set(halfCorners(p * 2).map((c) => c.join(',')));
    const b = new Set(halfCorners(p * 2 + 1).map((c) => c.join(',')));
    assert.equal(new Set([...a, ...b]).size, 8);
  }
});

test('24 rotations permute the 12 halves and preserve complement', () => {
  assert.equal(ROT.length, 24);
  for (let r = 0; r < 24; r++) {
    const imgs = new Set();
    for (let h = 0; h < 12; h++) {
      const rh = rotateHalfByR(h, r);
      imgs.add(rh);
      assert.equal(rotateHalfByR(complementHalf(h), r), complementHalf(rh));
      assert.equal(ROTATION_TABLE[r][h], rh);
    }
    assert.equal(imgs.size, 12);
  }
});

test('rotation round-trip: R then R^T returns the same half', () => {
  for (let r = 0; r < 24; r++) {
    const M = ROT[r];
    const Mt = [
      [M[0][0], M[1][0], M[2][0]],
      [M[0][1], M[1][1], M[2][1]],
      [M[0][2], M[1][2], M[2][2]],
    ];
    for (let h = 0; h < 12; h++) {
      const p = probePoint(h);
      const u = [2 * p[0] - 1, 2 * p[1] - 1, 2 * p[2] - 1];
      const ru = [
        M[0][0] * u[0] + M[0][1] * u[1] + M[0][2] * u[2],
        M[1][0] * u[0] + M[1][1] * u[1] + M[1][2] * u[2],
        M[2][0] * u[0] + M[2][1] * u[1] + M[2][2] * u[2],
      ];
      const back = [
        Mt[0][0] * ru[0] + Mt[0][1] * ru[1] + Mt[0][2] * ru[2],
        Mt[1][0] * ru[0] + Mt[1][1] * ru[1] + Mt[1][2] * ru[2],
        Mt[2][0] * ru[0] + Mt[2][1] * ru[1] + Mt[2][2] * ru[2],
      ];
      const local = [(back[0] + 1) / 2, (back[1] + 1) / 2, (back[2] + 1) / 2];
      assert.equal(identifyHalf(local), h);
    }
  }
});

test('JS rotation table matches Python cube_pack oracle', () => {
  const raw = execFileSync('python', [join(here, 'half_cells_oracle.py')], {
    encoding: 'utf8',
  });
  const { table } = JSON.parse(raw);
  assert.equal(table.length, 24);
  for (let r = 0; r < 24; r++) {
    for (let h = 0; h < 12; h++) {
      assert.equal(table[r][h], ROTATION_TABLE[r][h], `r=${r} h=${h}`);
    }
  }
});
