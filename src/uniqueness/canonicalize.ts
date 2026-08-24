import { Matrix4, Vector3 } from 'three';
import { OH_GROUP } from './octahedralGroup';
import type { Fingerprint, ShapeConfig, UnitSolid } from './types';

/** Quantization step for float drift from Matrix4 multiplies. */
export const DEFAULT_EPSILON = 1e-9;

export interface CanonicalizeOptions {
  epsilon?: number;
  /** When false, only the 24 proper rotations are used (mirrors stay distinct). */
  includeReflections?: boolean;
}

function quantize(v: number, epsilon: number): number {
  return Math.round(v / epsilon) * epsilon;
}

/** Apply a linear Oh map (no translation) to a point. */
function applyLinear(m: Matrix4, p: Vector3, out: Vector3): Vector3 {
  const e = m.elements;
  const x = p.x;
  const y = p.y;
  const z = p.z;
  out.set(
    e[0]! * x + e[4]! * y + e[8]! * z,
    e[1]! * x + e[5]! * y + e[9]! * z,
    e[2]! * x + e[6]! * y + e[10]! * z,
  );
  return out;
}

/**
 * Collect world-space vertices for every unit instance in a config.
 */
export function configPoints(
  config: ShapeConfig,
  unit: UnitSolid,
): Vector3[] {
  const points: Vector3[] = [];
  const tmp = new Vector3();
  for (const inst of config.instances) {
    for (const [x, y, z] of unit.vertices) {
      tmp.set(x, y, z).applyMatrix4(inst.transform);
      points.push(tmp.clone());
    }
  }
  return points;
}

/**
 * Canonical fingerprint of a point set under Oh (or rotations-only).
 * Translate min-corner to origin, ε-quantize, sort, serialize; take lex-min over group.
 */
export function fingerprintPoints(
  points: ReadonlyArray<Vector3>,
  options: CanonicalizeOptions = {},
): Fingerprint {
  const epsilon = options.epsilon ?? DEFAULT_EPSILON;
  const group =
    options.includeReflections === false
      ? OH_GROUP.filter((_, i) => {
          // Proper rotations are those with det +1; use index via OH_GROUP dets
          const { determinant3 } = requireOhDet();
          return determinant3(OH_GROUP[i]!) > 0;
        })
      : OH_GROUP;

  // Prefer importing determinant3 statically — fix below
  void group;
  return fingerprintPointsWithGroup(
    points,
    options.includeReflections === false
      ? getRotations()
      : OH_GROUP,
    epsilon,
  );
}

// Avoid circular require — import rotations properly
import { OH_ROTATIONS, determinant3 } from './octahedralGroup';

function requireOhDet(): { determinant3: typeof determinant3 } {
  return { determinant3 };
}

function getRotations(): readonly Matrix4[] {
  return OH_ROTATIONS;
}

function fingerprintPointsWithGroup(
  points: ReadonlyArray<Vector3>,
  group: readonly Matrix4[],
  epsilon: number,
): Fingerprint {
  if (points.length === 0) return '';

  let best: string | null = null;
  const scratch = new Vector3();
  const transformed: Vector3[] = points.map(() => new Vector3());

  for (const R of group) {
    for (let i = 0; i < points.length; i++) {
      applyLinear(R, points[i]!, transformed[i]!);
    }

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    for (const p of transformed) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.z < minZ) minZ = p.z;
    }

    const keyed: string[] = [];
    for (const p of transformed) {
      scratch.set(p.x - minX, p.y - minY, p.z - minZ);
      const qx = quantize(scratch.x, epsilon);
      const qy = quantize(scratch.y, epsilon);
      const qz = quantize(scratch.z, epsilon);
      // Stable serialization with fixed decimals relative to epsilon scale
      keyed.push(`${fmt(qx)},${fmt(qy)},${fmt(qz)}`);
    }
    keyed.sort();
    const candidate = keyed.join('|');
    if (best === null || candidate < best) best = candidate;
  }

  return best ?? '';
}

function fmt(n: number): string {
  // Trim float noise while keeping lattice integers exact
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(12).replace(/\.?0+$/, '');
}

/**
 * Canonical fingerprint of a shape config (union of transformed unit vertices).
 * Default: full Oh including reflections.
 */
export function fingerprintConfig(
  config: ShapeConfig,
  unit: UnitSolid,
  options: CanonicalizeOptions = {},
): Fingerprint {
  const includeReflections = options.includeReflections !== false;
  const epsilon = options.epsilon ?? DEFAULT_EPSILON;
  const points = configPoints(config, unit);
  return fingerprintPointsWithGroup(
    points,
    includeReflections ? OH_GROUP : OH_ROTATIONS,
    epsilon,
  );
}

/** Identity transform helper. */
export function identityTransform(): Matrix4 {
  return new Matrix4().identity();
}

/** Oh linear map + integer translation. */
export function ohTransform(linear: Matrix4, tx = 0, ty = 0, tz = 0): Matrix4 {
  const m = linear.clone();
  m.setPosition(tx, ty, tz);
  return m;
}
