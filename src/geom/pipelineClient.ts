import type { BufferGeometry } from 'three';
import type { DesignParams } from '../model/types';
import { buildSkeleton } from '../model/skeleton';
import { deserializeGeometry } from './serializeGeometry';
import type {
  PipelineWorkerRequest,
  PipelineWorkerResponse,
} from './pipeline.worker';
import type { PipelineResult } from './pipeline';

let worker: Worker | null = null;
let nextId = 1;
let busy = false;
let queued: {
  params: DesignParams;
  resolve: (value: { id: number; result: PipelineResult }) => void;
  reject: (reason?: unknown) => void;
} | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), {
      type: 'module',
    });
  }
  return worker;
}

function postRun(
  params: DesignParams,
): Promise<{ id: number; result: PipelineResult }> {
  const id = nextId++;
  const w = getWorker();
  // Snapshot once — worker geometry and main-thread skeleton must match.
  const snapshot = structuredClone(params);
  const payload: PipelineWorkerRequest = {
    id,
    params: snapshot,
  };

  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<PipelineWorkerResponse>) => {
      const data = event.data;
      if (data.id !== id) return;
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);

      if (!data.ok) {
        reject(new Error(data.error));
        return;
      }

      const parts: BufferGeometry[] = data.parts.map(deserializeGeometry);
      const envelopes: BufferGeometry[] = data.envelopes.map(
        deserializeGeometry,
      );
      const skeleton = buildSkeleton(snapshot);
      const halves = [];
      for (let i = 0; i < parts.length; i += 2) {
        if (parts[i] && parts[i + 1]) {
          halves.push({ halfA: parts[i], halfB: parts[i + 1] });
        }
      }

      resolve({
        id,
        result: {
          skeleton,
          halves,
          parts,
          envelopes,
          clippedHulls: [],
        },
      });
    };

    const onError = (err: ErrorEvent) => {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      reject(err.error ?? new Error(err.message || 'Pipeline worker failed'));
    };

    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    w.postMessage(payload);
  });
}

/**
 * Run the geometry pipeline off the main thread.
 * Concurrent calls coalesce to the latest params so intermediate rebuilds are skipped.
 */
export async function runGeometryPipelineAsync(
  params: DesignParams,
): Promise<{ id: number; result: PipelineResult }> {
  if (busy) {
    return new Promise((resolve, reject) => {
      if (queued) {
        queued.reject(new Error('superseded'));
      }
      queued = { params: structuredClone(params), resolve, reject };
    });
  }

  busy = true;
  try {
    return await postRun(params);
  } finally {
    busy = false;
    if (queued) {
      const next = queued;
      queued = null;
      void runGeometryPipelineAsync(next.params).then(next.resolve, next.reject);
    }
  }
}
