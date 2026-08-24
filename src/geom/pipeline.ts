import type { BufferGeometry } from 'three';
import { type DesignParams, type Skeleton } from '../model/types';
import { buildSkeleton } from '../model/skeleton';
import {
  buildAllPartHalves,
  type PartHalvesGeometry,
} from './hull';
import { buildInteriorEnvelopes } from './sweptClearance';
import { clipHalvesToMacro, resolveFreeHalves } from './intersectionTrim';

export interface PipelineOptions {
  keepEnvelopes?: boolean;
}

export interface PipelineResult {
  skeleton: Skeleton;
  /** One entry per part: half A + half B solids. */
  halves: PartHalvesGeometry[];
  /** Flattened [halfA0, halfB0, halfA1, halfB1, ...] for export convenience. */
  parts: BufferGeometry[];
  envelopes: BufferGeometry[];
  clippedHulls: BufferGeometry[];
}

export function runGeometryPipeline(
  params: DesignParams,
  options: PipelineOptions = {},
): PipelineResult {
  const keepEnvelopes = options.keepEnvelopes ?? params.showEnvelopes;
  const skeleton = buildSkeleton(params);
  const raw = buildAllPartHalves(skeleton, params);

  const halves =
    params.layoutMode === 'free'
      ? resolveFreeHalves(skeleton, params, raw)
      : clipHalvesToMacro(raw, params);

  const parts: BufferGeometry[] = [];
  for (const h of halves) {
    parts.push(h.halfA, h.halfB);
  }

  const envelopes = keepEnvelopes
    ? buildInteriorEnvelopes(skeleton, params)
    : [];

  return { skeleton, halves, parts, envelopes, clippedHulls: [] };
}

export const REBUILD_DEBOUNCE_MS = 175;
