import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { tetrahedronStruts, TETRA_EDGES } from '../geom/convexClip';
import { axesFromPartEuler, eulerDegreesFromAxis } from '../model/skeleton';
import { defaultParams } from '../model/types';
import { applyStrutGuideAlignment } from '../model/strutGuide';

describe('tetra strut guide', () => {
  it('has six edges', () => {
    expect(TETRA_EDGES).toHaveLength(6);
    expect(tetrahedronStruts(1)).toHaveLength(6);
  });

  it('round-trips axis through ZYX euler', () => {
    const dirs = [
      new Vector3(1, 0, 0),
      new Vector3(0, 1, 0),
      new Vector3(0, 0, 1),
      new Vector3(1, 1, 0).normalize(),
      new Vector3(-0.2, 0.7, 0.5).normalize(),
    ];
    for (const dir of dirs) {
      const e = eulerDegreesFromAxis(dir);
      const { axis } = axesFromPartEuler(e.rotX, e.rotY, e.rotZ);
      expect(axis.dot(dir)).toBeGreaterThan(0.999);
    }
  });

  it('aligns six parts to tetra struts', () => {
    const params = defaultParams();
    params.strutGuide = 'tetrahedron';
    params.strutGuideRotY = 25;
    expect(applyStrutGuideAlignment(params)).toBe(true);
    expect(params.partCount).toBe(6);
    expect(params.parts).toHaveLength(6);
    expect(params.layoutMode).toBe('free');

    const struts = tetrahedronStruts(
      params.strutGuideSize * 0.5,
      params.strutGuideRotX,
      params.strutGuideRotY,
      params.strutGuideRotZ,
    );
    for (let i = 0; i < 6; i++) {
      const p = params.parts[i];
      const { axis } = axesFromPartEuler(p.rotX, p.rotY, p.rotZ);
      expect(axis.dot(struts[i].dir)).toBeGreaterThan(0.999);
      expect(
        Math.hypot(p.posX - struts[i].mid.x, p.posY - struts[i].mid.y, p.posZ - struts[i].mid.z),
      ).toBeLessThan(1e-6);
    }
  });
});
