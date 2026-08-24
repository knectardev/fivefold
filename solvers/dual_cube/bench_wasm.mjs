/**
 * JS vs WASM matching kernel timing. Compile first: node solvers/dual_cube/build_wasm.mjs
 */
import { mulberry32, makeEdges, defaultParams, minCostPerfectMatchingJS, randomTransforms, randomSeedLayout } from './exact_cover_kernel.mjs';
import { packEdges } from './match_protocol.mjs';
import { initWasmMatcher, matchPackedGraphWithWasm } from './wasm_matcher.mjs';
import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const loaded = await initWasmMatcher({ installBackend: false });
if (!loaded.ok) {
  console.error(loaded.reason);
  process.exit(1);
}

function graph(N, seed) {
  const P = 8;
  const params = { ...defaultParams(P), rounds: 1 };
  const rand = mulberry32(seed);
  const placements = randomTransforms(P, 0, params.minMoved, rand);
  const seedsA = randomSeedLayout(N, P, params.asym, rand);
  const seedsB = randomSeedLayout(N, P, params.asym, rand);
  return makeEdges(N, P, placements, seedsA, seedsB, new Float64Array(P), params);
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const rows = [];
for (const N of [6, 8, 10]) {
  const edges = graph(N, 20260820);
  const buf = packEdges(edges);
  const jsTimes = [];
  const wasmTimes = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    minCostPerfectMatchingJS(edges);
    jsTimes.push(performance.now() - t0);
    const t1 = performance.now();
    matchPackedGraphWithWasm(buf);
    wasmTimes.push(performance.now() - t1);
  }
  const js = median(jsTimes);
  const wasm = median(wasmTimes);
  rows.push({
    N,
    voxels: N ** 3,
    jsMs: +js.toFixed(2),
    wasmMs: +wasm.toFixed(2),
    speedup: +(js / wasm).toFixed(2),
  });
}
console.log(JSON.stringify({ backend: 'wasm vs js-reference', rows }, null, 2));

const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'search.node-worker.mjs');
function workerJob(seed) {
  return {
    N: 8,
    pieceCount: 8,
    radius: 0,
    params: { ...defaultParams(8), rounds: 1 },
    seed,
  };
}
function runWorker(seed) {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerPath, { workerData: workerJob(seed) });
    w.on('message', (msg) => {
      w.terminate();
      resolve(msg);
    });
    w.on('error', reject);
  });
}
async function pool(workers, jobCount) {
  const t0 = performance.now();
  let cursor = 0;
  async function loop() {
    while (cursor < jobCount) {
      const i = cursor++;
      await runWorker((20260820 + i * 7919) >>> 0);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => loop()));
  return performance.now() - t0;
}
const jobCount = 8;
const serial = await pool(1, jobCount);
const parallel = await pool(4, jobCount);
console.log(JSON.stringify({
  fourWorkerCheck: {
    N: 8,
    jobs: jobCount,
    rounds: 1,
    workers1Ms: +serial.toFixed(0),
    workers4Ms: +parallel.toFixed(0),
    speedup: +(serial / parallel).toFixed(2),
    efficiency: +((serial / parallel) / 4).toFixed(2),
  },
}, null, 2));

