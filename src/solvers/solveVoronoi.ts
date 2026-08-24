import type { DesignParams } from '../model/types';
import {
  createSeededRng,
  generatePlaneFirstLayout,
  type PlaneFirstOptions,
  type SymmetryMode,
} from './planeFirst';
import {
  disposePipelineResult,
  evaluateCandidate,
  type CandidateScore,
} from './score';

export interface SolveVoronoiOptions {
  partCount: 4 | 5 | 6 | 7 | 8;
  maxAttempts?: number;
  macroSize?: number;
  contactRadius?: number;
  clearanceGap?: number;
  symmetryMode?: SymmetryMode;
  halfExtent?: number;
  /** Fixed seed for deterministic search (tests / reproducible UI). */
  seed?: number;
  onAttempt?: (attempt: number, score: CandidateScore) => void;
}

export interface SolveVoronoiResult {
  params: DesignParams;
  score: CandidateScore;
  attempts: number;
  /** True when a fully green layout was found. */
  solved: boolean;
  message: string;
}

/**
 * Rejection / multi-try plane-first search until compliance is green
 * or the attempt budget is exhausted (returns best partial).
 */
export function solveVoronoi(
  options: SolveVoronoiOptions,
): SolveVoronoiResult {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 80);
  const rng =
    typeof options.seed === 'number'
      ? createSeededRng(options.seed).next
      : Math.random;

  const baseOpts: PlaneFirstOptions = {
    partCount: options.partCount,
    macroSize: options.macroSize,
    contactRadius: options.contactRadius,
    clearanceGap: options.clearanceGap,
    symmetryMode: options.symmetryMode,
    halfExtent: options.halfExtent,
    random: rng,
  };

  let bestParams: DesignParams | null = null;
  let bestScore: CandidateScore | null = null;
  let attempts = 0;

  for (let i = 0; i < maxAttempts; i++) {
    attempts = i + 1;
    const candidate = generatePlaneFirstLayout(baseOpts);
    const { score, pipeline } = evaluateCandidate(candidate);
    disposePipelineResult(pipeline);
    options.onAttempt?.(attempts, score);

    if (!bestScore || score.loss < bestScore.loss) {
      bestScore = score;
      bestParams = candidate;
    }

    if (score.compliant) {
      return {
        params: candidate,
        score,
        attempts,
        solved: true,
        message: `Solved: ${options.partCount} parts, 0 conflicts (${attempts} tries)`,
      };
    }
  }

  const params = bestParams!;
  const score = bestScore!;
  return {
    params,
    score,
    attempts,
    solved: false,
    message: `No fully green layout in ${attempts} tries; showing best (${score.violationCount} conflict${score.violationCount === 1 ? '' : 's'})`,
  };
}
