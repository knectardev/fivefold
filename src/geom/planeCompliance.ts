import { BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three';
import type { DesignParams, Skeleton } from '../model/types';
import { effectiveMacroSize, partPlaneRadius } from '../model/types';
import { computeHalfPoses, partWorldFrame } from '../model/fk';
import { planePolygon } from './contactPolygon';
import { finalizeHull } from './convexHull';
import { pointInsideMacroShape } from './convexClip';
import {
  clippedRotationalPlanePolygon,
  pointInConvex2D,
  type Vec2,
} from './planeFootprint';

export type PlaneViolation = 'bounds' | 'plane' | 'solid';

export interface PlaneComplianceResult {
  compliant: boolean;
  /** Why this plane failed (empty if compliant). */
  violations: PlaneViolation[];
}

function pointInsideMacro(
  p: Vector3,
  params: DesignParams,
  half: number,
  margin = 0.01,
): boolean {
  return pointInsideMacroShape(p, params.macroShape, half, margin);
}

type PlaneFrame = {
  origin: Vector3;
  axis: Vector3;
  xAxis: Vector3;
  yAxis: Vector3;
  radius: number;
  sides: number;
  /** Actual drawable / collision footprint (clipped to solid body). */
  polygon: Vector3[];
  footprintUv: Vec2[];
};

function pointInPlaneFootprint(
  p: Vector3,
  frame: PlaneFrame,
  planeEps = 0.06,
): boolean {
  const n = frame.axis;
  const h = p.clone().sub(frame.origin).dot(n);
  if (Math.abs(h) > planeEps) return false;
  const d = p.clone().sub(frame.origin);
  return pointInConvex2D(
    { x: d.dot(frame.xAxis), y: d.dot(frame.yAxis) },
    frame.footprintUv,
  );
}

function segmentStabsFootprint(
  a: Vector3,
  b: Vector3,
  frame: PlaneFrame,
  planeEps = 0.06,
): boolean {
  const n = frame.axis;
  const ha = a.clone().sub(frame.origin).dot(n);
  const hb = b.clone().sub(frame.origin).dot(n);
  if (Math.abs(ha) <= planeEps && pointInPlaneFootprint(a, frame, planeEps)) {
    return true;
  }
  if (Math.abs(hb) <= planeEps && pointInPlaneFootprint(b, frame, planeEps)) {
    return true;
  }
  if (ha * hb > 0) return false;
  if (Math.abs(ha - hb) < 1e-12) return false;
  const t = ha / (ha - hb);
  if (t < -0.02 || t > 1.02) return false;
  return pointInPlaneFootprint(a.clone().lerp(b, t), frame, planeEps);
}

function clipPolyByHalfspace2(
  poly: { x: number; y: number }[],
  nx: number,
  ny: number,
  d: number,
  eps = 1e-9,
): { x: number; y: number }[] {
  if (!poly.length) return [];
  const out: { x: number; y: number }[] = [];
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

function convexPolygonsOverlap2D(
  a: { x: number; y: number }[],
  b: { x: number; y: number }[],
): boolean {
  if (a.length < 3 || b.length < 3) return false;
  let cur = a.map((p) => ({ ...p }));
  for (let i = 0; i < b.length; i++) {
    const p0 = b[i];
    const p1 = b[(i + 1) % b.length];
    const ex = p1.x - p0.x;
    const ey = p1.y - p0.y;
    const nx = -ey;
    const ny = ex;
    const len = Math.hypot(nx, ny);
    if (len < 1e-12) continue;
    const nnx = nx / len;
    const nny = ny / len;
    cur = clipPolyByHalfspace2(cur, nnx, nny, nnx * p0.x + nny * p0.y);
    if (cur.length < 3) return false;
  }
  return true;
}

function rotationalPlanesConflict(a: PlaneFrame, b: PlaneFrame): boolean {
  for (let i = 0; i < a.polygon.length; i++) {
    if (
      segmentStabsFootprint(
        a.polygon[i],
        a.polygon[(i + 1) % a.polygon.length],
        b,
      )
    ) {
      return true;
    }
  }
  for (let i = 0; i < b.polygon.length; i++) {
    if (
      segmentStabsFootprint(
        b.polygon[i],
        b.polygon[(i + 1) % b.polygon.length],
        a,
      )
    ) {
      return true;
    }
  }

  const align = Math.abs(a.axis.dot(b.axis));
  const sep = Math.abs(b.axis.dot(a.origin.clone().sub(b.origin)));
  if (align > 0.92 && sep < Math.max(0.08, (a.radius + b.radius) * 0.05)) {
    return convexPolygonsOverlap2D(a.footprintUv, b.footprintUv);
  }
  return false;
}

type HalfMeshPair = {
  a: { geometry: BufferGeometry; matrixWorld?: Matrix4; matrix: Matrix4 };
  b: { geometry: BufferGeometry; matrixWorld?: Matrix4; matrix: Matrix4 };
};

function worldPointsFromHalf(
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

/** Interior halfspaces for a convex mesh (n·x <= d). */
function convexInteriorPlanes(geo: BufferGeometry): { n: Vector3; d: number }[] {
  const pos = geo.attributes.position as BufferAttribute;
  if (!pos || pos.count < 3) return [];
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
    if (n.dot(mid.clone().sub(center)) < 0) n.negate();
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
  return planes;
}

/** Strict interior — boundary contact with a plane disk does not count. */
function pointStrictlyInConvexWorldHull(
  p: Vector3,
  hull: BufferGeometry,
  margin = 0.025,
): boolean {
  const planes = convexInteriorPlanes(hull);
  if (planes.length < 4) return false;
  for (const pl of planes) {
    if (pl.n.dot(p) - pl.d > -margin) return false;
  }
  return true;
}

/**
 * Hard stop: another part's solid must not intersect this rotational footprint.
 * Through-stabs count; flush face contact on the disk does not.
 */
function solidIntersectsRotationalPlane(
  solidEdges: [Vector3, Vector3][],
  solidHull: BufferGeometry | null,
  frame: PlaneFrame,
): boolean {
  for (const [a, b] of solidEdges) {
    if (segmentStabsFootprint(a, b, frame)) return true;
  }

  const samples = [...frame.polygon];
  samples.push(frame.origin.clone());
  for (let i = 0; i < frame.polygon.length; i++) {
    samples.push(
      frame.polygon[i]
        .clone()
        .lerp(frame.polygon[(i + 1) % frame.polygon.length], 0.5),
    );
    samples.push(frame.origin.clone().lerp(frame.polygon[i], 0.5));
  }
  if (solidHull) {
    for (const s of samples) {
      if (pointStrictlyInConvexWorldHull(s, solidHull)) return true;
    }
  }
  return false;
}

function buildPlaneFrame(
  skeleton: Skeleton,
  params: DesignParams,
  index: number,
  halfMeshes?: HalfMeshPair[],
  poses?: ReturnType<typeof computeHalfPoses>,
): PlaneFrame {
  const f = partWorldFrame(skeleton, params, index);
  const part = skeleton.parts[index];
  const pp = params.parts[index];
  const radius = partPlaneRadius(params, pp);
  const basis = {
    origin: f.origin,
    axis: f.axis,
    xAxis: f.xAxis,
    yAxis: f.yAxis,
  };

  let polygon: Vector3[];
  let footprintUv: Vec2[];

  if (halfMeshes && halfMeshes[index] && poses) {
    const mA = poses[index]?.halfA.matrix ?? halfMeshes[index].a.matrix;
    const mB = poses[index]?.halfB.matrix ?? halfMeshes[index].b.matrix;
    const clipped = clippedRotationalPlanePolygon(
      basis,
      radius,
      part.symmetryN,
      { geometry: halfMeshes[index].a.geometry, matrix: mA },
      { geometry: halfMeshes[index].b.geometry, matrix: mB },
    );
    polygon = clipped.world;
    footprintUv = clipped.uv;
  } else {
    polygon = planePolygon(
      { origin: f.origin, xAxis: f.xAxis, yAxis: f.yAxis },
      radius,
      part.symmetryN,
    );
    footprintUv = polygon.map((p) => {
      const d = p.clone().sub(f.origin);
      return { x: d.dot(f.xAxis), y: d.dot(f.yAxis) };
    });
  }

  return {
    origin: f.origin,
    axis: f.axis,
    xAxis: f.xAxis,
    yAxis: f.yAxis,
    radius,
    sides: part.symmetryN,
    polygon,
    footprintUv,
  };
}

export function getPartPlanePolygon(
  skeleton: Skeleton,
  params: DesignParams,
  index: number,
  halfMeshes?: HalfMeshPair[],
): Vector3[] {
  const poses = computeHalfPoses(skeleton, params);
  return buildPlaneFrame(skeleton, params, index, halfMeshes, poses).polygon;
}

/**
 * Rotational-plane compliance (hard stops):
 * - bounds: footprint vs macro wall
 * - plane: footprint vs footprint
 * - solid: footprint vs another part's solid body
 *
 * Footprints are the N-gon clipped to each part's solid midplane section.
 */
export function evaluatePlaneCompliance(
  skeleton: Skeleton,
  params: DesignParams,
  halfMeshes?: HalfMeshPair[],
): PlaneComplianceResult[] {
  const n = skeleton.parts.length;
  const results: PlaneComplianceResult[] = Array.from({ length: n }, () => ({
    compliant: true,
    violations: [],
  }));

  const half = effectiveMacroSize(params) * 0.5;
  const poses = computeHalfPoses(skeleton, params);
  const frames: PlaneFrame[] = skeleton.parts.map((_, i) =>
    buildPlaneFrame(skeleton, params, i, halfMeshes, poses),
  );

  for (let i = 0; i < n; i++) {
    const poly = frames[i].polygon;
    const samples = [...poly];
    for (let e = 0; e < poly.length; e++) {
      samples.push(poly[e].clone().lerp(poly[(e + 1) % poly.length], 0.5));
    }
    if (samples.some((p) => !pointInsideMacro(p, params, half))) {
      results[i].compliant = false;
      results[i].violations.push('bounds');
    }
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rotationalPlanesConflict(frames[i], frames[j])) {
        results[i].compliant = false;
        results[j].compliant = false;
        if (!results[i].violations.includes('plane')) {
          results[i].violations.push('plane');
        }
        if (!results[j].violations.includes('plane')) {
          results[j].violations.push('plane');
        }
      }
    }
  }

  if (halfMeshes && halfMeshes.length === n) {
    const hulls: (BufferGeometry | null)[] = [];
    for (let j = 0; j < n; j++) {
      const mA = poses[j]?.halfA.matrix ?? halfMeshes[j].a.matrix;
      const mB = poses[j]?.halfB.matrix ?? halfMeshes[j].b.matrix;
      const pts = [
        ...worldPointsFromHalf(halfMeshes[j].a.geometry, mA),
        ...worldPointsFromHalf(halfMeshes[j].b.geometry, mB),
      ];
      try {
        hulls.push(pts.length >= 4 ? finalizeHull(pts) : null);
      } catch {
        hulls.push(null);
      }
    }

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const mA = poses[j]?.halfA.matrix ?? halfMeshes[j].a.matrix;
        const mB = poses[j]?.halfB.matrix ?? halfMeshes[j].b.matrix;
        const edges = [
          ...geometryWorldEdges(halfMeshes[j].a.geometry, mA),
          ...geometryWorldEdges(halfMeshes[j].b.geometry, mB),
        ];
        if (solidIntersectsRotationalPlane(edges, hulls[j], frames[i])) {
          results[i].compliant = false;
          if (!results[i].violations.includes('solid')) {
            results[i].violations.push('solid');
          }
        }
      }
    }

    for (const h of hulls) h?.dispose();
  }

  return results;
}

export function complianceSummary(results: PlaneComplianceResult[]): string {
  const bad = results
    .map((r, i) => (r.compliant ? null : i))
    .filter((i): i is number => i !== null);
  if (!bad.length) return '';
  return `Plane conflict: part${bad.length > 1 ? 's' : ''} ${bad.join(', ')}`;
}
