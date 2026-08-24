import { BufferAttribute, BufferGeometry, Vector3 } from 'three';

/**
 * Signed volume of a closed triangle mesh via the divergence theorem:
 * V = (1/6) Σ a · (b × c) over oriented triangles.
 */
export function meshVolume(geometry: BufferGeometry): number {
  const pos = geometry.attributes.position as BufferAttribute | undefined;
  if (!pos || pos.count < 3) return 0;

  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  let sum = 0;

  const add = (i0: number, i1: number, i2: number) => {
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    sum += a.dot(new Vector3().crossVectors(b, c));
  };

  const index = geometry.index;
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      add(index.getX(i), index.getX(i + 1), index.getX(i + 2));
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      add(i, i + 1, i + 2);
    }
  }

  return Math.abs(sum) / 6;
}
