import {
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  Matrix4,
  Vector3,
} from 'three';
import { Brush, INTERSECTION } from 'three-bvh-csg';
import type { DesignParams, Skeleton } from '../model/types';
import { effectiveMacroSize } from '../model/types';
import { computeHalfPoses } from '../model/fk';
import { finalizeHull } from './convexHull';
import type { PartHalvesGeometry } from './hull';
import { createEvaluator } from './csgEvaluator';
import { prepareForCsg } from './prepareForCsg';
import { inflateGeometry } from './csgEpsilon';
import { macroClipPlanes } from './convexClip';

export type PosedHalfPair = {
  halfA: BufferGeometry;
  halfB: BufferGeometry;
  matrixA: Matrix4;
  matrixB: Matrix4;
};

export type ContactPlaneGeos = {
  fill: BufferGeometry;
  outline: BufferGeometry;
};

function geometryWorldPoints(
  geo: BufferGeometry,
  matrix: Matrix4,
): Vector3[] {
  const pos = geo.attributes.position as BufferAttribute;
  const pts: Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    pts.push(new Vector3().fromBufferAttribute(pos, i).applyMatrix4(matrix));
  }
  return pts;
}

function partWorldHull(pair: PosedHalfPair): BufferGeometry | null {
  const pts = [
    ...geometryWorldPoints(pair.halfA, pair.matrixA),
    ...geometryWorldPoints(pair.halfB, pair.matrixB),
  ];
  if (pts.length < 4) return null;
  try {
    return finalizeHull(pts);
  } catch {
    return null;
  }
}

function uniquePoints(points: Vector3[], eps = 1e-5): Vector3[] {
  const out: Vector3[] = [];
  for (const p of points) {
    if (!out.some((q) => q.distanceToSquared(p) < eps * eps)) {
      out.push(p.clone());
    }
  }
  return out;
}

function aabbOverlap(a: BufferGeometry, b: BufferGeometry, pad = 0.03): boolean {
  a.computeBoundingBox();
  b.computeBoundingBox();
  const A = a.boundingBox;
  const B = b.boundingBox;
  if (!A || !B) return false;
  return (
    A.min.x <= B.max.x + pad &&
    A.max.x >= B.min.x - pad &&
    A.min.y <= B.max.y + pad &&
    A.max.y >= B.min.y - pad &&
    A.min.z <= B.max.z + pad &&
    A.max.z >= B.min.z - pad
  );
}

function meshCentroid(geo: BufferGeometry): Vector3 {
  const pos = geo.attributes.position as BufferAttribute;
  const c = new Vector3();
  if (!pos || pos.count === 0) return c;
  for (let i = 0; i < pos.count; i++) {
    c.x += pos.getX(i);
    c.y += pos.getY(i);
    c.z += pos.getZ(i);
  }
  return c.multiplyScalar(1 / pos.count);
}

function overlapVolume(geo: BufferGeometry): number {
  geo.computeBoundingBox();
  const box = geo.boundingBox;
  if (!box) return 0;
  const s = new Vector3();
  box.getSize(s);
  return Math.max(0, s.x) * Math.max(0, s.y) * Math.max(0, s.z);
}

function sliceMeshByPlane(
  geo: BufferGeometry,
  n: Vector3,
  d: number,
  eps = 2e-3,
): Vector3[] {
  const pos = geo.attributes.position as BufferAttribute;
  if (!pos || pos.count < 3) return [];

  const get = (i: number) =>
    new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));

  const edgeKeys = new Set<string>();
  const hits: Vector3[] = [];

  const considerEdge = (i0: number, i1: number) => {
    const key = i0 < i1 ? `${i0},${i1}` : `${i1},${i0}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    const a = get(i0);
    const b = get(i1);
    const da = n.dot(a) - d;
    const db = n.dot(b) - d;
    if (Math.abs(da) <= eps) hits.push(a);
    if (Math.abs(db) <= eps) hits.push(b);
    if (da * db < 0) hits.push(a.clone().lerp(b, da / (da - db)));
  };

  if (geo.index) {
    const idx = geo.index;
    for (let t = 0; t < idx.count; t += 3) {
      const i0 = idx.getX(t);
      const i1 = idx.getX(t + 1);
      const i2 = idx.getX(t + 2);
      considerEdge(i0, i1);
      considerEdge(i1, i2);
      considerEdge(i2, i0);
    }
  } else {
    for (let i = 0; i + 2 < pos.count; i += 3) {
      considerEdge(i, i + 1);
      considerEdge(i + 1, i + 2);
      considerEdge(i + 2, i);
    }
  }

  const pts = uniquePoints(hits, eps * 2);
  if (pts.length < 3) return [];

  const center = new Vector3();
  for (const p of pts) center.add(p);
  center.multiplyScalar(1 / pts.length);

  const tmp =
    Math.abs(n.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const u = new Vector3().crossVectors(tmp, n).normalize();
  const v = new Vector3().crossVectors(n, u).normalize();

  pts.sort((a, b) => {
    const aa = Math.atan2(
      v.dot(a.clone().sub(center)),
      u.dot(a.clone().sub(center)),
    );
    const bb = Math.atan2(
      v.dot(b.clone().sub(center)),
      u.dot(b.clone().sub(center)),
    );
    return aa - bb;
  });

  return pts;
}

function polygonArea(poly: Vector3[]): number {
  if (poly.length < 3) return 0;
  const c = new Vector3();
  for (const p of poly) c.add(p);
  c.multiplyScalar(1 / poly.length);
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i].clone().sub(c);
    const b = poly[(i + 1) % poly.length].clone().sub(c);
    area += a.clone().cross(b).length() * 0.5;
  }
  return area;
}

function polygonToGeometry(poly: Vector3[]): BufferGeometry | null {
  if (poly.length < 3) return null;
  const positions: number[] = [];
  const o = poly[0];
  for (let i = 1; i < poly.length - 1; i++) {
    positions.push(o.x, o.y, o.z);
    positions.push(poly[i].x, poly[i].y, poly[i].z);
    positions.push(poly[i + 1].x, poly[i + 1].y, poly[i + 1].z);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

function polygonOutlineGeometry(poly: Vector3[]): BufferGeometry | null {
  if (poly.length < 2) return null;
  const positions: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return geo;
}

function pushPlane(
  results: ContactPlaneGeos[],
  poly: Vector3[],
  minArea: number,
): void {
  if (poly.length < 3 || polygonArea(poly) < minArea) return;
  const fill = polygonToGeometry(poly);
  const outline = polygonOutlineGeometry(poly);
  if (fill && outline) results.push({ fill, outline });
  else {
    fill?.dispose();
    outline?.dispose();
  }
}

function csgIntersection(
  a: BufferGeometry,
  b: BufferGeometry,
): BufferGeometry | null {
  const evaluator = createEvaluator();
  const brushA = new Brush(prepareForCsg(a));
  const brushB = new Brush(prepareForCsg(b));
  brushA.updateMatrixWorld(true);
  brushB.updateMatrixWorld(true);
  try {
    const hit = evaluator.evaluate(brushA, brushB, INTERSECTION);
    const geo = hit.geometry.clone();
    hit.geometry.dispose();
    brushA.geometry.dispose();
    brushB.geometry.dispose();
    const pos = geo.getAttribute('position');
    if (!pos || pos.count < 9) {
      geo.dispose();
      return null;
    }
    return geo;
  } catch {
    brushA.geometry.dispose();
    brushB.geometry.dispose();
    return null;
  }
}

function hullTouchesWall(
  geo: BufferGeometry,
  n: Vector3,
  d: number,
  eps = 0.02,
): boolean {
  const pos = geo.attributes.position as BufferAttribute;
  if (!pos) return false;
  let near = 0;
  let inside = 0;
  for (let i = 0; i < pos.count; i++) {
    const s = n.x * pos.getX(i) + n.y * pos.getY(i) + n.z * pos.getZ(i) - d;
    if (s <= eps) inside++;
    if (Math.abs(s) <= eps) near++;
  }
  return near >= 3 && inside >= 3;
}

/** Triangles whose vertices lie on the sphere surface (macro wall contact). */
function facesOnSphere(
  geo: BufferGeometry,
  radius: number,
  eps = 0.04,
): Vector3[][] {
  const pos = geo.attributes.position as BufferAttribute;
  if (!pos) return [];
  const get = (i: number) =>
    new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
  const onSphere = (p: Vector3) => Math.abs(p.length() - radius) <= eps;
  const out: Vector3[][] = [];

  const addTri = (i0: number, i1: number, i2: number) => {
    const a = get(i0);
    const b = get(i1);
    const c = get(i2);
    if (onSphere(a) && onSphere(b) && onSphere(c)) {
      out.push([a, b, c]);
    }
  };

  if (geo.index) {
    const idx = geo.index;
    for (let t = 0; t < idx.count; t += 3) {
      addTri(idx.getX(t), idx.getX(t + 1), idx.getX(t + 2));
    }
  } else {
    for (let i = 0; i + 2 < pos.count; i += 3) addTri(i, i + 1, i + 2);
  }
  return out;
}

/**
 * Contact planes from shared overlap:
 * - part: CSG part–part intersections (bisector slice through overlap)
 * - bound: faces where a part touches the macro wall / sphere shell
 */
export function computePartIntersectionPlanes(
  skeleton: Skeleton,
  params: DesignParams,
  pairs: PosedHalfPair[],
): { part: ContactPlaneGeos[]; bound: ContactPlaneGeos[] } {
  const n = pairs.length;
  if (n < 1) return { part: [], bound: [] };

  const hulls: (BufferGeometry | null)[] = pairs.map(partWorldHull);
  const part: ContactPlaneGeos[] = [];
  const bound: ContactPlaneGeos[] = [];
  const minArea = 0.005;
  const minVolume = 1e-5;
  const macro = effectiveMacroSize(params);
  const wallPlanes = macroClipPlanes(params, macro);

  try {
    for (let i = 0; i < n; i++) {
      const hi = hulls[i];
      if (!hi) continue;
      for (let j = i + 1; j < n; j++) {
        // Interior contacts: only those involving the selected part.
        if (i !== params.activePart && j !== params.activePart) continue;
        const hj = hulls[j];
        if (!hj) continue;
        if (!aabbOverlap(hi, hj, 0.04)) continue;

        const seedI = skeleton.parts[i].origin;
        const seedJ = skeleton.parts[j].origin;
        const delta = seedJ.clone().sub(seedI);
        if (delta.lengthSq() < 1e-12) continue;
        const nrm = delta.normalize();

        // Tiny inflate so zero-gap abutting faces still produce an intersection.
        const ai = inflateGeometry(hi.clone(), 0.012);
        const bi = inflateGeometry(hj.clone(), 0.012);
        let overlap = csgIntersection(ai, bi);
        ai.dispose();
        bi.dispose();

        if (!overlap || overlapVolume(overlap) < minVolume) {
          overlap?.dispose();
          continue;
        }

        try {
          const center = meshCentroid(overlap);
          const poly = sliceMeshByPlane(overlap, nrm, nrm.dot(center));
          pushPlane(part, poly, minArea);
        } finally {
          overlap.dispose();
        }
      }
    }

    for (let i = 0; i < n; i++) {
      const hi = hulls[i];
      if (!hi) continue;
      // Bound contacts: only the selected part (activePart).
      if (i !== params.activePart) continue;

      if (params.macroShape === 'sphere') {
        // Bound contacts = faces on the curved sphere surface.
        const R = macro * 0.5;
        const spherePolys = facesOnSphere(hi, R);
        for (const poly of spherePolys) pushPlane(bound, poly, minArea);
        continue;
      }

      for (const wall of wallPlanes) {
        if (!hullTouchesWall(hi, wall.n, wall.d)) continue;
        const poly = sliceMeshByPlane(hi, wall.n, wall.d);
        pushPlane(bound, poly, minArea);
      }
    }
  } finally {
    for (const h of hulls) h?.dispose();
  }

  return { part, bound };
}

/** @deprecated */
export function computePartIntersectionGeometries(
  pairs: PosedHalfPair[],
): BufferGeometry[] {
  void pairs;
  return [];
}

export function posedPairsFromHalves(
  halves: PartHalvesGeometry[],
  skeleton: Skeleton,
  params: DesignParams,
): PosedHalfPair[] {
  const poses = computeHalfPoses(skeleton, params);
  return halves.map((h, i) => ({
    halfA: h.halfA,
    halfB: h.halfB,
    matrixA: poses[i].halfA.matrix,
    matrixB: poses[i].halfB.matrix,
  }));
}
