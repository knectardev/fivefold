import {
  BufferAttribute,
  BufferGeometry,
  Matrix4,
  Vector3,
} from 'three';
import { planePolygon } from './contactPolygon';
import { finalizeHull } from './convexHull';

export type Vec2 = { x: number; y: number };

export type PlaneBasis = {
  origin: Vector3;
  axis: Vector3;
  xAxis: Vector3;
  yAxis: Vector3;
};

function unique2(points: Vec2[], eps = 1e-7): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    if (!out.some((q) => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 < eps * eps)) {
      out.push(p);
    }
  }
  return out;
}

/** Convex hull of 2D points (monotone chain), CCW. */
export function convexHull2D(points: Vec2[]): Vec2[] {
  const pts = unique2(points);
  if (pts.length <= 2) return pts;
  pts.sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: Vec2, a: Vec2, b: Vec2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function clipPolyByHalfspace2(
  poly: Vec2[],
  nx: number,
  ny: number,
  d: number,
  eps = 1e-9,
): Vec2[] {
  if (!poly.length) return [];
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = nx * a.x + ny * a.y - d;
    const db = nx * b.x + ny * b.y - d;
    const aIn = da <= eps;
    const bIn = db <= eps;
    if (aIn && bIn) out.push(b);
    else if (aIn && !bIn) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    } else if (!aIn && bIn) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      out.push(b);
    }
  }
  return out;
}

/** Intersection of two convex polygons (both CCW), Sutherland–Hodgman. */
export function intersectConvex2D(subject: Vec2[], clip: Vec2[]): Vec2[] {
  if (subject.length < 3 || clip.length < 3) return [];
  let cur = subject.map((p) => ({ ...p }));
  for (let i = 0; i < clip.length; i++) {
    const p0 = clip[i];
    const p1 = clip[(i + 1) % clip.length];
    const ex = p1.x - p0.x;
    const ey = p1.y - p0.y;
    // Inward normal for CCW clip polygon (left of edge).
    const nx = -ey;
    const ny = ex;
    const len = Math.hypot(nx, ny);
    if (len < 1e-12) continue;
    const nnx = nx / len;
    const nny = ny / len;
    cur = clipPolyByHalfspace2(cur, nnx, nny, nnx * p0.x + nny * p0.y);
    if (cur.length < 3) return [];
  }
  return convexHull2D(cur);
}

export function pointInConvex2D(p: Vec2, poly: Vec2[], eps = 1e-8): boolean {
  if (poly.length < 3) return false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross < -eps) return false;
  }
  return true;
}

function geometryWorldEdges(
  geo: BufferGeometry,
  matrix: Matrix4,
): [Vector3, Vector3][] {
  const pos = geo.attributes.position as BufferAttribute;
  if (!pos) return [];
  const get = (i: number) =>
    new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(matrix);
  const edges: [Vector3, Vector3][] = [];
  const seen = new Set<string>();
  const add = (u: number, v: number) => {
    const key = u < v ? `${u},${v}` : `${v},${u}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push([get(u), get(v)]);
  };
  if (geo.index) {
    const idx = geo.index;
    for (let t = 0; t < idx.count; t += 3) {
      add(idx.getX(t), idx.getX(t + 1));
      add(idx.getX(t + 1), idx.getX(t + 2));
      add(idx.getX(t + 2), idx.getX(t));
    }
  } else {
    for (let i = 0; i + 2 < pos.count; i += 3) {
      add(i, i + 1);
      add(i + 1, i + 2);
      add(i + 2, i);
    }
  }
  return edges;
}

function worldPoints(
  geo: BufferGeometry,
  matrix: Matrix4,
): Vector3[] {
  const pos = geo.attributes.position as BufferAttribute;
  if (!pos) return [];
  const pts: Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    pts.push(new Vector3().fromBufferAttribute(pos, i).applyMatrix4(matrix));
  }
  return pts;
}

/**
 * Convex cross-section of a mesh with the midplane, in plane UV coordinates.
 */
export function midplaneSection2D(
  geo: BufferGeometry,
  matrix: Matrix4,
  basis: PlaneBasis,
  planeEps = 0.04,
): Vec2[] {
  const n = basis.axis.clone().normalize();
  const hits: Vec2[] = [];
  const toUV = (p: Vector3): Vec2 => {
    const d = p.clone().sub(basis.origin);
    return { x: d.dot(basis.xAxis), y: d.dot(basis.yAxis) };
  };

  for (const p of worldPoints(geo, matrix)) {
    if (Math.abs(p.clone().sub(basis.origin).dot(n)) <= planeEps) {
      hits.push(toUV(p));
    }
  }

  for (const [a, b] of geometryWorldEdges(geo, matrix)) {
    const ha = a.clone().sub(basis.origin).dot(n);
    const hb = b.clone().sub(basis.origin).dot(n);
    if (Math.abs(ha) <= planeEps) hits.push(toUV(a));
    if (Math.abs(hb) <= planeEps) hits.push(toUV(b));
    if (ha * hb > 0) continue;
    if (Math.abs(ha - hb) < 1e-14) continue;
    const t = ha / (ha - hb);
    if (t < -1e-6 || t > 1 + 1e-6) continue;
    hits.push(toUV(a.clone().lerp(b, t)));
  }

  return convexHull2D(hits);
}

function ensureCcw(poly: Vec2[]): Vec2[] {
  if (poly.length < 3) return poly;
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area < 0 ? poly.slice().reverse() : poly;
}

function regularNgon2D(radius: number, sides: number): Vec2[] {
  const n = Math.max(3, Math.round(sides));
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push({ x: Math.cos(t) * radius, y: Math.sin(t) * radius });
  }
  return out;
}

function uvToWorld(uv: Vec2, basis: PlaneBasis): Vector3 {
  return basis.origin
    .clone()
    .addScaledVector(basis.xAxis, uv.x)
    .addScaledVector(basis.yAxis, uv.y);
}

/**
 * Rotational plane footprint: regular N-gon clipped to the part's solid
 * midplane cross-section so the plane never extends outside its body.
 */
export function clippedRotationalPlanePolygon(
  basis: PlaneBasis,
  radius: number,
  sides: number,
  halfA: { geometry: BufferGeometry; matrix: Matrix4 },
  halfB: { geometry: BufferGeometry; matrix: Matrix4 },
): { world: Vector3[]; uv: Vec2[] } {
  const sectionA = midplaneSection2D(halfA.geometry, halfA.matrix, basis, 0.08);
  const sectionB = midplaneSection2D(halfB.geometry, halfB.matrix, basis, 0.08);
  // Union of both half sections at the shared midplane (convex hull).
  let bodySection = ensureCcw(convexHull2D([...sectionA, ...sectionB]));

  // Fallback: section of the merged world hull (more tolerant after trims).
  if (bodySection.length < 3) {
    const hull = partWorldHullFromHalves(
      halfA.geometry,
      halfA.matrix,
      halfB.geometry,
      halfB.matrix,
    );
    if (hull) {
      bodySection = ensureCcw(
        midplaneSection2D(hull, new Matrix4(), basis, 0.08),
      );
      hull.dispose();
    }
  }

  const ngon = ensureCcw(regularNgon2D(radius, sides));

  let uv: Vec2[];
  if (bodySection.length >= 3) {
    uv = intersectConvex2D(ngon, bodySection);
    // If the nominal N-gon misses the solid section, shrink it into the
    // section — never promote the full midplane face (that can reach the
    // macro wall and falsely trip bounds compliance).
    if (uv.length < 3) {
      uv = [];
      let r = radius;
      for (let k = 0; k < 10 && uv.length < 3; k++) {
        r *= 0.7;
        if (r < 0.05) break;
        uv = intersectConvex2D(ensureCcw(regularNgon2D(r, sides)), bodySection);
      }
      if (uv.length < 3) {
        // Last resort: tiny disk at section centroid, still capped by radius.
        const cx =
          bodySection.reduce((s, p) => s + p.x, 0) / bodySection.length;
        const cy =
          bodySection.reduce((s, p) => s + p.y, 0) / bodySection.length;
        const tiny = Math.min(radius, 0.12);
        uv = ensureCcw(regularNgon2D(tiny, sides)).map((p) => ({
          x: p.x + cx,
          y: p.y + cy,
        }));
        uv = intersectConvex2D(uv, bodySection);
        if (uv.length < 3) uv = ensureCcw(regularNgon2D(Math.min(radius, 0.08), sides));
      }
    }
  } else {
    // No reliable section — shrink to a tiny disk rather than a huge overhang.
    uv = ensureCcw(regularNgon2D(Math.min(radius, 0.15), sides));
  }

  return { world: uv.map((p) => uvToWorld(p, basis)), uv };
}

/** Build a world-space hull of both halves for section sampling without meshes. */
export function partWorldHullFromHalves(
  halfA: BufferGeometry,
  matA: Matrix4,
  halfB: BufferGeometry,
  matB: Matrix4,
): BufferGeometry | null {
  const pts = [...worldPoints(halfA, matA), ...worldPoints(halfB, matB)];
  if (pts.length < 4) return null;
  try {
    return finalizeHull(pts);
  } catch {
    return null;
  }
}

/** Nominal unclipped N-gon (for reference). */
export function nominalRotationalPolygon(
  basis: PlaneBasis,
  radius: number,
  sides: number,
): Vector3[] {
  return planePolygon(
    { origin: basis.origin, xAxis: basis.xAxis, yAxis: basis.yAxis },
    radius,
    sides,
  );
}
