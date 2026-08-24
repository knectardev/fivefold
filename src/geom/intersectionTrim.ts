import {
  BufferAttribute,
  BufferGeometry,
  Matrix4,
  Vector3,
} from 'three';
import type { DesignParams, Skeleton } from '../model/types';
import { effectiveMacroSize } from '../model/types';
import { computeHalfPoses } from '../model/fk';
import { finalizeHull } from './convexHull';
import type { PartHalvesGeometry } from './hull';
import {
  clipConvexPointsByPlane,
  clipConvexPointsToMacro,
} from './convexClip';
import { voronoiBisector, type ClipPlane } from './polyhedron';

function uniquePoints(points: Vector3[], eps = 1e-5): Vector3[] {
  const out: Vector3[] = [];
  for (const p of points) {
    if (!out.some((q) => q.distanceToSquared(p) < eps * eps)) {
      out.push(p.clone());
    }
  }
  return out;
}

function geometryPoints(geo: BufferGeometry): Vector3[] {
  const pos = geo.attributes.position as BufferAttribute;
  const pts: Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    pts.push(new Vector3().fromBufferAttribute(pos, i));
  }
  return uniquePoints(pts);
}

function transformPoints(points: Vector3[], matrix: Matrix4): Vector3[] {
  return points.map((p) => p.clone().applyMatrix4(matrix));
}

function partSphere(
  halfA: Vector3[],
  halfB: Vector3[],
): { center: Vector3; radius: number } {
  const all = [...halfA, ...halfB];
  const center = new Vector3();
  for (const p of all) center.add(p);
  if (all.length) center.multiplyScalar(1 / all.length);
  let radius = 0;
  for (const p of all) radius = Math.max(radius, p.distanceTo(center));
  return { center, radius };
}

function hullOrFallback(
  points: Vector3[],
  fallback: BufferGeometry,
): BufferGeometry {
  try {
    return finalizeHull(points);
  } catch {
    return fallback.clone();
  }
}

/** Split a clipped part back into half A (−axis) and half B (+axis). */
function splitHalvesByAxis(
  points: Vector3[],
  axis: Vector3,
  origin: Vector3,
): { a: Vector3[]; b: Vector3[] } {
  const n = axis.clone().normalize();
  const d = n.dot(origin);
  // Mid-plane band so both halves keep the shared interior face.
  const planeA: ClipPlane = { n, d: d + 1e-4 };
  const planeB: ClipPlane = { n: n.clone().negate(), d: -d + 1e-4 };
  return {
    a: clipConvexPointsByPlane(points, planeA),
    b: clipConvexPointsByPlane(points, planeB),
  };
}

function applyMergedClip(
  posedA: Vector3[][],
  posedB: Vector3[][],
  index: number,
  plane: ClipPlane,
  axis: Vector3,
  origin: Vector3,
): void {
  const merged = clipConvexPointsByPlane(
    [...posedA[index], ...posedB[index]],
    plane,
  );
  if (merged.length < 4) return;
  const split = splitHalvesByAxis(merged, axis, origin);
  if (split.a.length >= 4) posedA[index] = split.a;
  if (split.b.length >= 4) posedB[index] = split.b;
}

/**
 * Free mode: macro halfspace clips + pairwise bisector trim on the *merged*
 * part solid, then split back into halves for FK.
 *
 * Solids are only carved by macro walls and by overlapping neighbor solids
 * (Voronoi bisectors). Crossing another part's rotational plane is flagged
 * red by compliance — it does not facet non-colliding geometry.
 */
export function resolveFreeHalves(
  skeleton: Skeleton,
  params: DesignParams,
  halves: PartHalvesGeometry[],
): PartHalvesGeometry[] {
  const macro = effectiveMacroSize(params);
  const poses = computeHalfPoses(skeleton, params);

  const restA = halves.map((h) => geometryPoints(h.halfA));
  const restB = halves.map((h) => geometryPoints(h.halfB));

  let posedA = restA.map((pts, i) =>
    transformPoints(pts, poses[i].halfA.matrix),
  );
  let posedB = restB.map((pts, i) =>
    transformPoints(pts, poses[i].halfB.matrix),
  );

  for (let i = 0; i < posedA.length; i++) {
    posedA[i] = clipConvexPointsToMacro(posedA[i], params, macro);
    posedB[i] = clipConvexPointsToMacro(posedB[i], params, macro);
  }

  const gap = Math.max(0, params.clearanceGap);
  const spheres = posedA.map((_, i) => partSphere(posedA[i], posedB[i]));

  for (let i = 0; i < skeleton.parts.length; i++) {
    for (let j = i + 1; j < skeleton.parts.length; j++) {
      const si = spheres[i];
      const sj = spheres[j];
      const dist = si.center.distanceTo(sj.center);
      if (dist > si.radius + sj.radius + gap + 1e-4) continue;

      const partI = skeleton.parts[i];
      const partJ = skeleton.parts[j];
      if (partI.origin.distanceToSquared(partJ.origin) < 1e-12) continue;

      const planeI = voronoiBisector(partI.origin, partJ.origin, gap);
      const planeJ = voronoiBisector(partJ.origin, partI.origin, gap);

      applyMergedClip(posedA, posedB, i, planeI, partI.axis, partI.origin);
      applyMergedClip(posedA, posedB, j, planeJ, partJ.axis, partJ.origin);

      spheres[i] = partSphere(posedA[i], posedB[i]);
      spheres[j] = partSphere(posedA[j], posedB[j]);
    }
  }

  // Do NOT trim solids by other parts' infinite midplanes. That carved facets
  // into non-colliding parts whenever their volume merely crossed another
  // rotational plane in space. Plane∩solid is a compliance hard-stop (red).

  const out: PartHalvesGeometry[] = [];
  for (let i = 0; i < halves.length; i++) {
    const invA = poses[i].halfA.matrix.clone().invert();
    const invB = poses[i].halfB.matrix.clone().invert();
    out.push({
      halfA: hullOrFallback(transformPoints(posedA[i], invA), halves[i].halfA),
      halfB: hullOrFallback(transformPoints(posedB[i], invB), halves[i].halfB),
    });
  }

  for (const h of halves) {
    h.halfA.dispose();
    h.halfB.dispose();
  }

  return out;
}

/** Proper macro clip for chain / voronoi halves. */
export function clipHalvesToMacro(
  halves: PartHalvesGeometry[],
  params: DesignParams,
): PartHalvesGeometry[] {
  const macro = effectiveMacroSize(params);
  const out = halves.map(({ halfA, halfB }) => {
    const ptsA = clipConvexPointsToMacro(geometryPoints(halfA), params, macro);
    const ptsB = clipConvexPointsToMacro(geometryPoints(halfB), params, macro);
    return {
      halfA: hullOrFallback(ptsA, halfA),
      halfB: hullOrFallback(ptsB, halfB),
    };
  });
  for (const h of halves) {
    h.halfA.dispose();
    h.halfB.dispose();
  }
  return out;
}
