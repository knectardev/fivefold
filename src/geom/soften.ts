import type { BufferGeometry } from 'three';
import { shrinkGeometry } from './csgEpsilon';

/**
 * Parametric soften: inward shrink as a chamfer/fillet proxy.
 * Keeps geometry inside the safe envelope without freeform sculpting.
 */
export function softenParts(
  parts: BufferGeometry[],
  amount: number,
): BufferGeometry[] {
  if (amount <= 0) return parts.map((p) => p.clone());
  return parts.map((p) => shrinkGeometry(p, amount));
}
