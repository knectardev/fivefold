/**
 * Transactional CPU insertion of batched analytic carriers.
 * Each accepted surface is kept only if topology does not get worse:
 * nonmanifold edges, unmatched/open edges, and duplicate trims must not increase.
 * Remaining unmatched edges are attributed to unresolved openings.
 */
import { topologyMetrics, attributeOpenEdges } from './analytic_junctions.mjs';
import { carrierStatuses, searchTrimBranches } from './trim_branches.mjs';
import { fitOpeningsBatched, proposeUnresolvedFits } from './gpu_fit_cpu.mjs';

const FAMILY_RANK = { sphere: 0, cylinder: 1, cone: 2, generalQuadric: 3 };

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

function decide(prev, next) {
  if (next.nonmanifold > prev.nonmanifold) {
    return { accept: false, reason: 'nonmanifold-increased' };
  }
  if (next.duplicateEdges > prev.duplicateEdges) {
    return { accept: false, reason: 'duplicate-trims' };
  }
  if (next.openEdges > prev.openEdges) {
    return { accept: false, reason: 'open-edges-increased' };
  }
  return { accept: true, reason: next.openEdges < prev.openEdges ? 'open-edges-decreased' : 'topology-held' };
}

export function insertCarriersTransactional(raw, correspondence, proposedFits) {
  const proposed = proposedFits.map((f) => ({ ...f, chosen: f.chosen || null }));
  const candidates = proposed
    .filter((f) => f.chosen)
    .sort((a, b) => {
      const ra = FAMILY_RANK[a.chosen.type] ?? 9;
      const rb = FAMILY_RANK[b.chosen.type] ?? 9;
      if (ra !== rb) return ra - rb;
      return (a.chosen.score ?? a.chosen.rms ?? 1) - (b.chosen.score ?? b.chosen.rms ?? 1);
    });

  let currentFits = proposed.map((f) => ({ ...f, chosen: null }));
  let current = topologyMetrics(raw, correspondence, currentFits);
  const baseline = snap(current);
  const log = [];
  const accepted = [];
  const rejected = [];

  for (const cand of candidates) {
    const trialFits = currentFits.map((f) => (f.patch === cand.patch ? cand : f));
    const trial = topologyMetrics(raw, correspondence, trialFits);
    const verdict = decide(snap(current), snap(trial));
    const entry = {
      patch: cand.patch,
      piece: cand.piece,
      type: cand.chosen.type,
      rms: cand.chosen.rms,
      accept: verdict.accept,
      reason: verdict.reason,
      before: snap(current),
      after: snap(trial),
    };
    log.push(entry);
    if (verdict.accept) {
      currentFits = trialFits;
      current = trial;
      accepted.push(cand.patch);
    } else {
      rejected.push(entry);
    }
  }

  const attribution = attributeOpenEdges(current);
  const carrierStatus = carrierStatuses(currentFits, current);
  return {
    schema: 'dual-cube-carrier-insertion',
    version: 1,
    note: 'CPU owns insertion, branch selection, and shell validation. Global GPU optimization is deferred until this graph is stable.',
    baseline,
    final: snap(current),
    proposedCount: candidates.length,
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    accepted,
    rejected: rejected.map((r) => ({ patch: r.patch, type: r.type, reason: r.reason, before: r.before, after: r.after })),
    log,
    openEdges: attribution,
    carrierStatus,
    fits: currentFits,
  };
}

export const TIER1_ORDER = ['S35', 'S84', 'S92', 'S99'];
export const TIER2_ORDER = ['S4', 'S91', 'S19', 'S7', 'S21', 'S9', 'S45', 'S50', 'S74', 'S41'];

function txnSnap(state) {
  const attr = attributeOpenEdges(state);
  const p5 = state.pieces.find((p) => p.piece === 5);
  return {
    openEdges: state.openEdges,
    shells: state.shells,
    nonmanifold: state.nonmanifold,
    unexplained: attr.unexplainedCount,
    fittedUntrimmed: attr.explainedByFittedUntrimmed,
    duplicateEdges: state.duplicateEdges,
    unresolved: state.unresolved,
    piece5: p5 ? { shells: p5.shells, openEdges: p5.openEdges } : null,
    pieces: state.pieces.map((p) => ({ piece: p.piece, shells: p.shells, openEdges: p.openEdges })),
  };
}

function decideTxn(prev, next) {
  if (next.nonmanifold > 0 || next.nonmanifold > prev.nonmanifold) {
    return { accept: false, reason: 'nonmanifold' };
  }
  if (next.unexplained > 0 || next.unexplained > prev.unexplained) {
    return { accept: false, reason: 'unexplained-edges' };
  }
  if (next.duplicateEdges > prev.duplicateEdges) {
    return { accept: false, reason: 'duplicate-trims' };
  }
  if (next.openEdges > prev.openEdges) {
    return { accept: false, reason: 'open-edges-increased' };
  }
  if (next.piece5 && (next.piece5.openEdges > 0 || next.piece5.shells !== 1)) {
    return { accept: false, reason: 'piece-5-reopened' };
  }
  return {
    accept: true,
    reason: next.openEdges < prev.openEdges ? 'open-edges-decreased' : 'topology-held',
  };
}

function overlayFit(fits, proposal, flags) {
  return fits.map((f) => {
    if (f.patch !== proposal.patch) return f;
    return {
      ...f,
      chosen: proposal.chosen,
      acceptedGeometry: flags.acceptedGeometry,
      topologyProbe: flags.topologyProbe,
      residualGate: flags.residualGate,
    };
  });
}

function branchKind(id) {
  if (!id) return null;
  if (id.includes('seed_polyline')) return 'seed';
  if (id.includes('numerical')) return 'numerical';
  return 'geometric';
}

function probeNotes(patch, correspondence, before, after, status, overrides, diagnostics) {
  const rec = correspondence.patches.find((p) => p.id === patch);
  const newBranches = Object.entries(overrides)
    .filter(([, id]) => typeof id === 'string' && (id.startsWith(`${patch}__`) || id.includes(`__plane_`) && id.includes(patch)))
    .map(([, id]) => id);
  const kinds = newBranches.map(branchKind);
  const seedOrNum = kinds.some((k) => k === 'seed' || k === 'numerical');
  const noGeom = (diagnostics || []).some((d) => (
    d.patch === patch && d.adjacencies.some((a) => a.rejected.some((r) => r.reason === 'no-geometric-intersection'))
  ));
  const pieceBefore = before.pieces.find((p) => p.piece === rec?.piece);
  const pieceAfter = after.pieces.find((p) => p.piece === rec?.piece);
  return {
    closesIntendedOpening: !!status?.trimComplete,
    validLoopsBothAssemblies: !!(rec?.cubeA && rec?.cubeB) && (status?.unmatchedCount ?? 1) === 0,
    joinsPreviouslySeparateShells: (pieceAfter?.shells ?? 0) < (pieceBefore?.shells ?? 0),
    seedSupportedTrims: seedOrNum,
    impossibleGeometricTrims: noGeom,
    pieceShellsBefore: pieceBefore?.shells ?? null,
    pieceShellsAfter: pieceAfter?.shells ?? null,
    pieceOpenEdgesBefore: pieceBefore?.openEdges ?? null,
    pieceOpenEdgesAfter: pieceAfter?.openEdges ?? null,
  };
}

function sortProposals(proposals, order) {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...proposals].sort((a, b) => (rank.get(a.patch) ?? 99) - (rank.get(b.patch) ?? 99));
}

export function lockedBaseline(raw, correspondence, opts = {}) {
  const firstFits = opts.baselineFits || fitOpeningsBatched(correspondence).fits;
  const firstInsert = insertCarriersTransactional(raw, correspondence, firstFits);
  const trim = searchTrimBranches(raw, correspondence, firstInsert.fits, {
    includeMate: opts.includeMate === true,
  });
  return {
    fits: firstInsert.fits,
    overrides: trim.chosen.overrides,
    state: topologyMetrics(raw, correspondence, firstInsert.fits, {
      branchOverrides: trim.chosen.overrides,
    }),
    trim,
    firstInsert,
  };
}

export function insertOpeningProposals(raw, correspondence, opts = {}) {
  const proposals = opts.proposals || proposeUnresolvedFits(correspondence).proposals;
  const locked = opts.locked || lockedBaseline(raw, correspondence, opts);
  const byId = new Map(proposals.map((p) => [p.patch, p]));
  const tier1 = sortProposals(TIER1_ORDER.map((id) => byId.get(id)).filter(Boolean), TIER1_ORDER);
  const tier2 = sortProposals(TIER2_ORDER.map((id) => byId.get(id)).filter(Boolean), TIER2_ORDER);

  let fits = locked.fits.map((f) => ({ ...f }));
  let overrides = { ...locked.overrides };
  let current = topologyMetrics(raw, correspondence, fits, { branchOverrides: overrides });
  const baseline = txnSnap(current);
  const log = [];

  const searchOpts = {
    includeMate: false,
    allowFallbackBranches: true,
    orientations: ['forward', 'reverse'],
  };

  function attempt(proposal, tier) {
    const flags = tier === 1
      ? { acceptedGeometry: true, topologyProbe: false, residualGate: 'pass' }
      : { acceptedGeometry: false, topologyProbe: true, residualGate: 'mateB' };
    const before = txnSnap(current);
    const trialFits = overlayFit(fits, proposal, flags);
    const search = searchTrimBranches(raw, correspondence, trialFits, {
      ...searchOpts,
      patchIds: [proposal.patch],
      startOverrides: overrides,
    });
    const trialOverrides = search.chosen.overrides;
    const trial = topologyMetrics(raw, correspondence, trialFits, { branchOverrides: trialOverrides });
    const after = txnSnap(trial);
    const verdict = decideTxn(before, after);
    const patchStatus = carrierStatuses(trialFits, trial).find((c) => c.patch === proposal.patch);
    const newBranchIds = Object.entries(trialOverrides)
      .filter(([key, id]) => overrides[key] !== id)
      .map(([, id]) => id);
    const notes = probeNotes(
      proposal.patch,
      correspondence,
      before,
      after,
      patchStatus,
      trialOverrides,
      search.diagnostics,
    );
    const decision = !verdict.accept ? 'rollback' : (tier === 1 ? 'keep' : 'provisional');
    const entry = {
      opening: proposal.patch,
      piece: proposal.piece,
      family: proposal.chosen?.type || null,
      tier,
      residualGate: flags.residualGate,
      branchIds: newBranchIds,
      branchId: newBranchIds[0] || null,
      before,
      after,
      delta: {
        openEdges: after.openEdges - before.openEdges,
        shells: after.shells - before.shells,
        nonmanifold: after.nonmanifold - before.nonmanifold,
        unexplained: after.unexplained - before.unexplained,
      },
      trimComplete: patchStatus?.trimComplete ?? false,
      cubeAResidual: proposal.chosen?.mateARms ?? proposal.chosen?.rms ?? null,
      cubeBResidual: proposal.chosen?.mateBRms ?? null,
      acceptedGeometry: decision === 'keep',
      topologyProbe: decision === 'provisional',
      decision,
      reason: verdict.reason,
      notes,
    };
    log.push(entry);
    if (verdict.accept) {
      fits = trialFits;
      overrides = trialOverrides;
      current = trial;
    }
    return entry;
  }

  const tier1Log = tier1.map((p) => attempt(p, 1));
  const tier2Log = tier2.map((p) => attempt(p, 2));
  const attr = attributeOpenEdges(current);
  const statuses = carrierStatuses(fits, current);
  const p5 = current.pieces.find((p) => p.piece === 5);
  const kept = log.filter((e) => e.decision === 'keep');
  const provisional = log.filter((e) => e.decision === 'provisional');
  const rolled = log.filter((e) => e.decision === 'rollback');
  const unresolved = [...tier1, ...tier2]
    .filter((p) => rolled.some((e) => e.opening === p.patch))
    .map((p) => p.patch);
  const represented = new Set([
    ...kept.map((e) => e.opening),
    ...provisional.map((e) => e.opening),
  ]);
  const optimizerReady = [...TIER1_ORDER, ...TIER2_ORDER].every((id) => (
    represented.has(id) || unresolved.includes(id) || !byId.has(id)
  ));
  const piecesCloser = baseline.pieces
    .map((b) => {
      const a = current.pieces.find((p) => p.piece === b.piece);
      return {
        piece: b.piece,
        shellsBefore: b.shells,
        shellsAfter: a?.shells ?? null,
        openEdgesBefore: b.openEdges,
        openEdgesAfter: a?.openEdges ?? null,
        closerToOneShell: (a?.shells ?? b.shells) < b.shells || ((a?.shells ?? 99) === 1 && b.shells > 1),
      };
    })
    .filter((p) => p.closerToOneShell || p.openEdgesAfter < p.openEdgesBefore);

  return {
    schema: 'dual-cube-two-tier-insertion',
    version: 1,
    note: 'Tier-1 residual-pass carriers are accepted geometry. Tier-2 Cube B failures are provisional topology probes and do not receive CAD closure credit. Global GPU optimization waits until this pass finishes.',
    baseline,
    final: txnSnap(current),
    openEdges: attr,
    carrierStatus: statuses,
    piece5: p5 ? { shells: p5.shells, openEdges: p5.openEdges, closed: p5.shells === 1 && p5.openEdges === 0 } : null,
    tier1: {
      attempted: tier1Log.length,
      kept: kept.filter((e) => e.tier === 1).length,
      rolledBack: rolled.filter((e) => e.tier === 1).length,
    },
    tier2: {
      attempted: tier2Log.length,
      provisional: provisional.length,
      rolledBack: rolled.filter((e) => e.tier === 2).length,
      usable: provisional.map((e) => e.opening),
    },
    optimizerReady,
    unresolved,
    piecesCloserToOneShell: piecesCloser,
    log,
    branchOverrides: overrides,
    fits,
  };
}
