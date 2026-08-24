import { Vector3 } from 'three';
import type { DesignParams, PartRest, Skeleton } from '../model/types';
import { effectiveMacroSize, partHalfExtent } from '../model/types';
import { clampPointToMacroShape } from '../geom/convexClip';

export type HalfId = 'A' | 'B';

export interface DualHalfSeed {
  partIndex: number;
  half: HalfId;
  position: Vector3;
}

/**
 * Offset from midplane origin along ±axis for a dual-seed Voronoi half.
 * Uses a fraction of the part half-extent so the seed sits inside the half volume.
 */
export function dualSeedOffset(
  params: DesignParams,
  partIndex: number,
  half: HalfId,
): number {
  const pp = params.parts[partIndex];
  const extent = partHalfExtent(params, pp, half);
  return Math.max(0.05, extent * 0.45);
}

/** Half-seed position: A = origin − d·n, B = origin + d·n. */
export function halfSeedPosition(
  origin: Vector3,
  axis: Vector3,
  offset: number,
  half: HalfId,
): Vector3 {
  const sign = half === 'A' ? -1 : 1;
  return origin
    .clone()
    .addScaledVector(axis.clone().normalize(), sign * offset);
}

/**
 * Collect all 2N half-seeds for a skeleton, clamped inside the macro domain.
 */
export function collectDualSeeds(
  skeleton: Skeleton,
  params: DesignParams,
): DualHalfSeed[] {
  const half = effectiveMacroSize(params) * 0.5;
  const seeds: DualHalfSeed[] = [];
  for (const part of skeleton.parts) {
    for (const h of ['A', 'B'] as const) {
      const d = dualSeedOffset(params, part.index, h);
      const pos = halfSeedPosition(part.origin, part.axis, d, h);
      clampPointToMacroShape(pos, params.macroShape, half);
      seeds.push({ partIndex: part.index, half: h, position: pos });
    }
  }
  return seeds;
}

/** Seeds for one part's two halves (unclamped — for unit tests). */
export function partDualSeeds(
  part: PartRest,
  params: DesignParams,
): { seedA: Vector3; seedB: Vector3; offsetA: number; offsetB: number } {
  const offsetA = dualSeedOffset(params, part.index, 'A');
  const offsetB = dualSeedOffset(params, part.index, 'B');
  return {
    seedA: halfSeedPosition(part.origin, part.axis, offsetA, 'A'),
    seedB: halfSeedPosition(part.origin, part.axis, offsetB, 'B'),
    offsetA,
    offsetB,
  };
}
