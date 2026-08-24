/**
 * Inspectable trim-branch enumeration and a small beam search for S6/S96.
 * Surface parameters stay frozen. Overrides are keyed by deterministic branch IDs.
 */
import {
  adjacencyKey,
  makeBranchId,
  enumerateIntersectionBranches,
  surfaceOfPatch,
  topologyMetrics,
  attributeOpenEdges,
  buildClosureReport,
} from './analytic_junctions.mjs';
import { consolidateCarriers } from './carrier_surfaces.mjs';
import { parseCandidate } from './json_contract.mjs';
import { sub, norm } from './plane_only.mjs';

export { adjacencyKey, makeBranchId, enumerateIntersectionBranches };

export const TARGET_PATCHES = ['S6', 'S96'];
const BEAM_WIDTH = 4;
const KEEP_PER_ADJ = 3;
const ENDPOINT_TOL = 0.08;

function latticeUnit(p, N) {
  return [p[0] / N, p[1] / N, p[2] / N];
}

function latticeCorners(patch) {
  const set = new Set();
  for (const f of patch.faces || []) {
    for (const c of f.corners || []) set.add(c.join(','));
  }
  return set;
}

function sharedEdgeKeys(a, b) {
  const sa = new Set();
  for (const f of a.faces || []) for (const e of f.edges || []) sa.add(e);
  const out = [];
  for (const f of b.faces || []) {
    for (const e of f.edges || []) if (sa.has(e)) out.push(e);
  }
  return [...new Set(out)];
}

function edgePoints(edge, N) {
  const [a, b] = edge.split('|');
  return [a.split(',').map(Number), b.split(',').map(Number)].map((p) => latticeUnit(p, N));
}

function expectedEndpoints(pa, pb, N) {
  const ca = latticeCorners(pa);
  const shared = [];
  for (const key of latticeCorners(pb)) {
    if (ca.has(key)) shared.push(latticeUnit(key.split(',').map(Number), N));
  }
  return shared;
}

export function matchedEndpoints(pa, pb, hit, N) {
  const expected = expectedEndpoints(pa, pb, N);
  const actual = [hit?.a, hit?.b].filter(Boolean);
  let matched = 0;
  for (const e of actual) {
    if (expected.some((s) => norm(sub(s, e)) <= ENDPOINT_TOL)) matched++;
  }
  return { expected, actual, matched, expectedCount: expected.length };
}

function pairSurfaces(pa, pb, fitById, regionToCarrier, carrierSurf) {
  const surfOf = (p) => {
    const cid = regionToCarrier?.get(p.id);
    if (cid && carrierSurf?.get(cid)) return carrierSurf.get(cid);
    return surfaceOfPatch(p, fitById.get(p.id));
  };
  return [surfOf(pa), surfOf(pb)];
}

function curvedPlane(pa, pb) {
  if (pa.kind === 'curved' && pb.kind !== 'curved') return { curved: pa, plane: pb };
  if (pb.kind === 'curved' && pa.kind !== 'curved') return { curved: pb, plane: pa };
  return { curved: pa.id < pb.id ? pa : pb, plane: pa.id < pb.id ? pb : pa };
}

export function carrierStatuses(fits, state) {
  const patchById = new Map(state.patches.map((p) => [p.id, p]));
  const unmatchedOf = (patch) => state.unmatched.filter((row) => {
    const [a, b] = row.key.split('|');
    if (a !== patch && b !== patch) return false;
    const other = a === patch ? patchById.get(b) : patchById.get(a);
    return other && other.kind !== 'curved';
  });
  return fits.filter((f) => f.chosen).map((f) => {
    const leftover = unmatchedOf(f.patch);
    const probe = f.topologyProbe === true || f.acceptedGeometry === false;
    return {
      patch: f.patch,
      piece: f.piece,
      type: f.chosen.type,
      acceptedGeometry: !probe,
      topologyProbe: probe,
      residualGate: f.residualGate || (probe ? 'mateB' : 'pass'),
      trimComplete: leftover.length === 0,
      unmatchedCount: leftover.length,
    };
  });
}

function snap(m) {
  return {
    openEdges: m.openEdges,
    nonmanifold: m.nonmanifold,
    duplicateEdges: m.duplicateEdges,
    shells: m.shells,
    unresolved: m.unresolved,
    fitted: m.fitted,
  };
}

export function diagnosePatch(raw, correspondence, fits, patchId, opts = {}) {
  const cand = parseCandidate(raw);
  const N = cand.gridResolution;
  const fitById = new Map(fits.map((f) => [f.patch, f]));
  const carriers = consolidateCarriers(correspondence, fits);
  const carrierSurf = new Map(carriers._surfaces.map((c) => [c.id, c.surface]));
  const regionToCarrier = carriers._regionToCarrier;
  const patch = correspondence.patches.find((p) => p.id === patchId);
  const fit = fitById.get(patchId);
  const neighbors = correspondence.patches.filter((p) => {
    if (p.piece !== patch.piece || p.id === patchId) return false;
    return sharedEdgeKeys(patch, p).length > 0 && p.kind !== 'curved';
  });
  const state = topologyMetrics(raw, correspondence, fits, opts);
  const attr = attributeOpenEdges(state);
  const adjacencies = neighbors.map((plane) => {
    const keys = sharedEdgeKeys(patch, plane);
    const seedPts = keys.flatMap((e) => edgePoints(e, N));
    const [sa, sb] = pairSurfaces(patch, plane, fitById, regionToCarrier, carrierSurf);
    const branches = enumerateIntersectionBranches(sa, sb, seedPts).map((b) => ({
      ...b,
      id: makeBranchId(patch.id, plane.id, b),
    }));
    const adj = adjacencyKey(patch.id, plane.id);
    const trim = state.trims.find((t) => adjacencyKey(t.a, t.b) === adj);
    const missing = state.unmatched.some((row) => row.key === adj);
    const selected = branches.find((b) => b.id === (opts.branchOverrides || {})[adj])
      || branches.find((b) => b.accept && b.orientation === 'forward' && b.clip === 'seed_clip' && b.component === 'generator_0')
      || null;
    const rejected = [];
    if (missing) {
      if (!trim?.intersection) {
        const noGeom = branches.filter((b) => b.reason === 'no-geometric-intersection');
        const clipFail = branches.filter((b) => b.reason === 'trim-interval-clip-removed-segment' || b.clip === 'aabb_clip');
        rejected.push({
          adjacency: adj,
          reason: noGeom.length && !branches.some((b) => b.accept)
            ? 'no-geometric-intersection'
            : clipFail.length
              ? 'trim-interval-clip-or-wrong-generator'
              : 'legacy-selector-missed-branch',
        });
      } else if (trim.intersection.kind === 'open-unfitted') {
        rejected.push({ adjacency: adj, reason: 'open-unfitted' });
      } else {
        rejected.push({ adjacency: adj, reason: 'missing-adjacency-registration' });
      }
    }
    return {
      planeId: plane.id,
      planeKind: plane.kind,
      sharedVoxelEdges: keys.length,
      missing,
      selectedBranchId: selected?.id || trim?.chosenBranchId || null,
      selected: selected && {
        id: selected.id,
        component: selected.component,
        orientation: selected.orientation,
        clip: selected.clip,
        voxelScore: selected.voxelScore,
        endpoints: matchedEndpoints(patch, plane, selected.hit, N),
      },
      legacyHit: trim?.intersection ? {
        kind: trim.intersection.kind,
        a: trim.intersection.a,
        b: trim.intersection.b,
        form: trim.intersection.form,
      } : null,
      branches: branches.map((b) => ({
        id: b.id,
        component: b.component,
        orientation: b.orientation,
        clip: b.clip,
        accept: b.accept,
        reason: b.reason,
        voxelScore: b.voxelScore,
        form: b.form,
        endpoints: matchedEndpoints(patch, plane, b.hit, N),
      })),
      rejected,
    };
  });
  return {
    patch: patchId,
    piece: patch.piece,
    family: fit?.chosen?.type || null,
    carrier: regionToCarrier.get(patchId) || null,
    parameters: fit?.chosen ? {
      type: fit.chosen.type,
      rms: fit.chosen.rms,
      radius: fit.chosen.radius,
      axis: fit.chosen.axis,
      point: fit.chosen.point,
    } : null,
    incidentPlanarIds: neighbors.map((p) => p.id),
    fittedUntrimmed: (attr.byFittedUntrimmed || {})[patchId] || 0,
    adjacencies,
  };
}

function rankTrial(baseline, trial, extra) {
  const dOpen = trial.openEdges - baseline.openEdges;
  const dNm = trial.nonmanifold - baseline.nonmanifold;
  const dShells = trial.shells - baseline.shells;
  const dDup = trial.duplicateEdges - baseline.duplicateEdges;
  return {
    ...extra,
    before: snap(baseline),
    after: snap(trial),
    delta: { openEdges: dOpen, nonmanifold: dNm, shells: dShells, duplicateEdges: dDup },
    matchedEndpoints: extra.matchedEndpoints ?? 0,
    voxelScore: extra.voxelScore ?? Infinity,
    score: dNm * 1000 + dDup * 200 + dOpen * 10 + (extra.voxelScore ?? 0),
  };
}

function scoreOverride(raw, correspondence, fits, baseline, overrides, extra) {
  const trial = topologyMetrics(raw, correspondence, fits, { branchOverrides: overrides });
  return { ...rankTrial(baseline, trial, extra), overrides: { ...overrides } };
}

export function searchTrimBranches(raw, correspondence, fits, opts = {}) {
  const patchIds = opts.patchIds || TARGET_PATCHES;
  const startOverrides = { ...(opts.startOverrides || {}) };
  const orientations = opts.orientations || ['forward'];
  const allowFallback = opts.allowFallbackBranches === true;
  const N = parseCandidate(raw).gridResolution;
  const baseline = topologyMetrics(raw, correspondence, fits, { branchOverrides: startOverrides });
  const attr = attributeOpenEdges(baseline);
  const patchById = new Map(correspondence.patches.map((p) => [p.id, p]));
  const missing = (attr.fittedUntrimmed || []).filter((row) => row.fitted.some((id) => patchIds.includes(id)));
  const diagnostics = patchIds.map((id) => diagnosePatch(raw, correspondence, fits, id, {
    branchOverrides: startOverrides,
  }));

  const byPatch = new Map(patchIds.map((id) => [id, []]));
  for (const row of missing) {
    const curvedId = row.fitted.find((id) => patchIds.includes(id));
    const planeId = row.a === curvedId ? row.b : row.b === curvedId ? row.a : row.openings[0];
    const pa = patchById.get(row.a);
    const pb = patchById.get(row.b);
    const { curved, plane } = curvedPlane(pa, pb);
    const adj = row.key;
    const diag = diagnostics.find((d) => d.patch === curved.id);
    const adjDiag = diag?.adjacencies.find((a) => a.planeId === plane.id);
    const geom = new Set(['generator_0', 'generator_1', 'covering_arc', 'complementary_arc']);
    const candidates = (adjDiag?.branches || []).filter((b) => {
      if (!b.accept || !orientations.includes(b.orientation)) return false;
      const hasGeom = (adjDiag.branches || []).some((x) => (
        x.accept && geom.has(x.component) && orientations.includes(x.orientation)
      ));
      if (!allowFallback && hasGeom && (b.component === 'numerical' || b.component === 'seed_polyline')) {
        return false;
      }
      return true;
    });
    const scored = [];
    for (const b of candidates) {
      scored.push(scoreOverride(raw, correspondence, fits, baseline, { ...startOverrides, [adj]: b.id }, {
        adjacency: adj,
        branchId: b.id,
        patch: curved.id,
        planeId: plane.id,
        matchedEndpoints: b.endpoints.matched,
        voxelScore: b.voxelScore,
      }));
    }
    scored.sort((a, b) => a.score - b.score);
    const kept = scored.filter((s) => s.delta.nonmanifold <= 0).slice(0, KEEP_PER_ADJ);
    if (!byPatch.has(curved.id)) byPatch.set(curved.id, []);
    byPatch.get(curved.id).push({
      adjacency: adj,
      planeId: plane.id,
      independent: kept.map((s) => ({
        branchId: s.branchId,
        delta: s.delta,
        matchedEndpoints: s.matchedEndpoints,
        voxelScore: s.voxelScore,
        score: s.score,
      })),
    });
  }

  function beamFor(patchId, accOverrides) {
    const groups = byPatch.get(patchId) || [];
    let beam = [{ overrides: { ...accOverrides }, score: 0, delta: { openEdges: 0, nonmanifold: 0, shells: 0 } }];
    for (const group of groups) {
      const next = [];
      for (const node of beam) {
        const cands = group.independent.length ? group.independent : [{ branchId: null }];
        for (const cand of cands) {
          const overrides = { ...node.overrides };
          if (cand.branchId) overrides[group.adjacency] = cand.branchId;
          next.push(scoreOverride(raw, correspondence, fits, baseline, overrides, {
            adjacency: group.adjacency,
            branchId: cand.branchId,
            matchedEndpoints: cand.matchedEndpoints,
            voxelScore: cand.voxelScore,
          }));
        }
      }
      next.sort((a, b) => a.score - b.score);
      beam = next.filter((s) => s.delta.nonmanifold <= 0).slice(0, BEAM_WIDTH);
      if (!beam.length) beam = next.slice(0, 1);
    }
    return beam[0] || { overrides: { ...accOverrides }, score: 0 };
  }

  let acc = { ...startOverrides };
  const beams = {};
  for (const patchId of patchIds) {
    const hit = beamFor(patchId, acc);
    acc = hit.overrides || acc;
    beams[patchId] = { score: hit.score, overrides: hit.overrides };
  }
  const joint = scoreOverride(raw, correspondence, fits, baseline, acc, {
    branchId: 'joint',
    matchedEndpoints: 0,
    voxelScore: 0,
  });

  let cubeAB = null;
  if (opts.includeMate !== false) {
    const closure = buildClosureReport(raw, correspondence, fits, null, { branchOverrides: joint.overrides });
    cubeAB = {
      rms: closure.metrics?.continuousTrimMismatch?.rms ?? null,
      max: closure.metrics?.continuousTrimMismatch?.max ?? null,
    };
  }

  const repaired = topologyMetrics(raw, correspondence, fits, { branchOverrides: joint.overrides });
  const repairedAttr = attributeOpenEdges(repaired);
  const statuses = carrierStatuses(fits, repaired);

  return {
    schema: 'dual-cube-trim-branch-search',
    version: 1,
    note: 'Discrete topology search over frozen carriers. Surface parameters are not optimized.',
    baseline: snap(baseline),
    chosen: {
      overrides: joint.overrides,
      metrics: snap(repaired),
      delta: joint.delta,
      cubeB: cubeAB,
    },
    diagnostics,
    independent: Object.fromEntries([...byPatch.entries()].map(([k, v]) => [k, v])),
    beam: beams,
    openEdges: repairedAttr,
    carrierStatus: statuses,
    N,
  };
}

export function applyTrimOverrides(raw, correspondence, fits, overrides) {
  const state = topologyMetrics(raw, correspondence, fits, { branchOverrides: overrides });
  return {
    state,
    openEdges: attributeOpenEdges(state),
    carrierStatus: carrierStatuses(fits, state),
  };
}
