import type { ShapeConfig } from '../types';
import { identityTransform, ohTransform } from '../canonicalize';
import { Matrix4 } from 'three';

/** Re-export gallery fixtures used by tests (kept under fixtures/ per plan). */
export {
  syntheticIdenticalPair,
  syntheticDistinctPair,
  chiralMirrorPair,
  chiralPointSets,
} from '../configs12';

/** Extra fixture: empty config (degenerate). */
export function emptyConfig(): ShapeConfig {
  return { id: 'empty', label: 'empty', instances: [] };
}

/** Oh identity matrix helper for fixture builders. */
export function identityLinear(): Matrix4 {
  return identityTransform();
}

export { ohTransform };
