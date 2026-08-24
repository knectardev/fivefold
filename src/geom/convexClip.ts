import { BufferAttribute, BufferGeometry, Euler, Matrix4, Vector3 } from 'three';
import type { DesignParams, MacroShape } from '../model/types';
import { finalizeHull } from './convexHull';
import {
  clipPolyhedron,
  facesToPoints,
  sphereBoundFaces,
  type ClipPlane,
} from './polyhedron';

function uniquePoints(points: Vector3[], eps = 1e-5): Vector3[] {
  const out: Vector3[] = [];
  for (const p of points) {
    if (!out.some((q) => q.distanceToSquared(p) < eps * eps)) {
      out.push(p.clone());
    }
  }
  return out;
}

function geometryToFaces(geo: BufferGeometry): Vector3[][] {
  const pos = geo.attributes.position as BufferAttribute;
  const faces: Vector3[][] = [];
  const tri = (i0: number, i1: number, i2: number) => {
    faces.push([
      new Vector3().fromBufferAttribute(pos, i0),
      new Vector3().fromBufferAttribute(pos, i1),
      new Vector3().fromBufferAttribute(pos, i2),
    ]);
  };
  if (geo.index) {
    const idx = geo.index;
    for (let t = 0; t < idx.count; t += 3) {
      tri(idx.getX(t), idx.getX(t + 1), idx.getX(t + 2));
    }
  } else {
    for (let i = 0; i + 2 < pos.count; i += 3) {
      tri(i, i + 1, i + 2);
    }
  }
  return faces;
}

/**
 * True convex halfspace clip: keep n·x <= d, insert edge hits, add cap face.
 * Never restores pre-clip points (that undid trims).
 */
export function clipConvexPointsByPlane(
  points: Vector3[],
  plane: ClipPlane,
): Vector3[] {
  if (points.length < 4) return uniquePoints(points);
  try {
    const geo = finalizeHull(points);
    let faces = geometryToFaces(geo);
    geo.dispose();
    faces = clipPolyhedron(faces, plane);
    return facesToPoints(faces);
  } catch {
    // Project onto plane as a last resort rather than keeping outsiders.
    return uniquePoints(
      points.map((p) => {
        const s = plane.n.dot(p) - plane.d;
        return s <= 0 ? p.clone() : p.clone().addScaledVector(plane.n, -s);
      }),
    );
  }
}

/** Regular tetrahedron vertices with circumradius `radius`.
 * Apex along +Y; base (verts 1–3) parallel to the XZ (horizontal) plane.
 * Centroid at the origin.
 */
export function tetrahedronVertices(radius: number): Vector3[] {
  // Unit circumradius, then scale. Base y = −1/3 for all three base verts.
  const raw = [
    new Vector3(0, 1, 0),
    new Vector3(Math.sqrt(8 / 9), -1 / 3, 0),
    new Vector3(-Math.sqrt(2 / 9), -1 / 3, Math.sqrt(2 / 3)),
    new Vector3(-Math.sqrt(2 / 9), -1 / 3, -Math.sqrt(2 / 3)),
  ];
  return raw.map((v) => v.multiplyScalar(radius));
}

/** All 6 edges of the tetrahedron (vertex index pairs). */
export const TETRA_EDGES: readonly [number, number][] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
  [2, 3],
];

/** Apply ZYX Euler (degrees) about the origin to tetra vertices. */
export function rotateTetrahedronVertices(
  verts: Vector3[],
  rotX: number,
  rotY: number,
  rotZ: number,
): Vector3[] {
  const e = new Euler(
    (rotX * Math.PI) / 180,
    (rotY * Math.PI) / 180,
    (rotZ * Math.PI) / 180,
    'ZYX',
  );
  const m = new Matrix4().makeRotationFromEuler(e);
  return verts.map((v) => v.clone().applyMatrix4(m));
}

export interface TetraStrut {
  /** Edge midpoint — natural midplane origin. */
  mid: Vector3;
  /** Unit direction along the edge (rotation axis). */
  dir: Vector3;
  /** Full edge length. */
  length: number;
  a: Vector3;
  b: Vector3;
}

/**
 * Six strut axes of a regular tetrahedron (circumradius `radius`), optionally
 * rotated by ZYX Euler degrees about the centroid.
 */
export function tetrahedronStruts(
  radius: number,
  rotX = 0,
  rotY = 0,
  rotZ = 0,
): TetraStrut[] {
  const base = tetrahedronVertices(radius);
  const verts =
    rotX || rotY || rotZ
      ? rotateTetrahedronVertices(base, rotX, rotY, rotZ)
      : base;
  return TETRA_EDGES.map(([i, j]) => {
    const a = verts[i];
    const b = verts[j];
    const dir = b.clone().sub(a);
    const length = dir.length();
    if (length > 1e-12) dir.multiplyScalar(1 / length);
    else dir.set(1, 0, 0);
    return {
      a: a.clone(),
      b: b.clone(),
      mid: a.clone().add(b).multiplyScalar(0.5),
      dir,
      length,
    };
  });
}

/** Inward clip planes for a regular tetrahedron (circumradius = radius). */
export function tetrahedronClipPlanes(radius: number): ClipPlane[] {
  const verts = tetrahedronVertices(radius);
  // Face opposite each vertex (the other three). Index 0 = apex.
  const faces: [number, number, number][] = [
    [1, 3, 2], // base (horizontal), CCW from below → inward +Y
    [0, 1, 2],
    [0, 2, 3],
    [0, 3, 1],
  ];
  return faces.map(([i0, i1, i2]) => {
    const a = verts[i0];
    const b = verts[i1];
    const c = verts[i2];
    const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    // Inward: toward origin.
    if (n.dot(a) > 0) n.negate();
    return { n, d: n.dot(a) };
  });
}

/** Inradius of a regular tetrahedron with circumradius R (R/3). */
export function tetrahedronInradius(circumradius: number): number {
  return circumradius / 3;
}

function convexInteriorPlanesFromPoints(
  points: Vector3[],
): { n: Vector3; d: number }[] {
  if (points.length < 4) return [];
  try {
    const geo = finalizeHull(points);
    const pos = geo.attributes.position as BufferAttribute;
    geo.computeBoundingSphere();
    const center = geo.boundingSphere?.center.clone() ?? new Vector3();
    const planes: { n: Vector3; d: number }[] = [];
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    const n = new Vector3();
    const seen = new Set<string>();

    const addTri = (i0: number, i1: number, i2: number) => {
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      n.subVectors(b, a).cross(c.clone().sub(a));
      if (n.lengthSq() < 1e-14) return;
      n.normalize();
      const mid = a.clone().add(b).add(c).multiplyScalar(1 / 3);
      if (n.dot(mid.clone().sub(center)) < 0) n.negate(); // outward
      const nIn = n.clone().negate();
      const d = nIn.dot(a);
      const key = `${nIn.x.toFixed(3)},${nIn.y.toFixed(3)},${nIn.z.toFixed(3)},${d.toFixed(3)}`;
      if (seen.has(key)) return;
      seen.add(key);
      planes.push({ n: nIn, d });
    };

    if (geo.index) {
      const idx = geo.index;
      for (let t = 0; t < idx.count; t += 3) {
        addTri(idx.getX(t), idx.getX(t + 1), idx.getX(t + 2));
      }
    } else {
      for (let i = 0; i + 2 < pos.count; i += 3) addTri(i, i + 1, i + 2);
    }
    geo.dispose();
    return planes;
  } catch {
    return [];
  }
}

function pointInHalfspaces(
  p: Vector3,
  planes: { n: Vector3; d: number }[],
  eps = 1e-5,
): boolean {
  for (const pl of planes) {
    if (pl.n.dot(p) - pl.d > eps) return false;
  }
  return true;
}

/** Fibonacci lattice on a sphere of radius R. */
function fibonacciSphere(radius: number, count: number): Vector3[] {
  const pts: Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    pts.push(
      new Vector3(
        Math.cos(theta) * r * radius,
        y * radius,
        Math.sin(theta) * r * radius,
      ),
    );
  }
  return pts;
}

/**
 * Clip a convex point cloud to a ball of radius R.
 * Keeps interior verts, edge∩sphere hits, and sphere samples inside the
 * original hull so the cut approximates the curved surface (not one flat plane).
 */
export function clipConvexPointsToSphere(
  points: Vector3[],
  radius: number,
): Vector3[] {
  if (points.length < 4 || radius <= 1e-8) return uniquePoints(points);
  const R = radius;
  const R2 = R * R;
  const planes = convexInteriorPlanesFromPoints(points);
  if (planes.length < 4) {
    return uniquePoints(
      points.map((p) => {
        const len = p.length();
        return len > R && len > 1e-8 ? p.clone().multiplyScalar(R / len) : p.clone();
      }),
    );
  }

  const kept: Vector3[] = [];
  for (const p of points) {
    if (p.lengthSq() <= R2 * 1.0001) kept.push(p.clone());
  }

  // Edge crossings on the sphere from the original hull edges.
  try {
    const geo = finalizeHull(points);
    const pos = geo.attributes.position as BufferAttribute;
    const edges = new Set<string>();
    const addEdge = (i0: number, i1: number) => {
      const key = i0 < i1 ? `${i0},${i1}` : `${i1},${i0}`;
      if (edges.has(key)) return;
      edges.add(key);
      const a = new Vector3().fromBufferAttribute(pos, i0);
      const b = new Vector3().fromBufferAttribute(pos, i1);
      const aIn = a.lengthSq() <= R2;
      const bIn = b.lengthSq() <= R2;
      if (aIn === bIn) return;
      // Quadratic: |a + t(b-a)|^2 = R^2
      const d = b.clone().sub(a);
      const A = d.lengthSq();
      const B = 2 * a.dot(d);
      const C = a.lengthSq() - R2;
      const disc = B * B - 4 * A * C;
      if (disc < 0 || A < 1e-14) return;
      const s = Math.sqrt(disc);
      for (const sign of [-1, 1]) {
        const t = (-B + sign * s) / (2 * A);
        if (t >= -1e-6 && t <= 1 + 1e-6) {
          kept.push(a.clone().addScaledVector(d, Math.min(1, Math.max(0, t))));
        }
      }
    };
    if (geo.index) {
      const idx = geo.index;
      for (let t = 0; t < idx.count; t += 3) {
        addEdge(idx.getX(t), idx.getX(t + 1));
        addEdge(idx.getX(t + 1), idx.getX(t + 2));
        addEdge(idx.getX(t + 2), idx.getX(t));
      }
    } else {
      for (let i = 0; i + 2 < pos.count; i += 3) {
        addEdge(i, i + 1);
        addEdge(i + 1, i + 2);
        addEdge(i + 2, i);
      }
    }
    geo.dispose();
  } catch {
    /* fall through with kept verts */
  }

  // Sphere samples that still lie inside the original solid → curved cap.
  for (const s of fibonacciSphere(R, 64)) {
    if (pointInHalfspaces(s, planes)) kept.push(s);
  }

  const uniq = uniquePoints(kept, 1e-5);
  if (uniq.length < 4) {
    return uniquePoints(
      points.map((p) => {
        const len = p.length();
        return len > R && len > 1e-8 ? p.clone().multiplyScalar(R / len) : p.clone();
      }),
    );
  }
  return uniq;
}

/** Macro domain as inward clip planes (n·x <= d). Sphere uses dedicated radial clip. */
export function macroClipPlanes(
  params: DesignParams,
  macroSize: number,
): ClipPlane[] {
  const half = macroSize * 0.5;
  if (params.macroShape === 'sphere') {
    // Dense polyhedral proxy for callers that need planes (e.g. voronoi seeds).
    // Free-mode solids use clipConvexPointsToSphere instead.
    return sphereBoundFaces(half, 10).map((face) => {
      const a = face[0];
      const b = face[1];
      const c = face[2];
      const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
      const mid = a.clone().add(b).add(c).multiplyScalar(1 / 3);
      if (n.dot(mid) < 0) n.negate();
      const nIn = n.clone().negate();
      return { n: nIn, d: nIn.dot(a) };
    });
  }
  if (params.macroShape === 'tetrahedron') {
    return tetrahedronClipPlanes(half);
  }
  return [
    { n: new Vector3(1, 0, 0), d: half },
    { n: new Vector3(-1, 0, 0), d: half },
    { n: new Vector3(0, 1, 0), d: half },
    { n: new Vector3(0, -1, 0), d: half },
    { n: new Vector3(0, 0, 1), d: half },
    { n: new Vector3(0, 0, -1), d: half },
  ];
}

export function clipConvexPointsToMacro(
  points: Vector3[],
  params: DesignParams,
  macroSize: number,
): Vector3[] {
  const half = macroSize * 0.5;
  if (params.macroShape === 'sphere') {
    return clipConvexPointsToSphere(points, half);
  }
  let pts = points;
  for (const plane of macroClipPlanes(params, macroSize)) {
    pts = clipConvexPointsByPlane(pts, plane);
    if (pts.length < 4) break;
  }
  return pts;
}

export function pointInsideMacroShape(
  p: Vector3,
  shape: MacroShape,
  half: number,
  margin = 0.01,
): boolean {
  const lim = half - margin;
  if (lim <= 0) return false;
  if (shape === 'sphere') {
    return p.length() <= lim + 1e-8;
  }
  if (shape === 'tetrahedron') {
    for (const pl of tetrahedronClipPlanes(half)) {
      if (pl.n.dot(p) - pl.d > 1e-6) return false;
    }
    return true;
  }
  return (
    Math.abs(p.x) <= lim + 1e-8 &&
    Math.abs(p.y) <= lim + 1e-8 &&
    Math.abs(p.z) <= lim + 1e-8
  );
}

export function clampPointToMacroShape(
  p: Vector3,
  shape: MacroShape,
  half: number,
): void {
  if (shape === 'sphere') {
    const len = p.length();
    if (len > half && len > 1e-8) p.multiplyScalar(half / len);
    return;
  }
  if (shape === 'tetrahedron') {
    for (const pl of tetrahedronClipPlanes(half)) {
      const s = pl.n.dot(p) - pl.d;
      if (s > 0) p.addScaledVector(pl.n, -s);
    }
    return;
  }
  p.x = Math.max(-half, Math.min(half, p.x));
  p.y = Math.max(-half, Math.min(half, p.y));
  p.z = Math.max(-half, Math.min(half, p.z));
}
