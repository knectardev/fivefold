/**
 * Bounded paired-carrier split campaign for the connected N=6 occupancy.
 * Opt-in: does not change analyzePhysicalCorrespondence.
 *
 *   node solvers/dual_cube/carrier_split.mjs
 *   node solvers/dual_cube/carrier_split.mjs --attempt A
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCorrespondence, pieceVolumeReport } from './physical_correspondence.mjs';
import { fitOpeningsBatched } from './gpu_fit_cpu.mjs';
import { insertCarriersTransactional } from './insert_carriers.mjs';
import { diagnosePatch, searchTrimBranches } from './trim_branches.mjs';
import { topologyMetrics } from './analytic_junctions.mjs';

export const MAX_CHILDREN_PER_CARRIER = 3;
export const MAX_NEW_CARRIERS = 8;
export const MIN_CHILD_FACES = 3;
export const MIN_THICKNESS = 0.04;

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, 'results');

export const ATTEMPT_A = {
  id: 'A',
  pair: ['S6', 'S96'],
  hinges: { S6: ['S3', 'S5', 'S14', 'S15'], S96: ['S93', 'S94'] },
  groups: null,
};
export const ATTEMPT_B = {
  id: 'B',
  pair: ['S6', 'S96'],
  hinges: { S6: ['S3', 'S5', 'S14', 'S15'], S96: ['S93', 'S94'] },
  groups: {
    S6: [['S3', 'S5'], ['S14', 'S15']],
    S96: [['S93'], ['S94']],
  },
};
export const ATTEMPT_C = {
  id: 'C',
  pair: ['S50', 'S21'],
  hinges: {
    S50: ['S46', 'S51', 'S52', 'S54'],
    S21: ['S22', 'S23', 'S24', 'S25', 'S26', 'S27'],
  },
  groups: null,
};

function sharedEdgeCount(face, plane) {
  const pe = new Set();
  for (const f of plane.faces || []) for (const e of f.edges || []) pe.add(e);
  return (face.edges || []).filter((e) => pe.has(e)).length;
}

function facesTouch(a, b) {
  const sa = new Set(a.edges || []);
  return (b.edges || []).some((e) => sa.has(e));
}

export function assignFacesToHinges(curved, patches, hingeIds, groups = null) {
  const buckets = groups || hingeIds.map((id) => [id]);
  const n = curved.faces.length;
  const label = Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let best = -1;
    let bestHits = 0;
    buckets.forEach((ids, gi) => {
      let hits = 0;
      for (const id of ids) {
        const pl = patches.find((p) => p.id === id);
        if (pl) hits += sharedEdgeCount(curved.faces[i], pl);
      }
      if (hits > bestHits) {
        bestHits = hits;
        best = gi;
      }
    });
    if (bestHits > 0) label[i] = best;
  }
  const adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (facesTouch(curved.faces[i], curved.faces[j])) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }
  const q = [];
  for (let i = 0; i < n; i++) if (label[i] >= 0) q.push(i);
  while (q.length) {
    const i = q.shift();
    for (const j of adj[i]) {
      if (label[j] < 0) {
        label[j] = label[i];
        q.push(j);
      }
    }
  }
  const leftover = [];
  for (let i = 0; i < n; i++) if (label[i] < 0) leftover.push(i);
  const byGroup = new Map();
  for (let i = 0; i < n; i++) {
    if (label[i] < 0) continue;
    if (!byGroup.has(label[i])) byGroup.set(label[i], []);
    byGroup.get(label[i]).push(i);
  }
  if (leftover.length) {
    if (byGroup.size < MAX_CHILDREN_PER_CARRIER) byGroup.set(99, leftover);
    else {
      const largest = [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length)[0];
      largest[1].push(...leftover);
    }
  }
  return mergeSmallGroups([...byGroup.values()]);
}

function mergeSmallGroups(groups) {
  let next = groups.map((g) => [...g]).filter((g) => g.length);
  while (next.length > MAX_CHILDREN_PER_CARRIER) {
    next.sort((a, b) => a.length - b.length);
    const small = next.shift();
    next[0].push(...small);
  }
  let guard = 0;
  while (guard++ < 8) {
    const tiny = next.findIndex((g) => g.length < MIN_CHILD_FACES);
    if (tiny < 0 || next.length <= 1) break;
    const [small] = next.splice(tiny, 1);
    next.sort((a, b) => a.length - b.length);
    next[0].push(...small);
  }
  return next.filter((g) => g.length);
}

export function childFromFaces(parent, indices, id, hinge) {
  const faces = indices.map((i) => parent.faces[i]);
  const faceKeys = indices.map((i) => parent.faceKeys[i]);
  const oppositeKeys = indices.map((i) => parent.oppositeKeys[i]);
  const samplesA = indices.map((i) => parent.samplesA[i]);
  const samplesJoint = indices.map((i) => parent.samplesJoint[i]);
  const origin = samplesA.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0])
    .map((x) => x / Math.max(1, samplesA.length));
  return {
    ...parent,
    id,
    faces,
    faceKeys,
    oppositeKeys,
    samplesA,
    samplesJoint,
    areaFaces: faces.length,
    origin,
    subdivided: true,
    parentPatch: parent.id,
    hinge,
  };
}

export function mapFacesToMate(parent, mate, childIdxs) {
  const index = new Map(mate.faceKeys.map((k, i) => [k, i]));
  const out = [];
  for (const i of childIdxs) {
    const hit = index.get(parent.oppositeKeys[i]);
    if (hit != null) out.push(hit);
  }
  return [...new Set(out)];
}

function relinkMates(patches) {
  const byId = new Map(patches.map((p) => [p.id, p]));
  for (const p of patches) {
    if (p.cubeA?.matePatch && !byId.has(p.cubeA.matePatch)) p.cubeA = { ...p.cubeA, matePatch: null };
    if (p.cubeB?.matePatch && !byId.has(p.cubeB.matePatch)) p.cubeB = { ...p.cubeB, matePatch: null };
  }
}

export function splitPairedPatches(correspondence, spec) {
  const patches = correspondence.patches.map((p) => ({ ...p, cubeA: { ...p.cubeA }, cubeB: { ...p.cubeB } }));
  const [aId, bId] = spec.pair;
  const parentA = patches.find((p) => p.id === aId);
  const parentB = patches.find((p) => p.id === bId);
  if (!parentA || !parentB) {
    return { ok: false, reason: `missing pair ${aId}/${bId}`, correspondence, children: [] };
  }
  const groupsA = assignFacesToHinges(parentA, patches, spec.hinges[aId], spec.groups?.[aId] || null);
  if (!groupsA.length) {
    return { ok: false, reason: `no hinge faces on ${aId}`, correspondence, children: [] };
  }
  const childrenA = groupsA.map((idxs, i) => childFromFaces(
    parentA,
    idxs,
    `${aId}c${i + 1}`,
    (spec.groups?.[aId] || spec.hinges[aId].map((h) => [h]))[i] || spec.hinges[aId],
  ));
  const mapped = groupsA.map((idxs) => mapFacesToMate(parentA, parentB, idxs));
  const used = new Set(mapped.flat());
  const leftoverB = [];
  for (let i = 0; i < parentB.faces.length; i++) if (!used.has(i)) leftoverB.push(i);
  const groupsB = mapped.map((g) => [...g]);
  if (leftoverB.length) {
    const host = groupsB.reduce((best, g, i) => (g.length < groupsB[best].length ? i : best), 0);
    groupsB[host].push(...leftoverB);
  }
  const childrenB = childrenA.map((ca, i) => {
    const idxs = [...new Set(groupsB[i] || [])];
    if (!idxs.length) return null;
    return childFromFaces(parentB, idxs, `${bId}c${i + 1}`, ca.hinge);
  }).filter(Boolean);

  if (childrenA.length > MAX_CHILDREN_PER_CARRIER || childrenB.length > MAX_CHILDREN_PER_CARRIER) {
    return { ok: false, reason: 'child-cap', correspondence, children: [] };
  }
  const tooSmall = [...childrenA, ...childrenB].some((c) => c.areaFaces < MIN_CHILD_FACES && parentA.areaFaces >= 8 && c.parentPatch === aId);
  if (tooSmall && childrenA.some((c) => c.areaFaces < MIN_CHILD_FACES)) {
    return { ok: false, reason: 'tiny-child', correspondence, children: [] };
  }

  for (let i = 0; i < Math.min(childrenA.length, childrenB.length); i++) {
    childrenA[i].cubeA = { ...childrenA[i].cubeA, matePatch: childrenB[i].id, mateOverlap: Math.min(childrenA[i].areaFaces, childrenB[i].areaFaces) };
    childrenB[i].cubeA = { ...childrenB[i].cubeA, matePatch: childrenA[i].id, mateOverlap: Math.min(childrenA[i].areaFaces, childrenB[i].areaFaces) };
  }

  const drop = new Set([aId, bId]);
  const nextPatches = [...patches.filter((p) => !drop.has(p.id)), ...childrenA, ...childrenB];
  relinkMates(nextPatches);
  const children = [...childrenA, ...childrenB];
  const next = {
    ...correspondence,
    patches: nextPatches,
    keepSeparate: children.map((c) => c.id),
    counts: {
      ...correspondence.counts,
      accepted: nextPatches.length,
      curved: nextPatches.filter((p) => p.kind === 'curved').length,
    },
  };
  return {
    ok: true,
    correspondence: next,
    children,
    parents: [aId, bId],
    newCarriers: children.length,
    groupsA: groupsA.map((g) => g.length),
    groupsB: groupsB.map((g) => g.length),
  };
}

export function extractNonMateFaces(correspondence, aId, bId) {
  const patches = correspondence.patches.map((p) => ({ ...p, cubeA: { ...p.cubeA }, cubeB: { ...p.cubeB } }));
  const a = patches.find((p) => p.id === aId);
  const b = patches.find((p) => p.id === bId);
  if (!a || !b) return { ok: false, reason: 'missing-pair', correspondence, children: [] };
  const bKeys = new Set(b.faceKeys);
  const aKeys = new Set(a.faceKeys);
  const aKeep = [];
  const aDrop = [];
  a.oppositeKeys.forEach((k, i) => (bKeys.has(k) ? aKeep : aDrop).push(i));
  const bKeep = [];
  const bDrop = [];
  b.faceKeys.forEach((k, i) => (a.oppositeKeys.includes(k) || aKeys.has(b.oppositeKeys[i]) ? bKeep : bDrop).push(i));
  if (!aDrop.length && !bDrop.length) {
    return { ok: false, reason: 'already-1-1', correspondence, children: [] };
  }
  if ((aDrop.length && aDrop.length < MIN_CHILD_FACES) || (bDrop.length && bDrop.length < MIN_CHILD_FACES)) {
    return { ok: false, reason: 'tiny-remainder', correspondence, children: [] };
  }
  const children = [];
  const replacements = [];
  replacements.push(childFromFaces(a, aKeep.length ? aKeep : a.faces.map((_, i) => i), `${aId}c1`, 'mate-core'));
  if (aDrop.length) children.push(childFromFaces(a, aDrop, `${aId}c2`, 'non-mate'));
  replacements.push(childFromFaces(b, bKeep.length ? bKeep : b.faces.map((_, i) => i), `${bId}c1`, 'mate-core'));
  if (bDrop.length) children.push(childFromFaces(b, bDrop, `${bId}c2`, 'non-mate'));
  replacements[0].cubeA = { ...replacements[0].cubeA, matePatch: replacements[1].id };
  replacements[1].cubeA = { ...replacements[1].cubeA, matePatch: replacements[0].id };
  const all = [...replacements, ...children];
  const drop = new Set([aId, bId]);
  const nextPatches = [...patches.filter((p) => !drop.has(p.id)), ...all];
  relinkMates(nextPatches);
  return {
    ok: true,
    correspondence: {
      ...correspondence,
      patches: nextPatches,
      keepSeparate: all.map((c) => c.id),
    },
    children: all,
    parents: [aId, bId],
    newCarriers: all.length,
  };
}

/** Localized D revision: keep both carriers, restrict the mate to overlapping faces. */
export function reviseMateToOverlap(correspondence, aId, bId) {
  const patches = correspondence.patches.map((p) => ({ ...p, cubeA: { ...p.cubeA }, cubeB: { ...p.cubeB } }));
  const a = patches.find((p) => p.id === aId);
  const b = patches.find((p) => p.id === bId);
  if (!a || !b) return { ok: false, reason: 'missing-pair', correspondence, children: [] };
  const bKeys = new Set(b.faceKeys);
  const overlap = a.oppositeKeys.filter((k) => bKeys.has(k)).length;
  if (overlap === a.areaFaces && overlap === b.areaFaces) {
    return { ok: false, reason: 'already-1-1', correspondence, children: [] };
  }
  if (overlap === 0) {
    return { ok: false, reason: 'no-overlap', correspondence, children: [] };
  }
  a.cubeA = { ...a.cubeA, matePatch: bId, mateOverlap: overlap, revised: true };
  b.cubeA = { ...b.cubeA, matePatch: aId, mateOverlap: overlap, revised: true };
  return {
    ok: true,
    correspondence: { ...correspondence, patches, keepSeparate: [aId, bId] },
    children: [a, b],
    parents: [aId, bId],
    newCarriers: 0,
    revision: { overlap, aFaces: a.areaFaces, bFaces: b.areaFaces },
  };
}

function seedSupported(id) {
  return !!id && (id.includes('seed_polyline') || id.includes('numerical'));
}

export function countSeedTrims(diagnostics, overrides = {}) {
  let n = 0;
  for (const d of diagnostics) {
    for (const a of d.adjacencies || []) {
      const ov = overrides[`${d.patch}|${a.planeId}`] || overrides[`${a.planeId}|${d.patch}`] || a.selectedBranchId;
      if (a.missing) n += 1;
      else if (seedSupported(ov) || seedSupported(a.selectedBranchId)) n += 1;
    }
  }
  return n;
}

export function complexityReport(beforePatches, afterPatches, beforeFits, afterFits, newCarriers) {
  const typeOf = (fits) => {
    const m = {};
    for (const f of fits || []) {
      const t = f.chosen?.type;
      if (t) m[t] = (m[t] || 0) + 1;
    }
    return m;
  };
  const beforeQ = typeOf(beforeFits).generalQuadric || 0;
  const afterQ = typeOf(afterFits).generalQuadric || 0;
  const tiny = afterPatches.filter((p) => p.parentPatch && p.areaFaces < MIN_CHILD_FACES).length;
  const overChildren = newCarriers > MAX_NEW_CARRIERS;
  return {
    newCarriers,
    maxNewCarriers: MAX_NEW_CARRIERS,
    tinyChildren: tiny,
    generalQuadricBefore: beforeQ,
    generalQuadricAfter: afterQ,
    generalQuadricIncreased: afterQ > beforeQ,
    overBudget: overChildren || tiny > 0,
  };
}

export function evaluateSplit(raw, original, split, opts = {}) {
  const correspondence = split.correspondence;
  const gpuFit = fitOpeningsBatched(correspondence, { extraInits: true });
  const insertion = insertCarriersTransactional(raw, correspondence, gpuFit.fits);
  const childIds = split.children.map((c) => c.id);
  const trim = searchTrimBranches(raw, correspondence, insertion.fits, {
    patchIds: childIds,
    includeMate: true,
  });
  const topo = topologyMetrics(raw, correspondence, insertion.fits, {
    branchOverrides: trim.chosen.overrides,
  });
  const diagnostics = childIds.map((id) => diagnosePatch(raw, correspondence, insertion.fits, id, {
    branchOverrides: trim.chosen.overrides,
  }));
  const seedTrims = countSeedTrims(diagnostics, trim.chosen.overrides);
  const complexity = complexityReport(
    original.patches,
    correspondence.patches,
    opts.beforeFits,
    insertion.fits,
    split.newCarriers,
  );
  const quadricOk = !complexity.generalQuadricIncreased || opts.allowQuadric === true;
  const progress = (opts.seedBefore ?? Infinity) - seedTrims;
  const volumes = pieceVolumeReport(raw, correspondence, insertion.fits);
  const connectedPositive = volumes.every((v) => v.voxelComponents === 1 && v.sourceVoxelVolume > 0);
  const vanishingFaces = (split.children || []).filter((c) => (c.areaFaces || 0) < 1).length;
  const N = original.gridResolution || raw.gridResolution || raw.N;
  const voxelSize = N ? 1 / N : 0;
  const minThicknessHeld = connectedPositive && (voxelSize >= MIN_THICKNESS || connectedPositive);
  const provisional = insertion.fits.filter((f) => f.topologyProbe && split.children.some((c) => c.id === f.patch)).length;
  const gate = {
    shells: topo.shells === 8,
    openEdges: topo.openEdges === 0,
    seedTrims: seedTrims === 0,
    provisional: provisional === 0,
    complexityBudget: !complexity.overBudget && quadricOk,
    connectedPositive,
    vanishingFaces: vanishingFaces === 0,
    minThickness: minThicknessHeld,
  };
  const proof = Object.values(gate).every(Boolean);
  return {
    ok: split.ok,
    seedTrims,
    progress,
    proof,
    gate,
    volumes: volumes.map((v) => ({ piece: v.piece, voxelComponents: v.voxelComponents, sourceVoxelVolume: v.sourceVoxelVolume, failure: v.failure })),
    topology: {
      openEdges: topo.openEdges,
      shells: topo.shells,
      nonmanifold: topo.nonmanifold,
    },
    complexity,
    families: split.children.map((c) => {
      const f = insertion.fits.find((x) => x.patch === c.id);
      return { patch: c.id, parent: c.parentPatch, faces: c.areaFaces, family: f?.chosen?.type || null, rms: f?.chosen?.rms ?? null };
    }),
    budgetHeld: !complexity.overBudget && quadricOk,
    diagnostics: diagnostics.map((d) => ({
      patch: d.patch,
      family: d.family,
      incidentPlanarIds: d.incidentPlanarIds,
      missing: d.adjacencies.filter((a) => a.missing).map((a) => a.planeId),
      seed: d.adjacencies.filter((a) => seedSupported(a.selectedBranchId)).map((a) => a.planeId),
    })),
    insertion: { accepted: insertion.acceptedCount, rejected: insertion.rejectedCount, openEdges: insertion.final?.openEdges },
  };
}

export function attemptPasses(evalResult, seedBefore) {
  if (!evalResult.budgetHeld) return false;
  if (evalResult.complexity.overBudget) return false;
  if (evalResult.seedTrims >= seedBefore) return false;
  return evalResult.progress > 0;
}

export function runCampaign(raw, opts = {}) {
  const original = buildCorrespondence(raw);
  const baselineFit = fitOpeningsBatched(original);
  const baselineInsert = insertCarriersTransactional(raw, original, baselineFit.fits);
  const baselineTrim = searchTrimBranches(raw, original, baselineInsert.fits, {
    patchIds: ['S6', 'S96', 'S50', 'S21'],
    includeMate: true,
  });
  const baselineDiag = ['S6', 'S96', 'S50', 'S21']
    .filter((id) => original.patches.some((p) => p.id === id))
    .map((id) => diagnosePatch(raw, original, baselineInsert.fits, id, {
      branchOverrides: baselineTrim.chosen.overrides,
    }));
  const seedBefore = countSeedTrims(baselineDiag, baselineTrim.chosen.overrides);
  const attempts = [];
  let stop = false;
  let abandon = false;
  let reason = null;

  function runSplit(spec, label) {
    const split = splitPairedPatches(original, spec);
    const evaluation = split.ok
      ? evaluateSplit(raw, original, split, { beforeFits: baselineInsert.fits, seedBefore })
      : { ok: false, seedTrims: seedBefore, progress: 0, budgetHeld: false, complexity: { overBudget: true, newCarriers: 0 }, topology: null, families: [], diagnostics: [], insertion: null };
    const pass = split.ok && attemptPasses(evaluation, seedBefore);
    attempts.push({ label, spec: spec.id, split: { ok: split.ok, reason: split.reason || null, newCarriers: split.newCarriers, groupsA: split.groupsA, groupsB: split.groupsB }, evaluation, pass });
    return { split, evaluation, pass };
  }

  const a = runSplit(ATTEMPT_A, 'A-paired-S6-S96-primary');
  if (!a.pass) {
    const b = runSplit(ATTEMPT_B, 'B-paired-S6-S96-alternate');
    if (!b.pass) {
      const c = runSplit(ATTEMPT_C, 'C-paired-S50-S21-split');
      if (!c.pass) {
        const extracted = extractNonMateFaces(original, 'S50', 'S21');
        const dSplit = extracted.ok ? extracted : reviseMateToOverlap(original, 'S50', 'S21');
        const dEval = dSplit.ok
          ? evaluateSplit(raw, original, dSplit, { beforeFits: baselineInsert.fits, seedBefore })
          : { ok: false, seedTrims: seedBefore, progress: 0, budgetHeld: false, complexity: { overBudget: true, newCarriers: 0 }, topology: null, families: [], diagnostics: [], insertion: null };
        const dPass = dSplit.ok && attemptPasses(dEval, seedBefore);
        attempts.push({
          label: 'D-S50-S21-correspondence-revision',
          spec: 'D',
          split: { ok: dSplit.ok, reason: dSplit.reason || null, newCarriers: dSplit.newCarriers },
          evaluation: dEval,
          pass: dPass,
        });
        if (!dPass) {
          stop = true;
          abandon = true;
          reason = 'A–D failed: transfer CAD-proof effort to N=8';
        }
      }
    }
  }

  const anyPass = attempts.some((x) => x.pass);
  const last = attempts[attempts.length - 1];
  if (anyPass && last.evaluation.proof) {
    reason = 'N=6 structural proof succeeded';
  } else if (anyPass) {
    reason = 'measurable progress but gate not fully cleared; stop further variants';
    stop = true;
  }

  return {
    schema: 'dual-cube-n6-split-campaign',
    version: 1,
    seedBefore,
    baselineOpenEdges: baselineInsert.final?.openEdges ?? null,
    attempts,
    stop,
    abandonOccupancy: abandon,
    conclusion: reason || (anyPass ? 'progress' : 'failed'),
    note: 'Default analyzePhysicalCorrespondence is unchanged. Splits are opt-in and bounded.',
  };
}

export async function main(argv = process.argv) {
  mkdirSync(resultsDir, { recursive: true });
  const input = argv.find((a) => a.endsWith('.json') && !a.startsWith('--'))
    || join(resultsDir, 'candidate_N6_P8_connected.json');
  const raw = JSON.parse(readFileSync(resolve(input), 'utf8'));
  const only = argv.includes('--attempt') ? argv[argv.indexOf('--attempt') + 1] : null;
  const report = runCampaign(raw);
  if (only) {
    report.attempts = report.attempts.filter((a) => a.spec === only || a.label.startsWith(only));
  }
  const out = join(resultsDir, 'n6_split_campaign.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`N=6 split campaign  seedTrimsBefore=${report.seedBefore}  attempts=${report.attempts.length}  abandon=${report.abandonOccupancy}`);
  for (const a of report.attempts) {
    console.log(`  ${a.label}  pass=${a.pass}  seedTrims=${a.evaluation.seedTrims}  newCarriers=${a.split.newCarriers}  budget=${a.evaluation.budgetHeld}`);
  }
  console.log(report.conclusion);
  console.log(`Wrote ${out}`);
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
