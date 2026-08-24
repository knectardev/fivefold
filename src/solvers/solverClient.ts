import type { DesignParams } from '../model/types';
import type { SymmetryMode } from './planeFirst';
import type {
  SolverWorkerRequest,
  SolverWorkerResponse,
} from './solver.worker';

export interface SolveVoronoiAsyncOptions {
  partCount: 4 | 5 | 6 | 7 | 8;
  maxAttempts?: number;
  macroSize?: number;
  contactRadius?: number;
  clearanceGap?: number;
  symmetryMode?: SymmetryMode;
  halfExtent?: number;
  seed?: number;
}

export interface SolveVoronoiAsyncResult {
  params: DesignParams;
  attempts: number;
  solved: boolean;
  message: string;
  loss: number;
  violationCount: number;
}

let worker: Worker | null = null;
let nextId = 1;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./solver.worker.ts', import.meta.url), {
      type: 'module',
    });
  }
  return worker;
}

/**
 * Run plane-first Voronoi solve off the main thread.
 */
export function solveVoronoiAsync(
  options: SolveVoronoiAsyncOptions,
): Promise<SolveVoronoiAsyncResult> {
  const id = nextId++;
  const w = getWorker();
  const payload: SolverWorkerRequest = {
    id,
    options: { ...options },
  };

  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<SolverWorkerResponse>) => {
      const data = event.data;
      if (data.id !== id) return;
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      if (!data.ok) {
        reject(new Error(data.error));
        return;
      }
      resolve(data.result);
    };
    const onError = (err: ErrorEvent) => {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      reject(err.error ?? new Error(err.message || 'Solver worker failed'));
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    w.postMessage(payload);
  });
}
