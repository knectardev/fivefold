import { fingerprintConfig, type CanonicalizeOptions } from './canonicalize';
import type { CongruenceMatrix, ShapeConfig, UnitSolid } from './types';

/**
 * Build the N×N congruence matrix for a collection of configs.
 * Entry (i,j) is true iff configs share a canonical fingerprint under Oh.
 */
export function buildCongruenceMatrix(
  configs: readonly ShapeConfig[],
  unit: UnitSolid,
  options: CanonicalizeOptions = {},
): CongruenceMatrix {
  const fingerprints = configs.map((c) =>
    fingerprintConfig(c, unit, options),
  );

  const n = configs.length;
  const matrix: boolean[][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => false),
  );

  const classOf: number[] = Array.from({ length: n }, () => -1);
  let classCount = 0;
  const fpToClass = new Map<string, number>();

  for (let i = 0; i < n; i++) {
    const fp = fingerprints[i]!;
    let cls = fpToClass.get(fp);
    if (cls === undefined) {
      cls = classCount++;
      fpToClass.set(fp, cls);
    }
    classOf[i] = cls;
  }

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      matrix[i]![j] = fingerprints[i] === fingerprints[j];
    }
  }

  return { matrix, fingerprints, classOf, classCount };
}

/** Group config indices by equivalence class. */
export function equivalenceClasses(
  result: CongruenceMatrix,
): number[][] {
  const groups: number[][] = Array.from(
    { length: result.classCount },
    () => [],
  );
  for (let i = 0; i < result.classOf.length; i++) {
    groups[result.classOf[i]!]!.push(i);
  }
  return groups;
}
