import {
  BufferGeometry,
  Float32BufferAttribute,
  Uint32BufferAttribute,
} from 'three';

export interface SerializedGeometry {
  position: Float32Array;
  normal: Float32Array | null;
  index: Uint32Array | null;
}

export function serializeGeometry(geo: BufferGeometry): SerializedGeometry {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const index = geo.index;

  // Respect drawRange when present (CSG leftover buffers).
  const start = geo.drawRange.start;
  const rawCount = geo.drawRange.count;
  const fullCount = index ? index.count : pos.count;
  const count =
    rawCount === Infinity || rawCount < 0 || rawCount > fullCount
      ? fullCount - start
      : rawCount;

  if (index) {
    const positions: number[] = [];
    const normals: number[] = [];
    const triCount = Math.floor(count / 3);
    for (let t = 0; t < triCount; t++) {
      const base = start + t * 3;
      for (let k = 0; k < 3; k++) {
        const vi = index.getX(base + k);
        positions.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
        if (nor) {
          normals.push(nor.getX(vi), nor.getY(vi), nor.getZ(vi));
        }
      }
    }
    return {
      position: new Float32Array(positions),
      normal: nor ? new Float32Array(normals) : null,
      index: null,
    };
  }

  const pArr = (pos.array as Float32Array).slice(start * 3, (start + count) * 3);
  const nArr = nor
    ? (nor.array as Float32Array).slice(start * 3, (start + count) * 3)
    : null;
  return { position: pArr, normal: nArr, index: null };
}

export function deserializeGeometry(data: SerializedGeometry): BufferGeometry {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(data.position, 3));
  if (data.normal && data.normal.length === data.position.length) {
    geo.setAttribute('normal', new Float32BufferAttribute(data.normal, 3));
  } else {
    geo.computeVertexNormals();
  }
  if (data.index) {
    geo.setIndex(new Uint32BufferAttribute(data.index, 1));
  }
  return geo;
}

export function transferablesFor(geos: SerializedGeometry[]): Transferable[] {
  const out: Transferable[] = [];
  for (const g of geos) {
    out.push(g.position.buffer);
    if (g.normal) out.push(g.normal.buffer);
    if (g.index) out.push(g.index.buffer);
  }
  return out;
}
