/**
 * Compile matching_kernel.c to matching_kernel.wasm via an Emscripten Docker image.
 * The JS matcher remains the correctness oracle; this only emits the artifact.
 *
 *   node solvers/dual_cube/build_wasm.mjs
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, statSync } from 'node:fs';

const dir = dirname(fileURLToPath(import.meta.url));
const image = process.env.EMSCRIPTEN_IMAGE || 'emscripten/emsdk:4.0.12';
const srcUnix = dir.replace(/\\/g, '/');
const exports = [
  '_match',
  '_wasm_match',
  '_wasm_graph',
  '_wasm_graph_cap',
  '_wasm_labelsA',
  '_wasm_labelsB',
  '_wasm_destOf',
  '_wasm_totalCost',
].join(',');

const args = [
  'run', '--rm',
  '-v', `${srcUnix}:/src`,
  '-w', '/src',
  image,
  'emcc', 'matching_kernel.c',
  '-O3',
  '--no-entry',
  '-s', 'STANDALONE_WASM=1',
  '-s', `EXPORTED_FUNCTIONS=${exports}`,
  '-s', 'INITIAL_MEMORY=33554432',
  '-s', 'ALLOW_MEMORY_GROWTH=0',
  '-o', 'matching_kernel.wasm',
];

console.log('docker', args.join(' '));
const result = spawnSync('docker', args, { stdio: 'inherit', shell: false });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
const wasm = join(dir, 'matching_kernel.wasm');
if (!existsSync(wasm)) {
  console.error('emcc exited 0 but matching_kernel.wasm was not written');
  process.exit(1);
}
console.log(JSON.stringify({
  artifact: wasm,
  bytes: statSync(wasm).size,
  image,
}, null, 2));
