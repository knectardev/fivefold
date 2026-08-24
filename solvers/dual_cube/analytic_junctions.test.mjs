import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planePlaneLine, planeSphereCircle, planeCylinderConic } from './analytic_junctions.mjs';
import { projectToCarriers } from './surface_eval.mjs';

test('two orthogonal planes intersect on a line through the origin', () => {
  const line = planePlaneLine(
    { origin: [0, 0, 0], normal: [1, 0, 0] },
    { origin: [0, 0, 0], normal: [0, 1, 0] },
  );
  assert.ok(line);
  assert.equal(Math.abs(line.direction[2]), 1);
  assert.ok(Math.abs(line.point[0]) < 1e-9);
  assert.ok(Math.abs(line.point[1]) < 1e-9);
});

test('plane through a sphere center yields a great circle', () => {
  const cir = planeSphereCircle(
    { origin: [0, 0, 0], normal: [0, 0, 1] },
    { center: [0, 0, 0], radius: 0.5 },
  );
  assert.ok(cir);
  assert.equal(cir.radius, 0.5);
});

test('plane–cylinder intersection is an ellipse when the axis is not parallel', () => {
  const ell = planeCylinderConic(
    { origin: [0, 0, 0], normal: [0, 0, 1] },
    { point: [0, 0, 0], axis: [0, 1, 0.5], radius: 0.2 },
  );
  assert.ok(ell);
  assert.equal(ell.kind, 'ellipse');
  assert.ok(ell.majorR >= ell.minorR - 1e-9);
});

test('junction projection onto two planes lands on both', () => {
  const hit = projectToCarriers(
    [
      { type: 'plane', origin: [0, 0, 0], normal: [1, 0, 0] },
      { type: 'plane', origin: [0, 0, 0], normal: [0, 1, 0] },
    ],
    [0.2, 0.3, 0.4],
    { pull: 0 },
  );
  assert.ok(hit.rms < 1e-6);
  assert.ok(Math.abs(hit.point[0]) < 1e-6);
  assert.ok(Math.abs(hit.point[1]) < 1e-6);
});
