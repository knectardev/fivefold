import { BufferGeometry, Matrix4, Quaternion, Vector3 } from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import type { DesignParams, Skeleton } from '../model/types';
import { offsetPolygon, planePolygon } from './contactPolygon';
import { radialSides } from './hull';

/** Preview overlay of the interior N-gon prism (not boolean-carved). */
export function buildInteriorEnvelopes(
  skeleton: Skeleton,
  params: DesignParams,
): BufferGeometry[] {
  const envelopes: BufferGeometry[] = [];
  for (const part of skeleton.parts) {
    const sides = radialSides(part.symmetryN, params.facetComplexity);
    const radius = params.contactRadius * 1.05;
    const half = Math.min(params.linkLength * 0.2, params.contactRadius * 0.8);
    const ring = planePolygon(part, radius, sides);
    const points: Vector3[] = [
      ...offsetPolygon(ring, part.axis, half),
      ...offsetPolygon(ring, part.axis, -half),
    ];

    // Spin rings for snap preview silhouette.
    const step = (Math.PI * 2) / part.symmetryN;
    const origin = part.origin;
    const q = new Quaternion();
    const R = new Matrix4();
    const T1 = new Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z);
    const T2 = new Matrix4().makeTranslation(origin.x, origin.y, origin.z);
    const spun: Vector3[] = [];
    for (let i = 0; i < part.symmetryN; i++) {
      q.setFromAxisAngle(part.axis, i * step);
      R.makeRotationFromQuaternion(q);
      const M = new Matrix4().multiplyMatrices(T2, R).multiply(T1);
      for (const p of points) spun.push(p.clone().applyMatrix4(M));
    }

    const geo = new ConvexGeometry(spun);
    geo.computeVertexNormals();
    envelopes.push(geo);
  }
  return envelopes;
}

/** @deprecated name kept for older imports — clearance is parametric in hulls. */
export function applySweptClearance(
  parts: BufferGeometry[],
  _skeleton: Skeleton,
  _params: DesignParams,
  options: { keepEnvelopes?: boolean } = {},
): { parts: BufferGeometry[]; envelopes: BufferGeometry[] } {
  void options;
  return { parts: parts.map((p) => p.clone()), envelopes: [] };
}
