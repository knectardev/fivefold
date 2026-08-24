import { Vector3 } from 'three';

/** Plane: n·x = d (n unit). Keep points with n·x <= d. */
export interface ClipPlane {
  n: Vector3;
  d: number;
}

/**
 * Clip a convex polygon (ordered verts) by plane n·x <= d.
 * Returns empty if fully clipped.
 */
function clipPolygon(
  poly: Vector3[],
  n: Vector3,
  d: number,
  eps = 1e-8,
): Vector3[] {
  if (poly.length === 0) return [];
  const out: Vector3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = n.dot(a) - d;
    const db = n.dot(b) - d;
    const aIn = da <= eps;
    const bIn = db <= eps;
    if (aIn && bIn) {
      out.push(b.clone());
    } else if (aIn && !bIn) {
      const t = da / (da - db);
      out.push(a.clone().lerp(b, t));
    } else if (!aIn && bIn) {
      const t = da / (da - db);
      out.push(a.clone().lerp(b, t));
      out.push(b.clone());
    }
  }
  return out;
}

/** Axis-aligned box as list of faces (each face a polygon). */
export function aabbFaces(half: number): Vector3[][] {
  const h = half;
  return [
    // +X
    [
      new Vector3(h, -h, -h),
      new Vector3(h, h, -h),
      new Vector3(h, h, h),
      new Vector3(h, -h, h),
    ],
    // -X
    [
      new Vector3(-h, -h, h),
      new Vector3(-h, h, h),
      new Vector3(-h, h, -h),
      new Vector3(-h, -h, -h),
    ],
    // +Y
    [
      new Vector3(-h, h, -h),
      new Vector3(-h, h, h),
      new Vector3(h, h, h),
      new Vector3(h, h, -h),
    ],
    // -Y
    [
      new Vector3(-h, -h, h),
      new Vector3(-h, -h, -h),
      new Vector3(h, -h, -h),
      new Vector3(h, -h, h),
    ],
    // +Z
    [
      new Vector3(-h, -h, h),
      new Vector3(h, -h, h),
      new Vector3(h, h, h),
      new Vector3(-h, h, h),
    ],
    // -Z
    [
      new Vector3(-h, h, -h),
      new Vector3(h, h, -h),
      new Vector3(h, -h, -h),
      new Vector3(-h, -h, -h),
    ],
  ];
}

/**
 * Coarse convex sphere bound: clip the AABB by regularly spaced outward planes
 * so Voronoi cells fill a rounded domain instead of a cube.
 */
export function sphereBoundFaces(radius: number, segments = 6): Vector3[][] {
  let faces = aabbFaces(radius);
  for (let i = 0; i < segments; i++) {
    const theta = ((i + 0.5) / segments) * Math.PI;
    for (let j = 0; j < segments * 2; j++) {
      const phi = ((j + 0.5) / (segments * 2)) * Math.PI * 2;
      const n = new Vector3(
        Math.sin(theta) * Math.cos(phi),
        Math.cos(theta),
        Math.sin(theta) * Math.sin(phi),
      ).normalize();
      faces = clipPolyhedron(faces, { n, d: radius });
      if (faces.length === 0) return faces;
    }
  }
  return faces;
}

/** Project face vertices onto/inside a sphere of the given radius. */
export function clampFacesToSphere(faces: Vector3[][], radius: number): Vector3[][] {
  return faces.map((face) =>
    face.map((p) => {
      const len = p.length();
      if (len > radius && len > 1e-8) {
        return p.clone().multiplyScalar(radius / len);
      }
      return p.clone();
    }),
  );
}

/**
 * Clip convex polyhedron (face list) by plane n·x <= d.
 * Adds the new face on the plane if the cut produces an intersection polygon.
 */
export function clipPolyhedron(
  faces: Vector3[][],
  plane: ClipPlane,
  eps = 1e-8,
): Vector3[][] {
  const n = plane.n;
  const d = plane.d;
  const newFaces: Vector3[][] = [];
  const cap: Vector3[] = [];

  for (const face of faces) {
    const clipped = clipPolygon(face, n, d, eps);
    if (clipped.length >= 3) {
      newFaces.push(clipped);
    }
    // Collect points that lie on the clip plane for the cap face.
    for (const p of clipped) {
      if (Math.abs(n.dot(p) - d) <= eps * 10) {
        cap.push(p.clone());
      }
    }
  }

  if (cap.length >= 3) {
    // Order cap verts around plane normal.
    const c = new Vector3();
    for (const p of cap) c.add(p);
    c.multiplyScalar(1 / cap.length);
    const ref = cap[0].clone().sub(c);
    // Build orthonormal basis in plane.
    let u = new Vector3().crossVectors(n, ref);
    if (u.lengthSq() < 1e-10) {
      u = new Vector3().crossVectors(n, new Vector3(0, 1, 0));
    }
    u.normalize();
    const v = new Vector3().crossVectors(n, u).normalize();
    const unique: Vector3[] = [];
    for (const p of cap) {
      if (!unique.some((q) => q.distanceToSquared(p) < eps * eps * 100)) {
        unique.push(p);
      }
    }
    unique.sort((a, b) => {
      const aa = Math.atan2(v.dot(a.clone().sub(c)), u.dot(a.clone().sub(c)));
      const bb = Math.atan2(v.dot(b.clone().sub(c)), u.dot(b.clone().sub(c)));
      return aa - bb;
    });
    if (unique.length >= 3) newFaces.push(unique);
  }

  return newFaces;
}

export function facesToPoints(faces: Vector3[][]): Vector3[] {
  const pts: Vector3[] = [];
  for (const f of faces) {
    for (const p of f) {
      if (!pts.some((q) => q.distanceToSquared(p) < 1e-10)) pts.push(p.clone());
    }
  }
  return pts;
}

/** Bisector halfspace: points closer to seedA than seedB, with optional gap. */
export function voronoiBisector(
  seedA: Vector3,
  seedB: Vector3,
  clearance = 0,
): ClipPlane {
  const mid = seedA.clone().lerp(seedB, 0.5);
  const n = seedB.clone().sub(seedA).normalize();
  // Move plane toward A by clearance/2 so cells don't touch.
  const origin = mid.clone().addScaledVector(n, -clearance * 0.5);
  return { n, d: n.dot(origin) };
}
