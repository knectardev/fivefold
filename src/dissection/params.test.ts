import { describe, expect, it } from 'vitest';
import {
  analyticalVolumes,
  equalVolumeRadius,
  makeParams,
  sphericalCapVolume,
} from './params';

describe('dissection params', () => {
  it('matches cube and ball volume', () => {
    const p = makeParams(1);
    const v = analyticalVolumes(p);
    expect(v.cube).toBeCloseTo(1, 12);
    expect(v.ball).toBeCloseTo(1, 12);
    expect(p.R).toBeCloseTo(equalVolumeRadius(1), 12);
  });

  it('places R between inscribed and circumscribed spheres', () => {
    const p = makeParams(1);
    expect(p.R).toBeGreaterThan(0.5);
    expect(p.R).toBeLessThan(Math.sqrt(3) / 2);
  });

  it('equates total caps and total corners', () => {
    const v = analyticalVolumes(makeParams(1));
    expect(v.allCaps).toBeCloseTo(v.allCorners, 12);
    expect(v.allCaps).toBeCloseTo(6 * v.oneCap, 12);
    expect(v.allCorners).toBeCloseTo(8 * v.oneCorner, 12);
    expect(v.core).toBeCloseTo(v.cube - v.allCorners, 12);
    expect(v.oneCap / v.oneCorner).toBeCloseTo(4 / 3, 10);
  });

  it('cap formula matches known value', () => {
    const R = 1;
    const h = 0.2;
    expect(sphericalCapVolume(R, h)).toBeCloseTo(
      (1 / 3) * Math.PI * h * h * (3 * R - h),
      12,
    );
  });
});
