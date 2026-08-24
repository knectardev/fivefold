/**
 * Hunt for a face-connected N×P exact-cover candidate.
 * Does not overwrite candidate_N*_P8.json disconnected regression fixtures.
 *
 *   node solvers/dual_cube/search_connected.mjs
 *   node solvers/dual_cube/search_connected.mjs --N 8 --sets 800 --workers 8
 *   node solvers/dual_cube/search_connected.mjs --N 8 --sets 2000 --workers 14 --mode volume
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { compareKey, defaultParams } from './exact_cover_kernel.mjs';
import { buildCandidateDocument, cadEligibility } from './json_contract.mjs';
import { appendNearMissArchive, applyVolumeRepairPostPass } from './volume_repair.mjs';
import { analyticDifficultyOfCandidate } from './n8_triage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'results');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}

const N = +(arg('N', '6'));
const P = +(arg('pieces', '8'));
const sets = +(arg('sets', '800'));
const workers = Math.max(1, Math.min(+(arg('workers', '4')), cpus().length || 4));
const campaignSeed = +(arg('seed', '20260820'));
const radius = +(arg('radius', '0'));
const startOffset = +(arg('offset', '0'));
const mode = arg('mode', 'all');

function jobSeed(jobIndex) {
  return (campaignSeed + jobIndex * 10007) >>> 0;
}

function runPool(jobs, params) {
  return new Promise((resolve, reject) => {
    const results = [];
    let next = 0;
    let settled = false;
    const pool = [];

    function finish(err, value) {
      if (settled) return;
      settled = true;
      for (const w of pool) w.terminate();
      if (err) reject(err);
      else resolve(value);
    }

    function sendNext(worker) {
      if (next >= jobs.length) {
        worker.postMessage({ type: 'end' });
        return;
      }
      const jobIndex = jobs[next++];
      worker.postMessage({
        N,
        pieceCount: P,
        radius,
        params,
        seed: jobSeed(jobIndex),
        jobIndex,
      });
    }

    for (let i = 0; i < Math.min(workers, jobs.length); i++) {
      const worker = new Worker(join(here, 'search.pool-worker.mjs'));
      pool.push(worker);
      worker.on('error', (err) => finish(err));
      worker.on('message', (msg) => {
        if (msg.type === 'end') return;
        results.push(msg);
        if (results.length === jobs.length) {
          finish(null, results);
          return;
        }
        sendNext(worker);
      });
      sendNext(worker);
    }
  });
}

function summarize(candidate) {
  if (!candidate) return null;
  const cad = cadEligibility(candidate.counts, P, candidate);
  return {
    connected: candidate.connected,
    minVol: candidate.minVol,
    fragileRatio: candidate.fragileRatio,
    imbalance: candidate.imbalance,
    rough: candidate.roughA + candidate.roughB,
    admissibility: candidate.admissibility,
    cadEligible: cad.cadEligible,
    cadQueue: cad.cadQueue,
    cadBlockers: cad.reasons,
    cadWarnings: cad.warnings,
    seed: candidate.seed,
    jobIndex: candidate.jobIndex,
  };
}

async function huntPass({ label, jobOffset, count, params }) {
  const jobs = Array.from({ length: count }, (_, i) => jobOffset + i);
  const t0 = performance.now();
  const rows = await runPool(jobs, params);
  const wallMs = performance.now() - t0;
  let exact = 0;
  let connected = 0;
  let cadEligible = 0;
  let best = null;
  let bestConnected = null;
  let firstCad = null;
  const connectedMinVols = [];
  const nearMiss = [];
  for (const row of rows) {
    const c = row.candidate;
    if (!c || row.infeasible) continue;
    exact++;
    c.seed = row.seed;
    c.jobIndex = row.jobIndex;
    if (c.connected === P) {
      connected++;
      connectedMinVols.push(c.minVol);
      try {
        const d = analyticDifficultyOfCandidate(c, N, P);
        c.analyticDifficulty = d.score;
        c.analyticSignals = d.signals;
      } catch {
        c.analyticDifficulty = Number.POSITIVE_INFINITY;
      }
      const minCells = Math.min(...c.counts);
      if (minCells >= 22 && minCells <= 25) {
        c.N = N;
        c.gridResolution = N;
        c.pieceCount = P;
        appendNearMissArchive(join(outDir, `connected_volume_archive_n${N}.json`), c, {
          seed: c.seed,
          jobIndex: c.jobIndex,
          pass: label,
        });
        nearMiss.push(c);
      }
    }
    const cad = cadEligibility(c.counts, P, c);
    if (cad.cadEligible) {
      cadEligible++;
      if (!firstCad) firstCad = c;
    }
    if (!best || compareKey(c, best, P) < 0) best = c;
    if (!bestConnected || c.connected > bestConnected.connected || (c.connected === bestConnected.connected && compareKey(c, bestConnected, P) < 0)) {
      bestConnected = c;
    }
  }
  connectedMinVols.sort((a, b) => b - a);
  return {
    label,
    wallMs,
    exact,
    connected,
    cadEligible,
    connectedRate: exact ? connected / exact : 0,
    cadEligibleRate: exact ? cadEligible / exact : 0,
    connectedMinVolMax: connectedMinVols[0] ?? null,
    connectedMinVolMedian: connectedMinVols.length ? connectedMinVols[Math.floor(connectedMinVols.length / 2)] : null,
    best: summarize(best),
    bestConnected: summarize(bestConnected),
    firstCad,
    bestConnectedCandidate: bestConnected,
    nearMiss,
  };
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const passes = [];
  console.log(`Connected N=${N} P=${P} search  sets=${sets} workers=${workers} seed=${campaignSeed} mode=${mode} offset=${startOffset} cpus=${cpus().length}`);

  let chosen = null;
  if (mode === 'all' || mode === 'default') {
    const passA = await huntPass({
      label: 'coherent-default',
      jobOffset: startOffset,
      count: sets,
      params: { ...defaultParams(P), rounds: 3 },
    });
    passes.push(passA);
    console.log(
      `  ${passA.label}: ${passA.wallMs.toFixed(0)}ms  exact=${passA.exact}  connected=${passA.connected} (${(100 * passA.connectedRate).toFixed(1)}%)  cad=${passA.cadEligible}  bestConnected=${passA.bestConnected?.connected ?? 0}/${P}  bestMinVol=${passA.connectedMinVolMax != null ? (100 * passA.connectedMinVolMax).toFixed(1) : 'n/a'}%`,
    );
    chosen = passA.firstCad || passA.bestConnectedCandidate;
  }

  if ((mode === 'all' || mode === 'balance') && !passes.some((p) => p.firstCad)) {
    const passB = await huntPass({
      label: 'balance-32-rounds-8',
      jobOffset: startOffset + (mode === 'all' ? sets : 0),
      count: sets,
      params: { ...defaultParams(P), rounds: 8, balance: 32, connRefine: 4.6 },
    });
    passes.push(passB);
    console.log(
      `  ${passB.label}: ${passB.wallMs.toFixed(0)}ms  exact=${passB.exact}  connected=${passB.connected} (${(100 * passB.connectedRate).toFixed(1)}%)  cad=${passB.cadEligible}  bestConnected=${passB.bestConnected?.connected ?? 0}/${P}  bestMinVol=${passB.connectedMinVolMax != null ? (100 * passB.connectedMinVolMax).toFixed(1) : 'n/a'}%`,
    );
    if (passB.firstCad && passB.bestConnectedCandidate && cadEligibility(passB.bestConnectedCandidate.counts, P, passB.bestConnectedCandidate).cadEligible) {
      chosen = passB.bestConnectedCandidate;
    } else if (passB.firstCad) chosen = passB.firstCad;
    else if (passB.bestConnectedCandidate && (!chosen || compareKey(passB.bestConnectedCandidate, chosen, P) < 0)) {
      chosen = passB.bestConnectedCandidate;
    }
  }

  if ((mode === 'all' || mode === 'balance') && !passes.some((p) => p.firstCad)) {
    const passC = await huntPass({
      label: 'balance-48-rounds-10',
      jobOffset: startOffset + (mode === 'all' ? sets * 2 : sets),
      count: sets,
      params: { ...defaultParams(P), rounds: 10, balance: 48, connRefine: 5.2 },
    });
    passes.push(passC);
    console.log(
      `  ${passC.label}: ${passC.wallMs.toFixed(0)}ms  exact=${passC.exact}  connected=${passC.connected} (${(100 * passC.connectedRate).toFixed(1)}%)  cad=${passC.cadEligible}  bestConnected=${passC.bestConnected?.connected ?? 0}/${P}  bestMinVol=${passC.connectedMinVolMax != null ? (100 * passC.connectedMinVolMax).toFixed(1) : 'n/a'}%`,
    );
    if (passC.firstCad && passC.bestConnectedCandidate && cadEligibility(passC.bestConnectedCandidate.counts, P, passC.bestConnectedCandidate).cadEligible) {
      chosen = passC.bestConnectedCandidate;
    } else if (passC.firstCad) chosen = passC.firstCad;
    else if (passC.bestConnectedCandidate && (!chosen || compareKey(passC.bestConnectedCandidate, chosen, P) < 0)) {
      chosen = passC.bestConnectedCandidate;
    }
  }

  // Volume intensification: grow the smallest piece without dropping connectivity.
  // N=8 CAD eligibility needs minVol ≥ 5% (26/512 cells); connected hits often stall at 24.
  if ((mode === 'all' || mode === 'balance' || mode === 'volume') && !passes.some((p) => p.firstCad)) {
    const volumeOffset =
      mode === 'volume' ? startOffset
        : mode === 'all' ? startOffset + sets * 3
        : startOffset + sets * 2;
    const passD = await huntPass({
      label: 'balance-72-rounds-14',
      jobOffset: volumeOffset,
      count: sets,
      params: { ...defaultParams(P), rounds: 14, balance: 72, connRefine: 5.6 },
    });
    passes.push(passD);
    console.log(
      `  ${passD.label}: ${passD.wallMs.toFixed(0)}ms  exact=${passD.exact}  connected=${passD.connected} (${(100 * passD.connectedRate).toFixed(1)}%)  cad=${passD.cadEligible}  bestConnected=${passD.bestConnected?.connected ?? 0}/${P}  bestMinVol=${passD.connectedMinVolMax != null ? (100 * passD.connectedMinVolMax).toFixed(1) : 'n/a'}%`,
    );
    if (passD.firstCad && passD.bestConnectedCandidate && cadEligibility(passD.bestConnectedCandidate.counts, P, passD.bestConnectedCandidate).cadEligible) {
      chosen = passD.bestConnectedCandidate;
    } else if (passD.firstCad) chosen = passD.firstCad;
    else if (passD.bestConnectedCandidate && (!chosen || compareKey(passD.bestConnectedCandidate, chosen, P) < 0)) {
      chosen = passD.bestConnectedCandidate;
    }
  }

  const nearMiss = passes.flatMap((p) => p.nearMiss || []);
  if (nearMiss.length) {
    const post = applyVolumeRepairPostPass(nearMiss, { N, P });
    console.log(`Volume repair post-pass  considered=${post.considered} repaired=${post.repairedCount}`);
    if (post.best?.candidate) {
      const r = post.best.candidate;
      if (!chosen || compareKey(r, chosen, P) < 0) {
        chosen = r;
        console.log(`  promoted repaired minCells=${Math.min(...r.counts)} cadEligible=${post.best.repair.cadEligible}`);
      } else {
        console.log('  repaired candidate did not beat hunt winner; connected baseline unchanged');
      }
    }
  }

  const connectedName = `candidate_N${N}_P${P}_connected.json`;
  const summaryName = `search_connected_n${N}.json`;
  const fixtureName = `candidate_N${N}_P${P}.json`;
  const summaryPath = join(outDir, summaryName);
  const campaign = {
    savedAt: new Date().toISOString(),
    campaignSeed,
    workers,
    mode,
    sets,
    offset: startOffset,
    passes: passes.map((p) => ({
      label: p.label,
      wallMs: p.wallMs,
      exact: p.exact,
      connected: p.connected,
      cadEligible: p.cadEligible,
      connectedRate: p.connectedRate,
      cadEligibleRate: p.cadEligibleRate,
      connectedMinVolMax: p.connectedMinVolMax,
      connectedMinVolMedian: p.connectedMinVolMedian,
      bestConnected: p.bestConnected,
    })),
  };
  let prior = null;
  if (existsSync(summaryPath)) {
    try {
      prior = JSON.parse(readFileSync(summaryPath, 'utf8'));
    } catch {
      prior = null;
    }
  }
  const campaigns = Array.isArray(prior?.campaigns)
    ? [...prior.campaigns, campaign]
    : prior
      ? [prior, campaign]
      : [campaign];
  const totals = campaigns.reduce(
    (acc, c) => {
      for (const p of c.passes || []) {
        acc.exact += p.exact || 0;
        acc.connected += p.connected || 0;
        acc.cadEligible += p.cadEligible || 0;
      }
      return acc;
    },
    { exact: 0, connected: 0, cadEligible: 0 },
  );
  const summary = {
    savedAt: campaign.savedAt,
    N,
    pieceCount: P,
    radius,
    note: `${fixtureName} is a disconnected regression fixture and is not overwritten.`,
    foundConnected: !!(chosen && chosen.connected === P) || !!prior?.foundConnected,
    foundCadEligible: !!(chosen && cadEligibility(chosen.counts, P, chosen).cadEligible) || !!prior?.foundCadEligible,
    totals,
    campaigns,
  };

  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  if (chosen && chosen.connected === P) {
    const cad = cadEligibility(chosen.counts, P, chosen);
    const doc = buildCandidateDocument({
      N,
      pieceCount: P,
      placements: chosen.placements,
      labelsA: chosen.labelsA,
      labelsB: chosen.labelsB,
      destOf: chosen.destOf,
      counts: chosen.counts,
      metrics: chosen,
      searchParameters: chosen.admissibility ? undefined : {},
      seed: chosen.seed,
      activePreset: `connected-n${N}-hunt`,
    });
    doc.searchMetadata.searchParameters = {
      ...defaultParams(P),
      radius,
      seed: chosen.seed,
      jobIndex: chosen.jobIndex,
    };
    doc.cadEligible = cad.cadEligible;
    doc.cadQueue = cad.cadQueue;
    doc.cadRole = cad.cadRole;
    const out = join(outDir, connectedName);
    if (existsSync(out)) {
      const prev = JSON.parse(readFileSync(out, 'utf8'));
      const prevM = {
        connected: prev.validation?.connectivity?.connected ?? 0,
        counts: prev.counts,
        minVol: prev.validation?.connectivity?.minVol,
        maxVol: prev.validation?.scores?.maxVol,
        fragileRatio: prev.validation?.connectivity?.fragileRatio,
        roughA: prev.validation?.scores?.roughA,
        roughB: prev.validation?.scores?.roughB,
        imbalance: prev.validation?.scores?.imbalance,
        regularity: prev.validation?.scores?.regularity,
        similarity: prev.validation?.scores?.similarity,
        adjacencyDifference: prev.validation?.scores?.adjacencyDifference,
        moved: prev.validation?.scores?.moved,
        seed: prev.searchMetadata?.seed,
        jobIndex: prev.searchMetadata?.searchParameters?.jobIndex,
      };
      const prevCad = !!prev.cadEligible;
      if (prevM.connected === P && compareKey(prevM, chosen, P) < 0 && !(cad.cadEligible && !prevCad)) {
        console.log(`Kept existing ${out}  minVol=${(100 * (prevM.minVol ?? 0)).toFixed(1)}%  (new candidate ranks worse)`);
        return;
      }
    }
    writeFileSync(out, JSON.stringify(doc));
    console.log(`Wrote ${out}  connected=${chosen.connected}/${P}  cadEligible=${cad.cadEligible}  minVol=${(100 * chosen.minVol).toFixed(1)}%`);
  } else {
    console.log(`No fully connected N=${N} P=${P} candidate. Best connected=${chosen?.connected ?? 0}/${P}. See ${summaryName}.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
