import { tetrahedronStruts } from '../geom/convexClip';
import { eulerDegreesFromAxis } from './skeleton';
import { ensurePartCount, type DesignParams } from './types';

/** Circumradius of the strut guide (from its own size, not the macro bound). */
export function strutGuideRadius(params: DesignParams): number {
  return Math.max(params.strutGuideSize, 0.5) * 0.5;
}

/**
 * Place one part per strut of the active guide. Tetrahedron → 6 parts, each
 * midplane at the edge midpoint with rotation axis along the edge.
 * Half extents span the strut (vertex to midplane). Global plane radius,
 * tilt, and each part's current N-fold are preserved (or defaults applied).
 */
export function applyStrutGuideAlignment(params: DesignParams): boolean {
  if (params.strutGuide !== 'tetrahedron') return false;

  params.layoutMode = 'free';
  params.partCount = 6;
  ensurePartCount(params);

  const struts = tetrahedronStruts(
    strutGuideRadius(params),
    params.strutGuideRotX,
    params.strutGuideRotY,
    params.strutGuideRotZ,
  );

  for (let i = 0; i < struts.length; i++) {
    const strut = struts[i];
    const part = params.parts[i];
    const euler = eulerDegreesFromAxis(strut.dir);
    const half = Math.max(0.1, strut.length * 0.5);

    part.posX = strut.mid.x;
    part.posY = strut.mid.y;
    part.posZ = strut.mid.z;
    part.rotX = euler.rotX;
    part.rotY = euler.rotY;
    part.rotZ = euler.rotZ;
    part.angle = 0;
    part.angleA = 0;
    part.halfExtentA = half;
    part.halfExtentB = half;
    if (typeof part.planeRadius !== 'number') {
      part.planeRadius = params.contactRadius;
    }
    if (typeof part.protrusionTilt !== 'number') {
      part.protrusionTilt = params.protrusionTilt;
    }
    part.visible = true;
  }

  params.activePart = Math.min(params.activePart, 5);
  return true;
}
