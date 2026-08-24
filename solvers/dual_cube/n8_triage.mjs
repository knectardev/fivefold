/**
 * Bounded structural triage of N=8 correspondence contradictions.
 * No insert, opt, or closure. Decides whether this occupancy may enter CAD.
 *
 *   node solvers/dual_cube/n8_triage.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCorrespondence } from './physical_correspondence.mjs';
import { selectJointSurface } from './joint_quadrics.mjs';
import { n8Preflight } from './n8_preflight.mjs';

export const N8_COMPLEXITY_BUDGET = {
  maxChildrenPerCarrier: 3,
  maxNewCarriers: 8,
  minChildFaces: 3,
  maxNewGeneralQuadrics: 2,
};

const MIN = N8_COMPLEXITY_BUDGET.minChildFaces;

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, 'results');

function facesTouch(a, b) {
  const sa = new Set(a.edges || []);
  return (b.edges || []).some((e) => sa.has(e));
}

function sharedEdgeCount(a, b) {
  const sa = new Set();
  for (const f of a.faces || []) for (const e of f.edges || []) sa.add(e);
  let n = 0;
  for (const f of b.faces || []) for (const e of f.edges || []) if (sa.has(e)) n++;
  return n;
}

function familyOf(points) {
  if (!points?.length) return { type: null, rms: Infinity, tried: [] };
  const sel = selectJointSurface(points);
  return {
    type: sel.chosen?.type || null,
    rms: sel.chosen?.rms ?? sel.planeRMS,
    planeRMS: sel.planeRMS,
    tried: sel.tried,
  };
}

function keyIndex(patches) {
  const m = new Map();
  for (const q of patches) {
    for (const k of q.faceKeys || []) m.set(k, q.id);
  }
  return m;
}

export function oppositeBuckets(patch, patches) {
  const index = keyIndex(patches);
  const byId = new Map(patches.map((p) => [p.id, p]));
  const groups = new Map();
  const unmatched = [];
  (patch.oppositeKeys || []).forEach((k, i) => {
    const id = index.get(k);
    if (!id || id === patch.id) {
      unmatched.push(i);
      return;
    }
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(i);
  });
  const buckets = [...groups.entries()].map(([id, idxs]) => {
    const q = byId.get(id);
    return {
      id,
      faceCount: idxs.length,
      indices: idxs,
      piece: q?.piece ?? null,
      kind: q?.kind ?? null,
      cubeA: q?.cubeA?.mate ?? null,
      cubeB: q?.cubeB?.mate ?? null,
    };
  }).sort((a, b) => b.faceCount - a.faceCount);
  return { buckets, unmatched };
}

function connectedIndexGroups(patch, indices) {
  const set = new Set(indices);
  const idx = [...set];
  const n = idx.length;
  const adj = Array.from({ length: n }, () => []);
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      if (facesTouch(patch.faces[idx[a]], patch.faces[idx[b]])) {
        adj[a].push(b);
        adj[b].push(a);
      }
    }
  }
  const seen = new Uint8Array(n);
  const comps = [];
  for (let i = 0; i < n; i++) {
    if (seen[i]) continue;
    const q = [i];
    seen[i] = 1;
    const comp = [];
    for (let h = 0; h < q.length; h++) {
      const u = q[h];
      comp.push(idx[u]);
      for (const v of adj[u]) {
        if (seen[v]) continue;
        seen[v] = 1;
        q.push(v);
      }
    }
    comps.push(comp);
  }
  return comps;
}

function adjacentPlanes(patch, patches) {
  return patches.filter((q) => (
    q.piece === patch.piece
    && q.id !== patch.id
    && q.kind !== 'curved'
    && sharedEdgeCount(patch, q) > 0
  )).map((q) => ({
    id: q.id,
    kind: q.kind,
    areaFaces: q.areaFaces,
    sharedEdges: sharedEdgeCount(patch, q),
    cubeA: q.cubeA?.mate ?? null,
    cubeB: q.cubeB?.mate ?? null,
  }));
}

function samplesOf(patch, indices) {
  return indices.map((i) => patch.samplesA[i]).filter(Boolean);
}

function mergeTinyBuckets(buckets, min = MIN) {
  const large = buckets.filter((b) => b.faceCount >= min).map((b) => ({ ...b, indices: [...b.indices] }));
  const tiny = buckets.filter((b) => b.faceCount < min);
  const leftoverIdx = tiny.flatMap((b) => b.indices);
  return { large, tiny, leftoverIdx, leftoverFaces: leftoverIdx.length };
}

function classifyRepair(patch, patches, reason) {
  const fam = familyOf([...(patch.samplesA || []), ...(patch.samplesJoint || [])]);
  const { buckets, unmatched } = oppositeBuckets(patch, patches);
  const planes = adjacentPlanes(patch, patches);
  const { large, tiny, leftoverIdx, leftoverFaces } = mergeTinyBuckets(buckets);
  const leftoverComps = leftoverIdx.length ? connectedIndexGroups(patch, leftoverIdx) : [];
  const leftoverMin = leftoverComps.length ? Math.min(...leftoverComps.map((c) => c.length)) : leftoverFaces;
  const largeKinds = new Set(large.map((b) => b.kind));
  const childEstimates = large.map((b) => {
    const famC = familyOf(samplesOf(patch, b.indices));
    return {
      matePatch: b.id,
      faces: b.faceCount,
      kind: b.kind,
      family: famC.type,
      rms: famC.rms,
    };
  });
  if (leftoverFaces >= MIN && leftoverComps.length === 1 && leftoverComps[0].length >= MIN) {
    const famL = familyOf(samplesOf(patch, leftoverComps[0]));
    childEstimates.push({
      matePatch: tiny.map((t) => t.id).join('+'),
      faces: leftoverComps[0].length,
      kind: 'leftover',
      family: famL.type,
      rms: famL.rms,
    });
  }

  const extraChildren = Math.max(0, childEstimates.length - 1);
  const minChildFaces = childEstimates.length ? Math.min(...childEstimates.map((c) => c.faces)) : patch.areaFaces;
  const newGeneral = childEstimates.filter((c) => c.family === 'generalQuadric').length
    + ((fam.type === 'generalQuadric' || !fam.type) && extraChildren === 0 ? 1 : 0);
  const mirrored = large.some((b) => b.kind === 'curved');
  const incompatiblePlanes = planes.filter((pl) => pl.kind === 'planar-mate').map((pl) => pl.id);
  const preserves = large.every((b) => b.kind === 'curved' || b.kind === 'planar-mate')
    && leftoverComps.every((c) => c.length >= MIN || c.length === 0);

  let category = 'A';
  let additionalCarriers = 0;
  let additionalType = 'none';
  let localSplit = false;
  let notes = '';

  const onlyTinies = large.length <= 1 && leftoverFaces > 0 && leftoverComps.every((c) => c.length < MIN);
  const twoWay = childEstimates.length === 2 && minChildFaces >= MIN;
  const threeWay = childEstimates.length === 3 && minChildFaces >= MIN;
  const tooMany = childEstimates.length > N8_COMPLEXITY_BUDGET.maxChildrenPerCarrier
    || large.length > N8_COMPLEXITY_BUDGET.maxChildrenPerCarrier;
  const fragmentedLeftover = leftoverComps.some((c) => c.length < MIN) && leftoverFaces >= MIN && leftoverComps.length > 1;
  const needsGQ = (!fam.type || fam.type === 'generalQuadric') && extraChildren >= 2;

  if (reason === 'incomplete-opposite-map' && onlyTinies) {
    category = 'C';
    additionalCarriers = 0;
    additionalType = 'drop-tiny-opposite-faces';
    notes = 'Drop leftover opposite faces from the mate claim; keep the majority partner.';
  } else if (large.length <= 1 && leftoverFaces === 0 && unmatched.length === 0) {
    category = 'A';
    notes = 'Unique partner already; contradiction is a labeling artifact.';
  } else if (largeKinds.size === 1 && [...largeKinds][0] !== 'curved' && extraChildren <= 1 && !tooMany) {
    category = large.length <= 1 ? 'C' : 'C';
    additionalCarriers = 0;
    additionalType = 'correspondence-revision';
    notes = 'Opposite side is planar. Revise mate assignment rather than adding curved carriers.';
  } else if (onlyTinies) {
    category = 'C';
    additionalCarriers = 0;
    additionalType = 'drop-tiny-opposite-faces';
    notes = 'Majority partner exists; leftover islands are below the face floor.';
  } else if (tooMany || fragmentedLeftover || (threeWay && needsGQ)) {
    category = 'D';
    additionalCarriers = extraChildren;
    additionalType = extraChildren ? 'multi-child-split' : 'general-quadric';
    localSplit = extraChildren > 0;
    notes = tooMany
      ? `Would require ${Math.max(large.length, childEstimates.length)} children (cap ${N8_COMPLEXITY_BUDGET.maxChildrenPerCarrier}).`
      : fragmentedLeftover
        ? 'Leftover faces split into sub-minimum islands.'
        : 'Three-way split still needs general quadrics.';
  } else if (twoWay || threeWay) {
    category = 'B';
    additionalCarriers = extraChildren;
    additionalType = extraChildren === 1 ? 'paired-split' : 'paired-split-3';
    localSplit = true;
    notes = `Local paired split into ${childEstimates.length} children (min ${minChildFaces} faces).`;
  } else {
    category = 'C';
    additionalCarriers = 0;
    additionalType = 'correspondence-revision';
    notes = 'Revise partner map without a new curved family.';
  }

  if (minChildFaces < MIN && category === 'B') {
    category = 'D';
    notes = 'Split would create a child below the face floor.';
  }

  return {
    category,
    localSplit,
    additionalCarriers,
    additionalType,
    minChildFaces: Number.isFinite(minChildFaces) ? minChildFaces : patch.areaFaces,
    newGeneralQuadrics: childEstimates.filter((c) => c.family === 'generalQuadric').length,
    preservesCorrespondenceTopology: category !== 'D' && (preserves || category === 'C' || category === 'A'),
    mirroredAcrossMate: mirrored,
    family: fam.type,
    familyRms: fam.rms,
    planeRMS: fam.planeRMS,
    oppositeBuckets: buckets.map((b) => ({
      id: b.id,
      piece: b.piece,
      kind: b.kind,
      faces: b.faceCount,
      cubeA: b.cubeA,
      cubeB: b.cubeB,
    })),
    leftoverFaces,
    leftoverComponents: leftoverComps.map((c) => c.length),
    unmatchedFaces: unmatched.length,
    childEstimates,
    adjacentPlanes: planes,
    incompatiblePlaneContacts: incompatiblePlanes,
    notes,
  };
}

export function classifyNeighborhood(row, patches) {
  const patch = patches.find((p) => p.id === row.patch);
  if (!patch) {
    return {
      patch: row.patch,
      category: 'D',
      notes: 'patch missing from correspondence',
    };
  }
  const repair = classifyRepair(patch, patches, row.reason);
  const mateIds = repair.oppositeBuckets.map((b) => b.id);
  return {
    patch: patch.id,
    piece: patch.piece,
    areaFaces: patch.areaFaces,
    reason: row.reason,
    cubeA: {
      mate: patch.cubeA?.mate ?? null,
      matePatch: patch.cubeA?.matePatch ?? null,
      mateOverlap: patch.cubeA?.mateOverlap ?? null,
      unique: patch.cubeA?.unique ?? null,
    },
    cubeB: {
      mate: patch.cubeB?.mate ?? null,
      matePatch: patch.cubeB?.matePatch ?? null,
      unique: patch.cubeB?.unique ?? null,
      distinctPartners: patch.cubeB?.distinctPartners ?? null,
    },
    patchesInvolved: [patch.id, ...mateIds],
    ...repair,
  };
}

function cluster(rows) {
  const parent = new Map(rows.map((r) => [r.patch, r.patch]));
  const find = (x) => (parent.get(x) === x ? x : parent.set(x, find(parent.get(x))).get(x));
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  };
  for (const r of rows) {
    for (const id of r.patchesInvolved || []) {
      if (rows.some((x) => x.patch === id)) union(r.patch, id);
    }
  }
  const groups = new Map();
  for (const r of rows) {
    const k = find(r.patch);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r.patch);
  }
  return [...groups.values()];
}

export function analyticDifficultyFromCorrespondence(correspondence, neighborhoods) {
  const patches = correspondence.patches || [];
  const curved = patches.filter((p) => p.kind === 'curved');
  const tiny = patches.filter((p) => p.areaFaces > 0 && p.areaFaces < MIN);
  const splits = correspondence.counts?.partnerSignatureSplits ?? 0;
  const classified = (neighborhoods || []).map((n) => n.category ? n : classifyNeighborhood(n, patches));
  const expectedSplits = classified.reduce((s, n) => s + (n.additionalCarriers || 0), 0);
  const gq = classified.reduce((s, n) => s + (n.newGeneralQuadrics || 0), 0)
    + curved.filter((p) => !classified.some((n) => n.patch === p.id)).length * 0;
  const dCount = classified.filter((n) => n.category === 'D').length;
  const score = dCount * 400
    + classified.length * 80
    + expectedSplits * 35
    + gq * 60
    + tiny.length * 12
    + splits * 8
    + curved.length * 2;
  return {
    score,
    signals: {
      contradictoryNeighborhoods: classified.length,
      expectedCarrierSplits: expectedSplits,
      curvedPatches: curved.length,
      tinyBoundaryRegions: tiny.length,
      partnerSignatureSplits: splits,
      estimatedGeneralQuadrics: gq,
      categoryD: dCount,
    },
  };
}

export function analyticDifficultyOfCandidate(candidate, N, P) {
  const raw = {
    gridResolution: candidate.gridResolution ?? candidate.N ?? N,
    N: candidate.N ?? N,
    pieceCount: candidate.pieceCount ?? P,
    labelsA: candidate.labelsA,
    labelsB: candidate.labelsB,
    placements: candidate.placements,
    destOf: candidate.destOf,
    counts: candidate.counts,
  };
  if (!raw.labelsA || !raw.placements) return { score: 0, signals: null };
  const correspondence = buildCorrespondence(raw);
  const pre = n8Preflight(raw);
  const classified = pre.contradictoryNeighborhoods.map((row) => classifyNeighborhood(row, correspondence.patches));
  return analyticDifficultyFromCorrespondence(correspondence, classified);
}

export function decideGoNoGo(neighborhoods, budget = N8_COMPLEXITY_BUDGET) {
  const extraCarriers = neighborhoods.reduce((s, n) => s + (n.additionalCarriers || 0), 0);
  const extraGQ = neighborhoods.reduce((s, n) => s + (n.newGeneralQuadrics || 0), 0);
  const minChild = Math.min(...neighborhoods.map((n) => n.minChildFaces ?? Infinity));
  const cats = { A: 0, B: 0, C: 0, D: 0 };
  for (const n of neighborhoods) cats[n.category] = (cats[n.category] || 0) + 1;
  const allAC = cats.D === 0;
  const pairedOk = neighborhoods.filter((n) => n.localSplit).every((n) => n.mirroredAcrossMate || n.category === 'C');
  const tinyOk = !Number.isFinite(minChild) || minChild >= budget.minChildFaces || cats.B + cats.D === 0;
  const go = allAC
    && extraCarriers <= budget.maxNewCarriers
    && extraGQ <= budget.maxNewGeneralQuadrics
    && tinyOk
    && (pairedOk || cats.B === 0);
  let reason;
  if (!allAC) reason = `${cats.D} neighborhood(s) in category D`;
  else if (extraCarriers > budget.maxNewCarriers) reason = `projected +${extraCarriers} carriers exceeds ${budget.maxNewCarriers}`;
  else if (extraGQ > budget.maxNewGeneralQuadrics) reason = `projected +${extraGQ} general quadrics exceeds ${budget.maxNewGeneralQuadrics}`;
  else if (!tinyOk) reason = 'a repair would create a sub-minimum face';
  else if (!pairedOk) reason = 'a split is not mirrored across the mating pair';
  else reason = 'all 13 contradictions are A–C inside the complexity budget';
  return {
    go,
    proceedToReconstruction: go,
    categories: cats,
    extraCarriers,
    extraGeneralQuadrics: extraGQ,
    minChildFaces: Number.isFinite(minChild) ? minChild : null,
    reason,
    budget,
  };
}

export function triageN8(raw) {
  const correspondence = buildCorrespondence(raw);
  const pre = n8Preflight(raw);
  const neighborhoods = pre.contradictoryNeighborhoods.map((row) => classifyNeighborhood(row, correspondence.patches));
  const clusters = cluster(neighborhoods);
  const decision = decideGoNoGo(neighborhoods);
  const difficulty = analyticDifficultyFromCorrespondence(correspondence, neighborhoods);
  return {
    schema: 'dual-cube-n8-contradiction-triage',
    version: 1,
    gridResolution: correspondence.gridResolution ?? raw.gridResolution ?? raw.N,
    cadEligible: raw.cadEligible ?? null,
    budget: N8_COMPLEXITY_BUDGET,
    counts: pre.counts,
    neighborhoods,
    clusters,
    decision,
    difficulty,
    reconstruction: decision.go
      ? {
        allowed: true,
        stages: [
          'correspondence',
          'carrier-consolidation',
          'local-contradiction-repairs',
          'batched-surface-fitting',
          'transactional-insertion',
          'trim-and-shell-closure',
          'global-residual-optimization',
          'rhino-ready-validation',
        ],
      }
      : {
        allowed: false,
        stages: ['correspondence', 'contradiction-triage'],
        hold: 'Do not enter insert/opt/closure. Search should rank by analyticDifficulty.',
      },
  };
}

export function main(argv = process.argv) {
  mkdirSync(resultsDir, { recursive: true });
  const input = argv.find((a) => a.endsWith('.json') && !a.startsWith('--'))
    || join(resultsDir, 'candidate_N8_P8_connected.json');
  const raw = JSON.parse(readFileSync(resolve(input), 'utf8'));
  const report = triageN8(raw);
  const out = join(resultsDir, 'n8_triage.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  const preOut = join(resultsDir, 'n8_preflight.json');
  try {
    const pre = JSON.parse(readFileSync(preOut, 'utf8'));
    pre.fullReconstruction = report.decision.go ? 'allowed-staged' : 'held-after-triage';
    pre.triageDecision = report.decision;
    writeFileSync(preOut, JSON.stringify(pre, null, 2));
  } catch {
    /* preflight file optional */
  }
  console.log(`N=8 contradiction triage  n=${report.neighborhoods.length}  A=${report.decision.categories.A} B=${report.decision.categories.B} C=${report.decision.categories.C} D=${report.decision.categories.D}`);
  console.log(`go=${report.decision.go}  extraCarriers=${report.decision.extraCarriers}  extraGQ=${report.decision.extraGeneralQuadrics}  ${report.decision.reason}`);
  console.log(`Wrote ${out}`);
  return report;
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  main();
}
