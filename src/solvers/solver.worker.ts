/// <reference lib="webworker" />
import type { DesignParams } from '../model/types';
import {
  solveVoronoi,
  type SolveVoronoiOptions,
  type SolveVoronoiResult,
} from './solveVoronoi';
import type { SymmetryMode } from './planeFirst';

export interface SolverWorkerRequest {
  id: number;
  options: {
    partCount: 4 | 5 | 6 | 7 | 8;
    maxAttempts?: number;
    macroSize?: number;
    contactRadius?: number;
    clearanceGap?: number;
    symmetryMode?: SymmetryMode;
    halfExtent?: number;
    seed?: number;
  };
}

export interface SolverWorkerSuccess {
  id: number;
  ok: true;
  result: {
    params: DesignParams;
    attempts: number;
    solved: boolean;
    message: string;
    loss: number;
    violationCount: number;
  };
}

export interface SolverWorkerFailure {
  id: number;
  ok: false;
  error: string;
}

export type SolverWorkerResponse = SolverWorkerSuccess | SolverWorkerFailure;

self.onmessage = (event: MessageEvent<SolverWorkerRequest>) => {
  const { id, options } = event.data;
  try {
    const solveOpts: SolveVoronoiOptions = { ...options };
    const solved: SolveVoronoiResult = solveVoronoi(solveOpts);
    const response: SolverWorkerSuccess = {
      id,
      ok: true,
      result: {
        params: solved.params,
        attempts: solved.attempts,
        solved: solved.solved,
        message: solved.message,
        loss: solved.score.loss,
        violationCount: solved.score.violationCount,
      },
    };
    self.postMessage(response);
  } catch (err) {
    const response: SolverWorkerFailure = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};
