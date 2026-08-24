import { Matrix4 } from 'three';
import type { DesignParams } from '../model/types';
import {
  complianceSummary,
  evaluatePlaneCompliance,
  type PlaneComplianceResult,
} from '../geom/planeCompliance';
import {
  runGeometryPipeline,
  type PipelineResult,
} from '../geom/pipeline';
import type { PartHalvesGeometry } from '../geom/hull';

export interface CandidateScore {
  compliant: boolean;
  /** Lower is better. 0 = fully green. */
  loss: number;
  violationCount: number;
  boundsCount: number;
  planeCount: number;
  solidCount: number;
  results: PlaneComplianceResult[];
  summary: string;
}

function halvesToMeshPairs(halves: PartHalvesGeometry[]) {
  const id = new Matrix4();
  return halves.map((h) => ({
    a: { geometry: h.halfA, matrix: id },
    b: { geometry: h.halfB, matrix: id },
  }));
}

export function scoreCompliance(
  results: PlaneComplianceResult[],
): CandidateScore {
  let boundsCount = 0;
  let planeCount = 0;
  let solidCount = 0;
  for (const r of results) {
    for (const v of r.violations) {
      if (v === 'bounds') boundsCount++;
      else if (v === 'plane') planeCount++;
      else if (v === 'solid') solidCount++;
    }
  }
  const violationCount = boundsCount + planeCount + solidCount;
  // Weight solid conflicts higher — they are the hardest RED flags.
  const loss = boundsCount * 2 + planeCount * 3 + solidCount * 4;
  return {
    compliant: violationCount === 0,
    loss,
    violationCount,
    boundsCount,
    planeCount,
    solidCount,
    results,
    summary: complianceSummary(results),
  };
}

/**
 * Run geometry pipeline + plane compliance for a candidate layout.
 * Caller should dispose pipeline geometries when done.
 */
export function evaluateCandidate(params: DesignParams): {
  score: CandidateScore;
  pipeline: PipelineResult;
} {
  const pipeline = runGeometryPipeline(params, { keepEnvelopes: false });
  const halfMeshes = halvesToMeshPairs(pipeline.halves);
  const results = evaluatePlaneCompliance(
    pipeline.skeleton,
    params,
    halfMeshes,
  );
  return { score: scoreCompliance(results), pipeline };
}

export function disposePipelineResult(pipeline: PipelineResult): void {
  for (const p of pipeline.parts) p.dispose();
  for (const e of pipeline.envelopes) e.dispose();
  for (const h of pipeline.clippedHulls) h.dispose();
}
