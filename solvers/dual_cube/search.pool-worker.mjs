import { parentPort } from 'node:worker_threads';
import { mulberry32, solveTransformSet, serializeCandidate, defaultParams } from './exact_cover_kernel.mjs';
import { initWasmMatcher } from './wasm_matcher.mjs';

await initWasmMatcher();

parentPort.on('message', (job) => {
  if (!job || job.type === 'end') {
    parentPort.postMessage({ type: 'end' });
    return;
  }
  const { N, pieceCount, radius, params, seed, jobIndex } = job;
  const rand = mulberry32(seed >>> 0);
  const p = { ...defaultParams(pieceCount), ...(params || {}) };
  const { candidate, timing } = solveTransformSet({ N, pieceCount, radius, params: p, rand });
  parentPort.postMessage({
    type: 'result',
    ok: true,
    infeasible: timing.infeasible,
    candidate: serializeCandidate(candidate),
    timing,
    seed,
    jobIndex,
  });
});
