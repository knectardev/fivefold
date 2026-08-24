import { Matrix4, Quaternion, Vector3 } from 'three';
import type { DesignParams, PartKinematics, Skeleton } from './types';
import { snapAngle } from './types';

function rotationAboutPoint(axis: Vector3, origin: Vector3, angleRad: number): Matrix4 {
  const q = new Quaternion().setFromAxisAngle(axis.clone().normalize(), angleRad);
  const R = new Matrix4().makeRotationFromQuaternion(q);
  const T1 = new Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z);
  const T2 = new Matrix4().makeTranslation(origin.x, origin.y, origin.z);
  return new Matrix4().multiply(T2).multiply(R).multiply(T1);
}

function degToPoseAngle(degrees: number, n: number, snap: boolean): number {
  const deg = snap ? snapAngle(degrees, n as 3 | 4 | 6) : degrees;
  return (deg * Math.PI) / 180;
}

function localHalfPoses(
  skeleton: Skeleton,
  params: DesignParams,
): PartKinematics[] {
  const result: PartKinematics[] = [];

  for (let i = 0; i < skeleton.parts.length; i++) {
    const part = skeleton.parts[i];
    const pp = params.parts[i];
    const snap = params.snapPreview;
    const aRad = degToPoseAngle(pp.angleA ?? 0, pp.symmetryN, snap);
    const bRad = degToPoseAngle(pp.angle ?? 0, pp.symmetryN, snap);

    result.push({
      halfA: {
        matrix: rotationAboutPoint(part.axis, part.origin, aRad),
      },
      halfB: {
        matrix: rotationAboutPoint(part.axis, part.origin, bRad),
      },
    });
  }

  return result;
}

/**
 * FK for interior-half kinematics.
 * - free / voronoi: each half rotates independently about the mid-plane axis
 * - chain: Half B + distal parts rotate about the interior axis (legacy)
 * Visibility (solo / per-part) never changes poses — only what is drawn.
 */
export function computeHalfPoses(
  skeleton: Skeleton,
  params: DesignParams,
): PartKinematics[] {
  if (params.layoutMode === 'voronoi' || params.layoutMode === 'free') {
    return localHalfPoses(skeleton, params);
  }

  const result: PartKinematics[] = [];
  let world = new Matrix4();

  for (let i = 0; i < skeleton.parts.length; i++) {
    const part = skeleton.parts[i];
    const pp = params.parts[i];

    const halfA = { matrix: world.clone() };

    let angleDeg = pp.angle;
    if (params.snapPreview) {
      angleDeg = snapAngle(angleDeg, pp.symmetryN);
    }
    const angle = (angleDeg * Math.PI) / 180;

    const originW = part.origin.clone().applyMatrix4(world);
    const axisW = part.axis.clone().transformDirection(world).normalize();
    const rot = rotationAboutPoint(axisW, originW, angle);

    world = rot.multiply(world);
    const halfB = { matrix: world.clone() };

    result.push({ halfA, halfB });
  }

  return result;
}

export function partWorldFrame(
  skeleton: Skeleton,
  _params: DesignParams,
  partIndex: number,
): { origin: Vector3; axis: Vector3; xAxis: Vector3; yAxis: Vector3 } {
  // Mid-plane frame from rest (unspun) axes — shared by both halves.
  const part = skeleton.parts[partIndex];
  return {
    origin: part.origin.clone(),
    axis: part.axis.clone().normalize(),
    xAxis: part.xAxis.clone().normalize(),
    yAxis: part.yAxis.clone().normalize(),
  };
}

/** Whether part i should be drawn given solo + per-part visibility. */
export function isPartVisible(params: DesignParams, index: number): boolean {
  const part = params.parts[index];
  if (!part || part.visible === false) return false;
  if (params.soloActivePart && index !== params.activePart) return false;
  return true;
}
