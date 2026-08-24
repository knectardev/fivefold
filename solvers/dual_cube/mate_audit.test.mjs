import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapIndexThroughB } from './mate_audit.mjs';
import { inverseGeometricPoint, transformGeometricPoint } from './json_contract.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const candidate = (name) => JSON.parse(readFileSync(join(dir, 'results', name), 'utf8'));

test('index points round-trip through a piece transform', () => {
  const raw = candidate('candidate_N6_P8.json');
  const N = raw.gridResolution;
  const pl = raw.placements[0];
  const p = [2.5, 1.5, 3.5];
  const b = transformGeometricPoint(p, pl, N);
  const a = inverseGeometricPoint(b, pl, N);
  assert.ok(Math.abs(a[0] - p[0]) < 1e-9);
  assert.ok(Math.abs(a[1] - p[1]) < 1e-9);
  assert.ok(Math.abs(a[2] - p[2]) < 1e-9);
});

test('mapping through Cube B then inverse lands on the mate piece frame', () => {
  const raw = candidate('candidate_N6_P8.json');
  const N = raw.gridResolution;
  const pl = raw.placements[2];
  const p = [1, 2, 3];
  const { b, aMate } = mapIndexThroughB(p, pl, pl, N);
  assert.ok(Math.abs(aMate[0] - p[0]) < 1e-9);
  assert.ok(b);
});
