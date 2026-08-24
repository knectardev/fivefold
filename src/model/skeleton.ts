import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { AdjacencyRest, DesignParams, PartRest, Skeleton } from './types';
import { ensurePartCount, partProtrusionTilt, partHalfExtent } from './types';

function orthonormalBasis(axis: Vector3): { x: Vector3; y: Vector3 } {
  const n = axis.clone().normalize();
  const tmp = Math.abs(n.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const x = new Vector3().crossVectors(tmp, n).normalize();
  const y = new Vector3().crossVectors(n, x).normalize();
  return { x, y };
}

export function axesFromPartEuler(
  rotX: number,
  rotY: number,
  rotZ: number,
): { axis: Vector3; xAxis: Vector3; yAxis: Vector3 } {
  const e = new Euler(
    (rotX * Math.PI) / 180,
    (rotY * Math.PI) / 180,
    (rotZ * Math.PI) / 180,
    'ZYX',
  );
  const m = new Matrix4().makeRotationFromEuler(e);
  const axis = new Vector3(1, 0, 0).applyMatrix4(m).normalize();
  const xAxis = new Vector3(0, 1, 0).applyMatrix4(m).normalize();
  const yAxis = new Vector3(0, 0, 1).applyMatrix4(m).normalize();
  return { axis, xAxis, yAxis };
}

/**
 * Inverse of axesFromPartEuler for the rotation axis: ZYX Euler degrees that
 * map +X onto `axis`. Optional twist is an extra rotation about that axis.
 */
export function eulerDegreesFromAxis(
  axis: Vector3,
  twistDeg = 0,
): { rotX: number; rotY: number; rotZ: number } {
  const target = axis.clone().normalize();
  if (target.lengthSq() < 1e-12) target.set(1, 0, 0);
  const q = new Quaternion().setFromUnitVectors(new Vector3(1, 0, 0), target);
  if (Math.abs(twistDeg) > 1e-9) {
    const twist = new Quaternion().setFromAxisAngle(
      target,
      (twistDeg * Math.PI) / 180,
    );
    q.premultiply(twist);
  }
  const e = new Euler().setFromQuaternion(q, 'ZYX');
  return {
    rotX: (e.x * 180) / Math.PI,
    rotY: (e.y * 180) / Math.PI,
    rotZ: (e.z * 180) / Math.PI,
  };
}

/** Shared default extrusion direction: axis + tan(tilt)*xAxis, clamped ±30°. */
export function protrusionDirection(
  axis: Vector3,
  xAxis: Vector3,
  tiltDegrees: number,
): Vector3 {
  const tilt = Math.max(-30, Math.min(30, tiltDegrees));
  const rad = (tilt * Math.PI) / 180;
  const dir = axis.clone().normalize().addScaledVector(xAxis, Math.tan(rad));
  if (dir.lengthSq() < 1e-12) return axis.clone().normalize();
  return dir.normalize();
}

function buildPathAdjacencies(
  parts: PartRest[],
  clearanceGap: number,
): AdjacencyRest[] {
  const adjacencies: AdjacencyRest[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const a = parts[i];
    const b = parts[i + 1];
    const delta = b.origin.clone().sub(a.origin);
    const dist = delta.length();
    const normal =
      dist > 1e-6
        ? delta.multiplyScalar(1 / dist)
        : a.axis.clone().normalize();
    const mid = a.origin.clone().lerp(b.origin, 0.5);
    const basis = orthonormalBasis(normal);
    const gap = Math.max(0, clearanceGap) * 0.5;

    a.outerB.copy(mid).addScaledVector(normal, -gap);
    b.outerA.copy(mid).addScaledVector(normal, gap);

    adjacencies.push({
      partA: i,
      partB: i + 1,
      origin: mid.clone(),
      normal,
      xAxis: basis.x,
      yAxis: basis.y,
    });
  }
  return adjacencies;
}

function buildVoronoiAdjacencies(
  parts: PartRest[],
  clearanceGap: number,
): AdjacencyRest[] {
  const adjacencies: AdjacencyRest[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i];
      const b = parts[j];
      const delta = b.origin.clone().sub(a.origin);
      const dist = delta.length();
      if (dist < 1e-6) continue;
      const normal = delta.multiplyScalar(1 / dist);
      const mid = a.origin.clone().lerp(b.origin, 0.5);
      const basis = orthonormalBasis(normal);
      const key = `${i}-${j}`;
      if (seen.has(key)) continue;
      seen.add(key);
      adjacencies.push({
        partA: i,
        partB: j,
        origin: mid.clone(),
        normal,
        xAxis: basis.x,
        yAxis: basis.y,
      });
      void clearanceGap;
    }
  }
  return adjacencies;
}

/**
 * Build the assembly skeleton.
 * - chain: path adjacency (part i ↔ i+1)
 * - free: independent parts, no path adjacency (prism outers from tilt)
 * - voronoi: all seed pairs
 */
export function buildSkeleton(params: DesignParams): Skeleton {
  ensurePartCount(params);

  const parts: PartRest[] = [];

  for (let i = 0; i < params.partCount; i++) {
    const pp = params.parts[i];
    const origin = new Vector3(pp.posX, pp.posY, pp.posZ);
    const { axis, xAxis, yAxis } = axesFromPartEuler(pp.rotX, pp.rotY, pp.rotZ);
    const tilt = partProtrusionTilt(params, pp);
    const dir =
      params.layoutMode === 'free'
        ? protrusionDirection(axis, xAxis, tilt)
        : axis.clone().normalize();
    const extentA = partHalfExtent(params, pp, 'A');
    const extentB = partHalfExtent(params, pp, 'B');

    parts.push({
      id: `part-${i}`,
      index: i,
      origin,
      axis,
      xAxis,
      yAxis,
      symmetryN: pp.symmetryN,
      outerA: origin.clone().addScaledVector(dir, -extentA),
      outerB: origin.clone().addScaledVector(dir, extentB),
    });
  }

  let adjacencies: AdjacencyRest[] = [];
  if (params.layoutMode === 'voronoi') {
    adjacencies = buildVoronoiAdjacencies(parts, params.clearanceGap);
  } else if (params.layoutMode === 'chain') {
    adjacencies = buildPathAdjacencies(parts, params.clearanceGap);
  }
  // free: no path adjacencies

  return { parts, adjacencies };
}
