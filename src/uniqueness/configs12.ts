import { Matrix4, Vector3 } from 'three';
import { OH_GROUP } from './octahedralGroup';
import { identityTransform, ohTransform } from './canonicalize';
import type { ShapeConfig } from './types';

/** Identity linear part from OH_GROUP. */
function I(): Matrix4 {
  return OH_GROUP.find((m) => {
    const e = m.elements;
    return (
      e[0] === 1 &&
      e[5] === 1 &&
      e[10] === 1 &&
      e[1] === 0 &&
      e[2] === 0 &&
      e[4] === 0 &&
      e[6] === 0 &&
      e[8] === 0 &&
      e[9] === 0
    );
  })!.clone();
}

/** Rotate 90° about +Y: (x,y,z) → (z, y, −x). */
function rotY90(): Matrix4 {
  return new Matrix4().set(
    0, 0, 1, 0,
    0, 1, 0, 0,
    -1, 0, 0, 0,
    0, 0, 0, 1,
  );
}

/** Rotate 180° about +Y: (x,y,z) → (−x, y, −z). */
function rotY180(): Matrix4 {
  return new Matrix4().set(
    -1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, -1, 0,
    0, 0, 0, 1,
  );
}

/** Rotate 180° about +Z: (x,y,z) → (−x, −y, z). */
function rotZ180(): Matrix4 {
  return new Matrix4().set(
    -1, 0, 0, 0,
    0, -1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  );
}

/** Rotate 90° about +X: (x,y,z) → (x, −z, y). */
function rotX90(): Matrix4 {
  return new Matrix4().set(
    1, 0, 0, 0,
    0, 0, -1, 0,
    0, 1, 0, 0,
    0, 0, 0, 1,
  );
}

/** Rotate 180° about +X: (x,y,z) → (x, −y, −z). */
function rotX180(): Matrix4 {
  return new Matrix4().set(
    1, 0, 0, 0,
    0, -1, 0, 0,
    0, 0, -1, 0,
    0, 0, 0, 1,
  );
}

/** Reflect across YZ (x → −x). */
function reflectX(): Matrix4 {
  return new Matrix4().set(
    -1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  );
}

/**
 * Twelve gallery configurations (best-effort Oh-aligned poses from the Rhino grid).
 *
 * Unit resting pose: length along +X [0,3], width along +Y [0,2], height +Z [0,2],
 * ramp at the −X end.
 *
 * Visual confirmation on uniqueness.html is the gate before trusting the matrix.
 */
export const GALLERY_CONFIGS: ShapeConfig[] = [
  {
    id: 'c01',
    label: '1 · Side-by-side parallel',
    instances: [
      { transform: identityTransform() },
      { transform: ohTransform(I(), 0, 2, 0) },
    ],
  },
  {
    id: 'c02',
    label: '2 · L-shape (second down)',
    instances: [
      { transform: identityTransform() },
      { transform: ohTransform(rotY90(), 0, 2, 0) },
    ],
  },
  {
    id: 'c03',
    label: '3 · Side-by-side antiparallel',
    instances: [
      { transform: identityTransform() },
      { transform: ohTransform(rotZ180(), 3, 4, 0) },
    ],
  },
  {
    id: 'c04',
    label: '4 · T / vertical on top',
    instances: [
      { transform: identityTransform() },
      { transform: ohTransform(rotX90(), 1, 0, 2) },
    ],
  },
  {
    id: 'c05',
    label: '5 · Inverted stack (flip on slope)',
    instances: [
      { transform: identityTransform() },
      { transform: ohTransform(rotX180(), 0, 2, 2) },
    ],
  },
  {
    id: 'c06',
    label: '6 · L-shape (alt vertical)',
    instances: [
      { transform: identityTransform() },
      { transform: ohTransform(rotX90(), 0, 2, 0) },
    ],
  },
  {
    id: 'c07',
    label: '7 · Cap / opposing ramps',
    instances: [
      { transform: identityTransform() },
      { transform: ohTransform(rotY180(), 3, 0, 0) },
    ],
  },
  {
    id: 'c08',
    label: '8 · Vertical reverse',
    instances: [
      { transform: identityTransform() },
      {
        transform: ohTransform(
          new Matrix4().multiplyMatrices(rotZ180(), rotX90()),
          1,
          2,
          2,
        ),
      },
    ],
  },
  {
    id: 'c09',
    label: '9 · Side-by-side offset antiparallel',
    instances: [
      { transform: identityTransform() },
      // Distinct from c03 by a +1 X offset on the second unit
      { transform: ohTransform(rotZ180(), 4, 4, 0) },
    ],
  },
  {
    id: 'c10',
    label: '10 · End-to-end linear',
    instances: [
      { transform: identityTransform() },
      { transform: ohTransform(I(), 3, 0, 0) },
    ],
  },
  {
    id: 'c11',
    label: '11 · Parallel offset (shift +1)',
    instances: [
      { transform: identityTransform() },
      { transform: ohTransform(I(), 1, 2, 0) },
    ],
  },
  {
    id: 'c12',
    label: '12 · Single unit (reference)',
    instances: [{ transform: identityTransform() }],
  },
];

/** Synthetic: two identical single-unit configs (ground truth match). */
export function syntheticIdenticalPair(): [ShapeConfig, ShapeConfig] {
  return [
    {
      id: 'syn-a',
      label: 'Synthetic A',
      instances: [{ transform: identityTransform() }],
    },
    {
      id: 'syn-b',
      label: 'Synthetic B (same)',
      instances: [{ transform: identityTransform() }],
    },
  ];
}

/** Synthetic: single unit vs end-to-end dimer (ground truth mismatch). */
export function syntheticDistinctPair(): [ShapeConfig, ShapeConfig] {
  return [
    {
      id: 'syn-unit',
      label: 'Synthetic unit',
      instances: [{ transform: identityTransform() }],
    },
    {
      id: 'syn-dimer',
      label: 'Synthetic dimer',
      instances: [
        { transform: identityTransform() },
        { transform: ohTransform(I(), 3, 0, 0) },
      ],
    },
  ];
}

/**
 * Chiral L-dimer and its world-space mirror (across YZ, then shifted).
 * With full Oh these share a fingerprint. The dimer may still be rotatable
 * into its mirror; use `chiralPointSets()` for a rotations-only distinction test.
 */
export function chiralMirrorPair(): [ShapeConfig, ShapeConfig] {
  const left: ShapeConfig = {
    id: 'chiral-L',
    label: 'Chiral L-dimer',
    instances: [
      { transform: identityTransform() },
      { transform: ohTransform(rotX90(), 0, 2, 0) },
    ],
  };

  const rx = reflectX();
  const rightInstances = left.instances.map((inst) => {
    const m = new Matrix4().multiplyMatrices(
      ohTransform(rx, 3, 0, 0),
      inst.transform,
    );
    return { transform: m };
  });

  const right: ShapeConfig = {
    id: 'chiral-R',
    label: 'Chiral R-dimer (mirror)',
    instances: rightInstances,
  };

  return [left, right];
}

/**
 * Explicitly chiral lattice point sets (a "screw" of 4 points) and their
 * YZ mirrors. No rotational Oh map takes one to the other; reflections do.
 */
export function chiralPointSets(): {
  left: Vector3[];
  right: Vector3[];
} {
  const left = [
    new Vector3(0, 0, 0),
    new Vector3(1, 0, 0),
    new Vector3(1, 1, 0),
    new Vector3(1, 1, 1),
  ];
  const right = left.map((p) => new Vector3(-p.x, p.y, p.z));
  return { left, right };
}
