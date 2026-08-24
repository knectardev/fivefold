import { Vector3 } from 'three';

/** Any frame with an origin and in-plane basis (part interior or adjacency). */
export interface PlaneFrame {
  origin: Vector3;
  xAxis: Vector3;
  yAxis: Vector3;
}

/** Regular polygon in a plane frame. */
export function planePolygon(
  frame: PlaneFrame,
  radius: number,
  sides: number,
): Vector3[] {
  const n = Math.max(3, Math.round(sides));
  const verts: Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    verts.push(
      frame.origin
        .clone()
        .addScaledVector(frame.xAxis, Math.cos(t) * radius)
        .addScaledVector(frame.yAxis, Math.sin(t) * radius),
    );
  }
  return verts;
}

export function offsetPolygon(
  verts: Vector3[],
  axis: Vector3,
  distance: number,
): Vector3[] {
  return verts.map((v) => v.clone().addScaledVector(axis, distance));
}
