import { Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  fingerprintConfig,
  fingerprintPoints,
  identityTransform,
  ohTransform,
} from './canonicalize';
import {
  chiralMirrorPair,
  chiralPointSets,
  syntheticDistinctPair,
  syntheticIdenticalPair,
} from './configs12';
import { OH_ROTATIONS } from './octahedralGroup';
import { UNIT_SOLID } from './unitShape';
import type { ShapeConfig } from './types';

describe('canonicalize (synthetic ground truth)', () => {
  it('identical configs share a fingerprint', () => {
    const [a, b] = syntheticIdenticalPair();
    expect(fingerprintConfig(a, UNIT_SOLID)).toBe(
      fingerprintConfig(b, UNIT_SOLID),
    );
  });

  it('explicitly different geometry yields different fingerprints', () => {
    const [a, b] = syntheticDistinctPair();
    expect(fingerprintConfig(a, UNIT_SOLID)).not.toBe(
      fingerprintConfig(b, UNIT_SOLID),
    );
  });

  it('global translation does not change fingerprint', () => {
    const base: ShapeConfig = {
      id: 'base',
      label: 'base',
      instances: [{ transform: identityTransform() }],
    };
    const shifted: ShapeConfig = {
      id: 'shifted',
      label: 'shifted',
      instances: [{ transform: ohTransform(new Matrix4().identity(), 5, -3, 2) }],
    };
    expect(fingerprintConfig(base, UNIT_SOLID)).toBe(
      fingerprintConfig(shifted, UNIT_SOLID),
    );
  });

  it('each of 24 proper rotations of one config yields the same fingerprint', () => {
    const base: ShapeConfig = {
      id: 'base',
      label: 'base',
      instances: [{ transform: identityTransform() }],
    };
    const expected = fingerprintConfig(base, UNIT_SOLID);
    for (const R of OH_ROTATIONS) {
      const rotated: ShapeConfig = {
        id: 'rot',
        label: 'rot',
        instances: [{ transform: R.clone() }],
      };
      expect(fingerprintConfig(rotated, UNIT_SOLID)).toBe(expected);
    }
  });

  it('chiral mirror pair collapses with reflections (full Oh)', () => {
    const [left, right] = chiralMirrorPair();
    const fpL = fingerprintConfig(left, UNIT_SOLID, {
      includeReflections: true,
    });
    const fpR = fingerprintConfig(right, UNIT_SOLID, {
      includeReflections: true,
    });
    expect(fpL).toBe(fpR);
  });

  it('chiral screw point set stays distinct under rotations-only', () => {
    const { left, right } = chiralPointSets();
    const fpL = fingerprintPoints(left, { includeReflections: false });
    const fpR = fingerprintPoints(right, { includeReflections: false });
    expect(fpL).not.toBe(fpR);
  });

  it('chiral screw point set collapses with reflections', () => {
    const { left, right } = chiralPointSets();
    const fpL = fingerprintPoints(left, { includeReflections: true });
    const fpR = fingerprintPoints(right, { includeReflections: true });
    expect(fpL).toBe(fpR);
  });

  it('sorts vertices so order does not matter', () => {
    const ptsA = UNIT_SOLID.vertices.map(([x, y, z]) => new Vector3(x, y, z));
    const ptsB = [...ptsA].reverse();
    expect(fingerprintPoints(ptsA)).toBe(fingerprintPoints(ptsB));
  });
});
