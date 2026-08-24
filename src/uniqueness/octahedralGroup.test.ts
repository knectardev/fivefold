import { describe, expect, it } from 'vitest';
import {
  OH_GROUP,
  OH_ROTATIONS,
  determinant3,
  matrixKey,
  multiplyOh,
} from './octahedralGroup';

describe('octahedralGroup', () => {
  it('has 48 elements', () => {
    expect(OH_GROUP).toHaveLength(48);
  });

  it('has 24 proper rotations', () => {
    expect(OH_ROTATIONS).toHaveLength(24);
  });

  it('contains only dets ±1', () => {
    for (const m of OH_GROUP) {
      const d = determinant3(m);
      expect(Math.abs(Math.abs(d) - 1) < 1e-9).toBe(true);
    }
  });

  it('has unique matrix keys', () => {
    const keys = new Set(OH_GROUP.map(matrixKey));
    expect(keys.size).toBe(48);
  });

  it('is closed under multiplication', () => {
    const keys = new Set(OH_GROUP.map(matrixKey));
    for (const a of OH_GROUP) {
      for (const b of OH_GROUP) {
        const prod = multiplyOh(a, b);
        expect(keys.has(matrixKey(prod))).toBe(true);
      }
    }
  });
});
