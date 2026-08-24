import { describe, expect, it } from 'vitest';
import { buildTheobald11 } from './truncatedOct';

describe('Theobald 11-piece cube ↔ truncated octahedron', () => {
  it('has 11 convex pieces whose digitized volume sums to 1', () => {
    const build = buildTheobald11();
    expect(build.pieces).toHaveLength(11);
    expect(build.translational).toBe(true);
    expect(build.totalVolume).toBeGreaterThan(0.999);
    expect(build.totalVolume).toBeLessThan(1.001);
    for (const piece of build.pieces) {
      expect(piece.volume).toBeGreaterThan(0.01);
      expect(piece.cubeMatrix.elements[12]).not.toBeNaN();
      expect(piece.targetMatrix.elements[12]).not.toBeNaN();
    }
  });
});
