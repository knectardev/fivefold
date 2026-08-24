/**
 * Phase 0 search + studio baseline, plus a Node worker-pool scaling check.
 *
 *   node solvers/dual_cube/bench_phase0.mjs
 *   node solvers/dual_cube/bench_phase0.mjs --quick
 *   node solvers/dual_cube/bench_phase0.mjs --sets 3 --rounds 3 --workers 4
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import {
  mulberry32,
  solveTransformSet,
  serializeCandidate,
  defaultParams,
} from './exact_cover_kernel.mjs';
import { buildCandidateDocument, SOLVER_BUILD } from './json_contract.mjs';
import { runStudioBaseline } from './surface_studio_kernel.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'results');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}

const quick = process.argv.includes('--quick');
const setsPerCell = +(arg('sets', quick ? '1' : '3'));
const rounds = +(arg('rounds', quick ? '1' : '3'));
const workerCount = +(arg('workers', '4'));
const Ns = quick ? [6] : [6, 8, 10];
const Ps = quick ? [8] : [8, 9, 10];
const radii = quick ? [0] : [0, 1];
const baseSeed = 20260820;

function memMB() {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

function runCell({ N, P, radius, sets, seed0 }) {
  const params = { ...defaultParams(P), rounds };
  const timings = [];
  let exact = 0;
  let connected = 0;
  let admissible = 0;
  let infeasible = 0;
  let best = null;
  const t0 = performance.now();
  const mem0 = memMB();
  let peakMem = mem0;
  for (let s = 0; s < sets; s++) {
    const rand = mulberry32((seed0 + s * 9973) >>> 0);
    const { candidate, timing } = solveTransformSet({ N, pieceCount: P, radius, params, rand });
    timings.push(timing);
    peakMem = Math.max(peakMem, memMB());
    if (timing.infeasible || !candidate) {
      infeasible++;
      continue;
    }
    exact++;
    if (candidate.connected === P) connected++;
    if (candidate.admissibility?.pass) admissible++;
    if (!best || candidate.score < best.score) best = candidate;
  }
  const wallMs = performance.now() - t0;
  const matchMs = timings.reduce((s, t) => s + t.matchingMs, 0);
  const edgeMs = timings.reduce((s, t) => s + t.makeEdgesMs, 0);
  const evalMs = timings.reduce((s, t) => s + t.evalMs, 0);
  const matchings = timings.reduce((s, t) => s + t.rounds, 0);
  return {
    N,
    pieceCount: P,
    radius,
    sets,
    rounds,
    wallMs,
    setsPerMinute: wallMs > 0 ? (sets * 60000) / wallMs : 0,
    makeEdgesMs: edgeMs,
    matchingMs: matchMs,
    evalMs,
    matchings,
    matchingMsPerMatching: matchings ? matchMs / matchings : 0,
    exactCoverRate: exact / sets,
    connectedPieceRate: exact ? connected / exact : 0,
    fullyAdmissibleRate: exact ? admissible / exact : 0,
    infeasibleRate: infeasible / sets,
    peakHeapMB: peakMem,
    heapDeltaMB: peakMem - mem0,
    mainThreadBlockedMs: wallMs,
    best: best ? serializeCandidate(best) : null,
  };
}

function runWorkerJob(job) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(here, 'search.node-worker.mjs'), { workerData: job });
    let done = false;
    worker.on('message', (msg) => {
      done = true;
      worker.terminate();
      resolve(msg);
    });
    worker.on('error', (err) => {
      if (!done) reject(err);
    });
    worker.on('exit', (code) => {
      if (!done && code !== 0) reject(new Error(`worker exit ${code}`));
    });
  });
}

async function scalingCheck({ N, P, radius, jobs, workers }) {
  const params = { ...defaultParams(P), rounds };
  const makeJobs = () =>
    Array.from({ length: jobs }, (_, s) => ({
      N,
      pieceCount: P,
      radius,
      params,
      seed: (baseSeed + 100000 + s * 7919) >>> 0,
    }));

  const serialJobs = makeJobs();
  const tSerial = performance.now();
  for (const job of serialJobs) await runWorkerJob(job);
  const serialMs = performance.now() - tSerial;

  const parallelJobs = makeJobs();
  const tPar = performance.now();
  let cursor = 0;
  async function workerLoop() {
    while (cursor < parallelJobs.length) {
      const job = parallelJobs[cursor++];
      await runWorkerJob(job);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => workerLoop()));
  const parallelMs = performance.now() - tPar;
  const speedup = parallelMs > 0 ? serialMs / parallelMs : 0;
  const efficiency = speedup / workers;
  return {
    N,
    pieceCount: P,
    radius,
    jobs,
    workers,
    serialMs,
    parallelMs,
    speedup,
    efficiency,
    nearLinear: efficiency >= 0.7,
    cpuCount: cpus().length,
  };
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  console.log(`Phase 0 bench  sets=${setsPerCell} rounds=${rounds}  N=${Ns} P=${Ps} radius=${radii}`);
  const cells = [];
  const studio = [];
  for (const N of Ns) {
    for (const P of Ps) {
      for (const radius of radii) {
        const seed0 = (baseSeed + N * 1000 + P * 10 + radius) >>> 0;
        process.stdout.write(`  N=${N} P=${P} r=${radius} ... `);
        const cell = runCell({ N, P, radius, sets: setsPerCell, seed0 });
        cells.push(cell);
        console.log(
          `${cell.wallMs.toFixed(0)}ms  match=${cell.matchingMsPerMatching.toFixed(0)}ms/match  exact=${(100 * cell.exactCoverRate).toFixed(0)}%  adm=${(100 * cell.fullyAdmissibleRate).toFixed(0)}%`,
        );
        if (cell.best && radius === 0 && (P === 8 || quick)) {
          const doc = buildCandidateDocument({
            N,
            pieceCount: P,
            placements: cell.best.placements,
            labelsA: cell.best.labelsA,
            labelsB: cell.best.labelsB,
            destOf: cell.best.destOf,
            counts: cell.best.counts,
            metrics: { ...cell.best, admissibility: cell.best.admissibility },
            searchParameters: { ...defaultParams(P), rounds, radius },
            seed: seed0,
            activePreset: 'coherent-bench',
            solverBuild: SOLVER_BUILD,
          });
          const path = join(outDir, `candidate_N${N}_P${P}.json`);
          writeFileSync(path, JSON.stringify(doc));
          const tStudio = performance.now();
          const report = runStudioBaseline(doc);
          report.studioWallMs = performance.now() - tStudio;
          report.N = N;
          report.pieceCount = P;
          studio.push(report);
          console.log(
            `    studio extract=${report.extractMs.toFixed(0)}ms fit=${report.fitMs.toFixed(0)}ms opt=${report.optimizeMs.toFixed(0)}ms patches=${report.patchCount} freeform=${report.freeform} Brms=${report.cubeB_matingRMS.toFixed(4)}`,
          );
        }
      }
    }
  }

  let scaling = null;
  if (!quick) {
    const jobs = Math.max(8, workerCount * 2);
    process.stdout.write(`  worker scaling N=8 P=8 jobs=${jobs} workers=${workerCount} ... `);
    scaling = await scalingCheck({ N: 8, P: 8, radius: 0, jobs, workers: workerCount });
    console.log(
      `serial=${scaling.serialMs.toFixed(0)}ms parallel=${scaling.parallelMs.toFixed(0)}ms speedup=${scaling.speedup.toFixed(2)}x eff=${(100 * scaling.efficiency).toFixed(0)}%`,
    );
  }

  const n6 = cells.find((c) => c.N === 6 && c.pieceCount === 8 && c.radius === 0);
  const projections = {};
  if (n6) {
    for (const c of cells.filter((x) => x.pieceCount === 8 && x.radius === 0)) {
      const theory = (c.N / 6) ** 6;
      const measured = n6.matchingMsPerMatching > 0 ? c.matchingMsPerMatching / n6.matchingMsPerMatching : null;
      projections[`N${c.N}`] = {
        complexityProjectionVsN6: theory,
        measuredMatchingRatioVsN6: measured,
      };
    }
  }

  const summary = {
    savedAt: new Date().toISOString(),
    solverBuild: SOLVER_BUILD,
    note: 'Matching costs are measured wall-clock. N^6 figures elsewhere are complexity projections, not expected wall-clock ratios.',
    config: { setsPerCell, rounds, Ns, Ps, radii, quick },
    search: cells.map(({ best, ...rest }) => rest),
    studioBaseline: studio,
    workerScaling: scaling,
    complexityProjections: projections,
    gates: {
      workerNearLinear: scaling ? scaling.nearLinear : null,
      workerTarget: 'efficiency >= 0.7 through at least 4 workers',
      studioIsDiscardableBaseline: true,
      jsonContract: 'dual-cube-candidate v2',
    },
  };
  const outPath = join(outDir, 'phase0.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
