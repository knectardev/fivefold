import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { CSG_EPSILON } from '../model/types';
import { prepareForCsg } from './prepareForCsg';

/** Uniformly inflate a mesh about its bounding-sphere center. */
export function inflateGeometry(
  geometry: BufferGeometry,
  amount: number,
): BufferGeometry {
  const geo = prepareForCsg(geometry);
  geo.computeBoundingSphere();
  const center = geo.boundingSphere?.center.clone() ?? new Vector3();
  const radius = geo.boundingSphere?.radius ?? 1;
  if (radius < 1e-8) return geo;

  const scale = 1 + amount / radius;
  const pos = geo.attributes.position as BufferAttribute;
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.sub(center).multiplyScalar(scale).add(center);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

export function inflateByEpsilon(geometry: BufferGeometry): BufferGeometry {
  return inflateGeometry(geometry, CSG_EPSILON);
}

/** Shrink toward center (clearance / soften). */
export function shrinkGeometry(
  geometry: BufferGeometry,
  amount: number,
): BufferGeometry {
  if (amount <= 0) return prepareForCsg(geometry);
  return inflateGeometry(geometry, -amount);
}
