import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { FACES, makeParams } from './params';
import {
  alignRayFlipTwist,
  buildRigidPieces,
  cornerThirdToCapMatrix,
  faceCapFlip,
} from './pieces';

describe('core + cap-sector dual packing', () => {
  it('faceCapFlip remains a proper isometry', () => {
    expect(faceCapFlip(FACES[4]!, 1).determinant()).toBeCloseTo(1, 10);
  });

  it('alignRayFlipTwist maps centroid and stays rigid', () => {
    const from = new Vector3(0.4, 0.4, 0.4);
    const to = new Vector3(0, 0, 0.55);
    const m = alignRayFlipTwist(from, to, 0.3, true);
    expect(m.determinant()).toBeCloseTo(1, 6);
    expect(from.clone().applyMatrix4(m).distanceTo(to)).toBeLessThan(1e-6);
    expect(cornerThirdToCapMatrix(from, to).determinant()).toBeCloseTo(1, 6);
  });

  it('sphere seats are identity; 32 pieces; transfers relocate for cube', () => {
    const p = makeParams(1);
    const { pieces, cubeVol, sphereTargetVol, notes } = buildRigidPieces(p);

    expect(pieces).toHaveLength(32);
    expect(pieces.filter((x) => x.role === 'core')).toHaveLength(8);
    expect(pieces.filter((x) => x.role === 'transfer')).toHaveLength(24);

    for (const piece of pieces) {
      const e = piece.sphereMatrix.elements;
      expect(Math.hypot(e[12], e[13], e[14])).toBeLessThan(1e-9);
    }

    const travels = pieces
      .filter((x) => x.role === 'transfer')
      .map((t) => {
        t.geometry.computeBoundingBox();
        const c = new Vector3();
        t.geometry.boundingBox!.getCenter(c);
        return c.distanceTo(c.clone().applyMatrix4(t.cubeMatrix));
      });
    expect(Math.min(...travels)).toBeGreaterThan(0.08);
    expect(cubeVol).toBeGreaterThan(0.9);
    expect(sphereTargetVol).toBeGreaterThan(0.9);
    expect(notes.some((n) => n.toLowerCase().includes('exact'))).toBe(true);
  }, 90_000);
});
