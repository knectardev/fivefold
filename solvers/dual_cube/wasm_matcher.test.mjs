import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mulberry32,
  makeEdges,
  defaultParams,
  minCostPerfectMatchingJS,
  randomTransforms,
  randomSeedLayout,
} from './exact_cover_kernel.mjs';
import { packEdges } from './match_protocol.mjs';
import { verifyExactClosure } from './json_contract.mjs';
import {
  initWasmMatcher,
  matchPackedGraphWithWasm,
  matchPackedGraphReference,
  wasmStatus,
} from './wasm_matcher.mjs';

const wasmPath = join(dirname(fileURLToPath(import.meta.url)), 'matching_kernel.wasm');

function sampleEdges(N = 6, P = 8, seed = 20260820) {
  const params = { ...defaultParams(P), rounds: 1 };
  const rand = mulberry32(seed);
  const placements = randomTransforms(P, 0, params.minMoved, rand);
  const seedsA = randomSeedLayout(N, P, params.asym, rand);
  const seedsB = randomSeedLayout(N, P, params.asym, rand);
  return makeEdges(N, P, placements, seedsA, seedsB, new Float64Array(P), params);
}

test('packed graph round-trips through the frozen ABI', () => {
  const edges = sampleEdges();
  const buf = packEdges(edges);
  const js = matchPackedGraphReference(buf);
  assert.ok(js.match);
  assert.equal(js.backend, 'js-reference');
  assert.equal(js.match.labelsA.length, 6 * 6 * 6);
});

test('WASM matcher matches JS feasibility, cost, assignment, and exact closure', {
  skip: existsSync(wasmPath) ? false : 'matching_kernel.wasm not built yet',
}, async () => {
  const loaded = await initWasmMatcher({ installBackend: false });
  assert.equal(loaded.ok, true, loaded.reason);
  assert.equal(wasmStatus().ready, true);

  for (const [N, seed] of [[6, 20260820], [6, 99], [8, 20260820]]) {
    const P = 8;
    const params = { ...defaultParams(P), rounds: 1 };
    const rand = mulberry32(seed);
    const placements = randomTransforms(P, 0, params.minMoved, rand);
    const seedsA = randomSeedLayout(N, P, params.asym, rand);
    const seedsB = randomSeedLayout(N, P, params.asym, rand);
    const edges = makeEdges(N, P, placements, seedsA, seedsB, new Float64Array(P), params);
    const buf = packEdges(edges);
    const js = minCostPerfectMatchingJS(edges);
    const wasm = matchPackedGraphWithWasm(buf);
    assert.ok(js, `JS infeasible at N=${N} seed=${seed}`);
    assert.ok(wasm.match, `WASM infeasible at N=${N} seed=${seed}`);
    const costTol = 1e-6 * Math.max(1, Math.abs(js.totalCost));
    assert.ok(Math.abs(js.totalCost - wasm.match.totalCost) <= costTol, `cost mismatch N=${N}`);
    assert.deepEqual(Array.from(wasm.match.labelsA), Array.from(js.labelsA));
    assert.deepEqual(Array.from(wasm.match.destOf), Array.from(js.destOf));
    const closure = verifyExactClosure({
      gridResolution: N,
      pieceCount: P,
      labelsA: wasm.match.labelsA,
      labelsB: wasm.match.labelsB,
      destOf: wasm.match.destOf,
      placements,
    });
    assert.equal(closure.ok, true, closure.reasons.join('; '));
  }
});
