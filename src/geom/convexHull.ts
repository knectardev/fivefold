import { BufferGeometry, Vector3 } from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';

function uniquePoints(points: Vector3[], eps = 1e-5): Vector3[] {
  const out: Vector3[] = [];
  for (const p of points) {
    if (!out.some((q) => q.distanceToSquared(p) < eps * eps)) {
      out.push(p.clone());
    }
  }
  return out;
}

export function finalizeHull(points: Vector3[]): BufferGeometry {
  const unique = uniquePoints(points);
  if (unique.length < 4) {
    throw new Error('finalizeHull: need at least 4 points');
  }
  const geo = new ConvexGeometry(unique);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}
