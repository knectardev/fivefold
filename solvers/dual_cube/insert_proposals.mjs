/**
 * Two-tier CPU insertion of the 14 unresolved-opening proposals.
 *
 *   node solvers/dual_cube/insert_proposals.mjs
 *   node solvers/dual_cube/insert_proposals.mjs solvers/dual_cube/results/candidate_N6_P8_connected.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildCorrespondence } from './physical_correspondence.mjs';
import { insertOpeningProposals } from './insert_carriers.mjs';

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const jsonArg = process.argv.find((a) => a.endsWith('.json') && !a.startsWith('--'))
    || 'solvers/dual_cube/results/candidate_N6_P8_connected.json';
  const raw = JSON.parse(readFileSync(jsonArg, 'utf8'));
  const correspondence = buildCorrespondence(raw);
  const report = insertOpeningProposals(raw, correspondence);
  const outPath = jsonArg.replace(/\.json$/i, '.insertion14.json');
  const serializable = {
    schema: report.schema,
    version: report.version,
    note: report.note,
    baseline: {
      openEdges: report.baseline.openEdges,
      shells: report.baseline.shells,
      nonmanifold: report.baseline.nonmanifold,
      unexplained: report.baseline.unexplained,
    },
    final: {
      openEdges: report.final.openEdges,
      shells: report.final.shells,
      nonmanifold: report.final.nonmanifold,
      unexplained: report.final.unexplained,
      fittedUntrimmed: report.final.fittedUntrimmed,
      unresolved: report.final.unresolved,
    },
    openEdges: report.openEdges,
    piece5: report.piece5,
    tier1: report.tier1,
    tier2: report.tier2,
    optimizerReady: report.optimizerReady,
    unresolved: report.unresolved,
    piecesCloserToOneShell: report.piecesCloserToOneShell,
    carrierStatus: report.carrierStatus,
    branchOverrides: report.branchOverrides,
    fits: report.fits.filter((f) => f.chosen).map((f) => ({
      patch: f.patch,
      piece: f.piece,
      type: f.chosen.type,
      acceptedGeometry: f.acceptedGeometry !== false && !f.topologyProbe,
      topologyProbe: !!f.topologyProbe,
      residualGate: f.residualGate || 'pass',
      rms: f.chosen.rms,
      mateARms: f.chosen.mateARms,
      mateBRms: f.chosen.mateBRms,
    })),
    log: report.log.map((e) => ({
      opening: e.opening,
      family: e.family,
      branchId: e.branchId,
      branchIds: e.branchIds,
      before: {
        openEdges: e.before.openEdges,
        shells: e.before.shells,
        nonmanifold: e.before.nonmanifold,
        unexplained: e.before.unexplained,
      },
      after: {
        openEdges: e.after.openEdges,
        shells: e.after.shells,
        nonmanifold: e.after.nonmanifold,
        unexplained: e.after.unexplained,
      },
      trimComplete: e.trimComplete,
      cubeAResidual: e.cubeAResidual,
      cubeBResidual: e.cubeBResidual,
      decision: e.decision,
      reason: e.reason,
      notes: e.notes,
      residualGate: e.residualGate,
      acceptedGeometry: e.acceptedGeometry,
      topologyProbe: e.topologyProbe,
      delta: e.delta,
    })),
  };
  writeFileSync(outPath, JSON.stringify(serializable, null, 2));
  console.log(JSON.stringify({
    output: outPath,
    baseline: serializable.baseline,
    final: serializable.final,
    tier1Kept: report.tier1.kept,
    tier2Usable: report.tier2.usable,
    rolledBack: report.unresolved,
    piece5: report.piece5,
    optimizerReady: report.optimizerReady,
    piecesCloser: report.piecesCloserToOneShell,
    decisions: report.log.map((e) => ({
      opening: e.opening,
      decision: e.decision,
      openEdges: `${e.before.openEdges}→${e.after.openEdges}`,
      shells: `${e.before.shells}→${e.after.shells}`,
      trimComplete: e.trimComplete,
    })),
  }, null, 2));
}
