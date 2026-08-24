/// <reference lib="webworker" />
import type { DesignParams } from '../model/types';
import { runGeometryPipeline } from './pipeline';
import {
  serializeGeometry,
  transferablesFor,
  type SerializedGeometry,
} from './serializeGeometry';

export interface PipelineWorkerRequest {
  id: number;
  params: DesignParams;
}

export interface PipelineWorkerSuccess {
  id: number;
  ok: true;
  parts: SerializedGeometry[];
  envelopes: SerializedGeometry[];
}

export interface PipelineWorkerFailure {
  id: number;
  ok: false;
  error: string;
}

export type PipelineWorkerResponse =
  | PipelineWorkerSuccess
  | PipelineWorkerFailure;

self.onmessage = (event: MessageEvent<PipelineWorkerRequest>) => {
  const { id, params } = event.data;
  try {
    const result = runGeometryPipeline(params, {
      keepEnvelopes: params.showEnvelopes,
    });

    const parts = result.parts.map(serializeGeometry);
    const envelopes = result.envelopes.map(serializeGeometry);

    for (const p of result.parts) p.dispose();
    for (const h of result.clippedHulls) h.dispose();
    for (const e of result.envelopes) e.dispose();

    const response: PipelineWorkerSuccess = {
      id,
      ok: true,
      parts,
      envelopes,
    };
    const transfer = [
      ...transferablesFor(parts),
      ...transferablesFor(envelopes),
    ];
    self.postMessage(response, { transfer });
  } catch (err) {
    const response: PipelineWorkerFailure = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};
