/**
 * Correspondence-only N=8 CAD preflight. No insert, opt, or closure.
 *
 *   node solvers/dual_cube/n8_preflight.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCorrespondence } from './physical_correspondence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, 'results');

export function n8Preflight(raw) {
  const correspondence = buildCorrespondence(raw);
  const patches = correspondence.patches || [];
  const byKind = {};
  for (const p of patches) {
    byKind[p.kind] = (byKind[p.kind] || 0) + 1;
  }
  const curved = patches.filter((p) => p.kind === 'curved');
  const planarMate = patches.filter((p) => p.kind === 'planar-mate');
  const cubeExterior = patches.filter((p) => p.kind === 'cube-exterior');
  const contradictoryNeighborhoods = [];
  for (const p of curved) {
    const mateId = p.cubeA?.matePatch;
    const overlap = p.cubeA?.mateOverlap ?? 0;
    if (!mateId && p.cubeA?.mate != null && p.cubeA.mate !== 'exterior') {
      contradictoryNeighborhoods.push({
        patch: p.id,
        piece: p.piece,
        reason: 'curved-without-unique-mate-patch',
        mateOverlap: overlap,
        areaFaces: p.areaFaces,
      });
      continue;
    }
    if (!mateId) continue;
    const mate = patches.find((x) => x.id === mateId);
    if (!mate) {
      contradictoryNeighborhoods.push({ patch: p.id, reason: 'missing-mate-patch', matePatch: mateId });
      continue;
    }
    const mateKeys = new Set(mate.faceKeys || []);
    const hits = (p.oppositeKeys || []).filter((k) => mateKeys.has(k)).length;
    const total = (p.oppositeKeys || []).length;
    if (total && hits < total) {
      contradictoryNeighborhoods.push({
        patch: p.id,
        mate: mateId,
        reason: 'incomplete-opposite-map',
        oppositeHits: hits,
        oppositeTotal: total,
        areaFaces: p.areaFaces,
        mateAreaFaces: mate.areaFaces,
      });
    }
  }
  return {
    schema: 'dual-cube-n8-correspondence-preflight',
    version: 1,
    note: 'Correspondence only. Full N=8 insert/opt/closure is held until this N=6 occupancy is proved or abandoned.',
    fullReconstruction: 'held',
    gridResolution: correspondence.gridResolution ?? raw.gridResolution ?? raw.N,
    cadEligible: raw.cadEligible ?? null,
    counts: {
      patches: patches.length,
      rejected: correspondence.rejected?.length ?? correspondence.counts?.rejected ?? 0,
      curved: curved.length,
      planarMate: planarMate.length,
      cubeExterior: cubeExterior.length,
      byKind,
      ...(correspondence.counts || {}),
    },
    curvedOpenings: curved.map((p) => ({
      id: p.id,
      piece: p.piece,
      areaFaces: p.areaFaces,
      matePatch: p.cubeA?.matePatch ?? null,
      mateOverlap: p.cubeA?.mateOverlap ?? null,
      unique: p.cubeA?.unique ?? null,
    })),
    planarSimpleMix: {
      planarMate: planarMate.length,
      cubeExterior: cubeExterior.length,
      curved: curved.length,
      ratioPlanarToCurved: curved.length ? planarMate.length / curved.length : null,
    },
    contradictoryNeighborhoods,
  };
}

export function main(argv = process.argv) {
  mkdirSync(resultsDir, { recursive: true });
  const input = argv.find((a) => a.endsWith('.json') && !a.startsWith('--'))
    || join(resultsDir, 'candidate_N8_P8_connected.json');
  const raw = JSON.parse(readFileSync(resolve(input), 'utf8'));
  const report = n8Preflight(raw);
  const out = join(resultsDir, 'n8_preflight.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`N=8 correspondence preflight  patches=${report.counts.patches} curved=${report.counts.curved} planarMate=${report.counts.planarMate} contradictory=${report.contradictoryNeighborhoods.length}`);
  console.log(`fullReconstruction=${report.fullReconstruction}`);
  console.log(`Wrote ${out}`);
  return report;
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  main();
}
