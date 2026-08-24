import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshStandardMaterial,
} from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

/**
 * Produce export-safe geometry from three-bvh-csg output.
 * CSG often only shrinks drawRange, leaving ghost triangles in the buffer.
 */
export function cleanGeometryForExport(source: BufferGeometry): BufferGeometry {
  const geo = source.clone();
  const { start, count: rawCount } = geo.drawRange;
  const index = geo.index;
  const pos = geo.attributes.position;

  if (!pos) {
    return new BufferGeometry();
  }

  const fullCount = index ? index.count : pos.count;
  const count =
    rawCount === Infinity || rawCount < 0 || rawCount > fullCount
      ? fullCount - start
      : rawCount;

  const normalAttr = geo.attributes.normal;

  if (index) {
    const newPositions: number[] = [];
    const newNormals: number[] = [];
    const triCount = Math.floor(count / 3);
    for (let t = 0; t < triCount; t++) {
      const base = start + t * 3;
      for (let k = 0; k < 3; k++) {
        const vi = index.getX(base + k);
        newPositions.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
        if (normalAttr) {
          newNormals.push(
            normalAttr.getX(vi),
            normalAttr.getY(vi),
            normalAttr.getZ(vi),
          );
        }
      }
    }
    const out = new BufferGeometry();
    out.setAttribute('position', new Float32BufferAttribute(newPositions, 3));
    if (newNormals.length === newPositions.length) {
      out.setAttribute('normal', new Float32BufferAttribute(newNormals, 3));
    } else {
      out.computeVertexNormals();
    }
    return out;
  }

  const out = new BufferGeometry();
  const pArr = (pos.array as Float32Array).slice(start * 3, (start + count) * 3);
  out.setAttribute('position', new Float32BufferAttribute(pArr, 3));
  if (normalAttr) {
    const nArr = (normalAttr.array as Float32Array).slice(
      start * 3,
      (start + count) * 3,
    );
    out.setAttribute('normal', new Float32BufferAttribute(nArr, 3));
  } else {
    out.computeVertexNormals();
  }
  return out;
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportPartStl(
  geometry: BufferGeometry,
  filename: string,
): void {
  const cleaned = cleanGeometryForExport(geometry);
  const mesh = new Mesh(cleaned, new MeshStandardMaterial());
  const exporter = new STLExporter();
  const result = exporter.parse(mesh, { binary: true });
  cleaned.dispose();

  const blob = new Blob([result as BlobPart], {
    type: 'application/octet-stream',
  });
  downloadBlob(filename, blob);
}

export function exportAllPartsStl(geometries: BufferGeometry[]): void {
  geometries.forEach((geo, i) => {
    exportPartStl(geo, `kinetic-part-${i + 1}.stl`);
  });
}
