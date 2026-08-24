import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, solveTransformSet, defaultParams } from './exact_cover_kernel.mjs';
import { buildCandidateDocument, parseCandidate, verifyExactClosure, SCHEMA, cadEligibility } from './json_contract.mjs';

test('radius-0 matching produces exact-closure JSON', () => {
  const N = 6;
  const P = 8;
  const { candidate } = solveTransformSet({
    N,
    pieceCount: P,
    radius: 0,
    params: { ...defaultParams(P), rounds: 1 },
    rand: mulberry32(42),
  });
  assert.ok(candidate);
  const doc = buildCandidateDocument({
    N,
    pieceCount: P,
    placements: candidate.placements,
    labelsA: candidate.labelsA,
    labelsB: candidate.labelsB,
    destOf: candidate.destOf,
    counts: candidate.counts,
    metrics: candidate,
    searchParameters: { radius: 0 },
    seed: 42,
  });
  assert.equal(doc.schema, SCHEMA);
  assert.equal(doc.version, 2);
  assert.equal(doc.gridResolution, 6);
  assert.equal(doc.N, 6);
  assert.equal(doc.validation.exactClosure.ok, true);
  assert.equal(doc.cadEligible, cadEligibility(candidate.counts, P, candidate).cadEligible);
  const parsed = parseCandidate(doc);
  assert.equal(verifyExactClosure(parsed).ok, true);
});

test('zero-volume pieces are not CAD-eligible', () => {
  const cad = cadEligibility([10, 0, 5], 3);
  assert.equal(cad.cadEligible, false);
  assert.deepEqual(cad.emptyPieces, [2]);
  assert.equal(cad.cadQueue, 'rejected-empty-piece');
});

test('disconnected source pieces are not CAD-eligible', () => {
  const cad = cadEligibility([21, 6, 51, 23, 12, 53, 16, 34], 8, {
    connected: 5,
    components: [
      { comps: 2 }, { comps: 1 }, { comps: 1 }, { comps: 1 },
      { comps: 2 }, { comps: 1 }, { comps: 1 }, { comps: 1 },
    ],
    minVol: 0.0278,
    fragileRatio: 0.106,
  });
  assert.equal(cad.cadEligible, false);
  assert.equal(cad.cadQueue, 'rejected-disconnected-source');
  assert.deepEqual(cad.disconnectedPieces, [1, 5]);
});
