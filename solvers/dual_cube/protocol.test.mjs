import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32,
  solveTransformSet,
  serializeCandidate,
  defaultParams,
  compareKey,
} from './exact_cover_kernel.mjs';
import { buildCandidateDocument, verifyExactClosure } from './json_contract.mjs';

function jobSeed(campaignSeed, jobIndex) {
  return (campaignSeed + jobIndex * 10007) >>> 0;
}

test('same campaign seed and job index reproduce voxel labels', () => {
  const N = 6;
  const P = 8;
  const params = { ...defaultParams(P), rounds: 1 };
  const seed = jobSeed(20260820, 3);
  const a = solveTransformSet({ N, pieceCount: P, radius: 0, params, rand: mulberry32(seed) });
  const b = solveTransformSet({ N, pieceCount: P, radius: 0, params, rand: mulberry32(seed) });
  assert.ok(a.candidate && b.candidate);
  assert.equal(a.candidate.totalCost, b.candidate.totalCost);
  assert.deepEqual(Array.from(a.candidate.labelsA), Array.from(b.candidate.labelsA));
  assert.deepEqual(Array.from(a.candidate.destOf), Array.from(b.candidate.destOf));
  const doc = buildCandidateDocument({
    N,
    pieceCount: P,
    placements: a.candidate.placements,
    labelsA: a.candidate.labelsA,
    labelsB: a.candidate.labelsB,
    destOf: a.candidate.destOf,
    counts: a.candidate.counts,
    metrics: a.candidate,
    seed,
  });
  assert.equal(verifyExactClosure(doc).ok, true);
});

test('job seeds do not collide across the first 10k campaign indexes', () => {
  const seen = new Set();
  for (let i = 0; i < 10000; i++) {
    const s = jobSeed(20260820, i);
    assert.equal(seen.has(s), false);
    seen.add(s);
  }
});

test('archive merge is deterministic regardless of arrival order', () => {
  const N = 6;
  const P = 8;
  const params = { ...defaultParams(P), rounds: 1 };
  const cands = [];
  for (let i = 0; i < 5; i++) {
    const seed = jobSeed(99, i);
    const { candidate } = solveTransformSet({ N, pieceCount: P, radius: 0, params, rand: mulberry32(seed) });
    candidate.seed = seed;
    candidate.jobIndex = i;
    cands.push(serializeCandidate(candidate));
  }
  const sortFn = (a, b) => compareKey(a, b, P);
  const forward = [...cands].sort(sortFn).map((c) => c.seed);
  const reverse = [...cands].reverse().sort(sortFn).map((c) => c.seed);
  assert.deepEqual(forward, reverse);
});

test('checkpoint pending jobs resume the same seed stream', () => {
  const campaignSeed = 20260820;
  let campaignJobIndex = 0;
  const issued = [];
  for (let i = 0; i < 4; i++) {
    issued.push({ jobIndex: campaignJobIndex, seed: jobSeed(campaignSeed, campaignJobIndex) });
    campaignJobIndex++;
  }
  const checkpoint = { campaignSeed, campaignJobIndex, pendingJobs: issued.slice(2) };
  const restored = [];
  for (const job of checkpoint.pendingJobs) restored.push(job.seed);
  let idx = checkpoint.campaignJobIndex;
  restored.push(jobSeed(checkpoint.campaignSeed, idx++));
  assert.deepEqual(
    restored,
    [jobSeed(campaignSeed, 2), jobSeed(campaignSeed, 3), jobSeed(campaignSeed, 4)],
  );
  assert.equal(idx, 5);
});
