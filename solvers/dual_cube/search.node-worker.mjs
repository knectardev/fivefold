import { parentPort, workerData } from 'node:worker_threads';
import { mulberry32, solveTransformSet, serializeCandidate, defaultParams } from './exact_cover_kernel.mjs';
import { initWasmMatcher } from './wasm_matcher.mjs';

await initWasmMatcher();
const { N, pieceCount, radius, params, seed } = workerData;
const rand = mulberry32(seed >>> 0);
const p = { ...defaultParams(pieceCount), ...(params || {}) };
const { candidate, timing } = solveTransformSet({ N, pieceCount, radius, params: p, rand });
parentPort.postMessage({
  ok: true,
  infeasible: timing.infeasible,
  candidate: serializeCandidate(candidate),
  timing,
});
