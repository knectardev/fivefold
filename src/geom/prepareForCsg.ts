import { BufferGeometry } from 'three';

/**
 * Normalize geometry for three-bvh-csg: non-indexed, position+normal only,
 * watertight-friendly vertex normals, no groups.
 */
export function prepareForCsg(geometry: BufferGeometry): BufferGeometry {
  let geo = geometry.clone();
  if (geo.index) {
    geo = geo.toNonIndexed();
  }

  for (const key of Object.keys(geo.attributes)) {
    if (key !== 'position' && key !== 'normal') {
      geo.deleteAttribute(key);
    }
  }

  // Drop morph/attributes that confuse GeometryBuilder
  geo.morphAttributes = {};
  geo.clearGroups();
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}
