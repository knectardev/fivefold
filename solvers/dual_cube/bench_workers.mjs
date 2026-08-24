/**
 * Worker-count scan at N=8 P=8 (notes: default 4, then 4/6/8/12).
 *   node solvers/dual_cube/bench_workers.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { defaultParams } from './exact_cover_kernel.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const counts = [4, 6, 8, 12];
const jobs = 12;
const N = 8;
const P = 8;
const baseSeed = 20260820;

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

function makeJobs() {
  const params = { ...defaultParams(P), rounds: 3 };
  return Array.from({ length: jobs }, (_, s) => ({
    N,
    pieceCount: P,
    radius: 0,
    params,
    seed: (baseSeed + s * 7919) >>> 0,
  }));
}

async function runPool(workers) {
  const queue = makeJobs();
  const t0 = performance.now();
  let cursor = 0;
  async function loop() {
    while (cursor < queue.length) {
      const job = queue[cursor++];
      await runWorkerJob(job);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => loop()));
  return performance.now() - t0;
}

async function main() {
  mkdirSync(join(here, 'results'), { recursive: true });
  console.log(`Worker scan N=${N} P=${8} jobs=${jobs} rounds=3  cpus=${cpus().length}`);
  const serialMs = await runPool(1);
  console.log(`  workers=1  ${serialMs.toFixed(0)}ms  (serial baseline)`);
  const rows = [{ workers: 1, ms: serialMs, speedup: 1, efficiency: 1 }];
  for (const w of counts) {
    const ms = await runPool(w);
    const speedup = serialMs / ms;
    const efficiency = speedup / w;
    rows.push({ workers: w, ms, speedup, efficiency });
    console.log(`  workers=${w}  ${ms.toFixed(0)}ms  speedup=${speedup.toFixed(2)}x  eff=${(100 * efficiency).toFixed(0)}%`);
  }
  const out = {
    savedAt: new Date().toISOString(),
    N,
    pieceCount: P,
    jobs,
    cpuCount: cpus().length,
    serialMs,
    rows,
    recommendedDefault: 4,
    note: 'Default 4 workers even if many logical CPUs are present. Efficiency may fall from memory bandwidth, GC, and scheduler contention.',
  };
  const path = join(here, 'results', 'worker_scan.json');
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`Wrote ${path}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
