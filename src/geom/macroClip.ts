import type { BufferGeometry } from 'three';
import { effectiveMacroSize, type DesignParams } from '../model/types';
import { softClipToMacro } from './hull';

/**
 * Soft-clamp parts into the macro shape by projecting vertices.
 * Avoids three-bvh-csg intersection shards.
 */
export function clipToMacro(
  hull: BufferGeometry,
  params: DesignParams,
): BufferGeometry {
  return softClipToMacro(hull, params, effectiveMacroSize(params));
}

export function clipAllToMacro(
  hulls: BufferGeometry[],
  params: DesignParams,
): BufferGeometry[] {
  return hulls.map((h) => clipToMacro(h, params));
}
