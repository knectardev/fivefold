import type { UnitSolid } from './types';

/**
 * Unit trapezoidal prism matching the Rhino reference:
 * footprint 3×2, height 2, ramp from z=0 at x=0 to z=2 at x=1,
 * flat top over x ∈ [1, 3].
 *
 * Vertex layout (exact integers):
 *
 *   bottom: (0,0,0) (3,0,0) (3,2,0) (0,2,0)
 *   top:    (1,0,2) (3,0,2) (3,2,2) (1,2,2)
 */
export const UNIT_VERTICES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], // 0 front-left-bottom
  [3, 0, 0], // 1 back-left-bottom
  [3, 2, 0], // 2 back-right-bottom
  [0, 2, 0], // 3 front-right-bottom
  [1, 0, 2], // 4 slope-top-left
  [3, 0, 2], // 5 back-top-left
  [3, 2, 2], // 6 back-top-right
  [1, 2, 2], // 7 slope-top-right
];

/**
 * Triangle faces (outward-ish winding for MeshStandardMaterial).
 * Indices into UNIT_VERTICES.
 */
export const UNIT_FACES: ReadonlyArray<readonly [number, number, number]> = [
  // bottom z=0
  [0, 2, 1],
  [0, 3, 2],
  // top z=2 (x=1..3)
  [4, 5, 6],
  [4, 6, 7],
  // back x=3
  [1, 2, 6],
  [1, 6, 5],
  // left y=0
  [0, 1, 5],
  [0, 5, 4],
  // right y=2
  [3, 7, 6],
  [3, 6, 2],
  // slope (front ramp)
  [0, 4, 7],
  [0, 7, 3],
];

export const UNIT_SOLID: UnitSolid = {
  vertices: UNIT_VERTICES,
  faces: UNIT_FACES,
};

/** Mirror of the unit across the YZ plane (x → −x), then shifted so min-x = 0. */
export function mirroredUnitSolid(): UnitSolid {
  const mirrored = UNIT_VERTICES.map(
    ([x, y, z]) => [-x, y, z] as [number, number, number],
  );
  const minX = Math.min(...mirrored.map((p) => p[0]));
  const vertices = mirrored.map(
    ([x, y, z]) => [x - minX, y, z] as [number, number, number],
  );
  // Flip winding so faces stay outward after reflection
  const faces = UNIT_FACES.map(
    ([a, b, c]) => [a, c, b] as [number, number, number],
  );
  return { vertices, faces };
}
