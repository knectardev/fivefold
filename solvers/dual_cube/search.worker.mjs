import { mulberry32, solveTransformSet, serializeCandidate, defaultParams } from './exact_cover_kernel.mjs';
import { initWasmMatcher } from './wasm_matcher.mjs';

await initWasmMatcher();

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'solveSet') return;
  const { id, N, pieceCount, radius, params, seed } = msg;
  try {
    const rand = mulberry32(seed >>> 0);
    const p = { ...defaultParams(pieceCount), ...(params || {}) };
    const { candidate, timing } = solveTransformSet({ N, pieceCount, radius, params: p, rand });
    const serialized = serializeCandidate(candidate);
    self.postMessage({
      id,
      ok: true,
      infeasible: timing.infeasible,
      candidate: serialized,
      timing,
      diagnostics: {
        connected: candidate?.connected ?? 0,
        admissible: !!candidate?.admissibility?.pass,
        archiveKey: serialized?.archiveKey ?? null,
      },
    });
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
