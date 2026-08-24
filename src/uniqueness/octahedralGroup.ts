import { Matrix4 } from 'three';

/**
 * Full octahedral group Oh: all 3×3 signed permutation matrices
 * (48 orientation-preserving-or-reversing orthogonal maps with entries in {-1,0,1}).
 *
 * Each element is stored as a Matrix4 acting on (x,y,z,1) with translation zero.
 */

const PERMS: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

const SIGNS: readonly (readonly [number, number, number])[] = [
  [1, 1, 1],
  [1, 1, -1],
  [1, -1, 1],
  [1, -1, -1],
  [-1, 1, 1],
  [-1, 1, -1],
  [-1, -1, 1],
  [-1, -1, -1],
];

function signedPermutationMatrix(
  perm: readonly [number, number, number],
  signs: readonly [number, number, number],
): Matrix4 {
  // Column j of the 3×3 block is e_{perm[j]} * signs[j]
  // so v' = M v maps axis j → signed axis perm[j].
  const m = new Matrix4().set(
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 1,
  );
  const e = m.elements;
  // Matrix4 is column-major: index = row + col*4
  for (let col = 0; col < 3; col++) {
    const row = perm[col]!;
    const s = signs[col]!;
    e[row + col * 4] = s;
  }
  return m;
}

function buildOhGroup(): readonly Matrix4[] {
  const out: Matrix4[] = [];
  for (const perm of PERMS) {
    for (const signs of SIGNS) {
      out.push(signedPermutationMatrix(perm, signs));
    }
  }
  return out;
}

/** All 48 elements of Oh as Matrix4 (rotation/reflection only). */
export const OH_GROUP: readonly Matrix4[] = buildOhGroup();

/** The 24 proper rotations (det = +1). */
export const OH_ROTATIONS: readonly Matrix4[] = OH_GROUP.filter(
  (m) => determinant3(m) > 0,
);

/** Determinant of the upper-left 3×3 block. */
export function determinant3(m: Matrix4): number {
  const e = m.elements;
  const a00 = e[0]!,
    a01 = e[4]!,
    a02 = e[8]!;
  const a10 = e[1]!,
    a11 = e[5]!,
    a12 = e[9]!;
  const a20 = e[2]!,
    a21 = e[6]!,
    a22 = e[10]!;
  return (
    a00 * (a11 * a22 - a12 * a21) -
    a01 * (a10 * a22 - a12 * a20) +
    a02 * (a10 * a21 - a11 * a20)
  );
}

/** Multiply two Matrix4 linear parts (ignores translation; both should be pure Oh). */
export function multiplyOh(a: Matrix4, b: Matrix4): Matrix4 {
  return new Matrix4().multiplyMatrices(a, b);
}

/** Encode the 3×3 linear part as a stable key for set membership. */
export function matrixKey(m: Matrix4): string {
  const e = m.elements;
  const vals = [
    e[0],
    e[1],
    e[2],
    e[4],
    e[5],
    e[6],
    e[8],
    e[9],
    e[10],
  ].map((v) => Math.round(v!));
  return vals.join(',');
}
