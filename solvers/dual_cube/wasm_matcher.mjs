/**
 * Optional WASM matcher behind the frozen packed-graph ABI.
 * JavaScript minCostPerfectMatching remains the correctness oracle.
 */
import { minCostPerfectMatchingJS as jsMatch, setMatchingBackend } from './exact_cover_kernel.mjs';
import { packEdges, unpackEdges } from './match_protocol.mjs';

function resolveExport(exports, names) {
  for (const name of names) {
    if (typeof exports[name] === 'function') return exports[name];
  }
  return null;
}

function wrapInstance(instance) {
  const exp = instance.exports;
  const memory = exp.memory;
  const graphPtr = resolveExport(exp, ['wasm_graph', '_wasm_graph'])();
  const graphCap = resolveExport(exp, ['wasm_graph_cap', '_wasm_graph_cap'])();
  const labelsAPtr = resolveExport(exp, ['wasm_labelsA', '_wasm_labelsA'])();
  const labelsBPtr = resolveExport(exp, ['wasm_labelsB', '_wasm_labelsB'])();
  const destOfPtr = resolveExport(exp, ['wasm_destOf', '_wasm_destOf'])();
  const costPtr = resolveExport(exp, ['wasm_totalCost', '_wasm_totalCost'])();
  const wasmMatch = resolveExport(exp, ['wasm_match', '_wasm_match', 'match', '_match']);
  if (!memory || !wasmMatch) throw new Error('WASM matcher is missing memory or match export');

  return function matchPackedGraphWasm(buf) {
    const n = new DataView(buf).getUint32(0, true);
    if (buf.byteLength > graphCap) throw new Error('packed graph exceeds WASM buffer');
    const heap = new Uint8Array(memory.buffer);
    heap.set(new Uint8Array(buf), graphPtr);
    const rc = wasmMatch();
    if (rc < 0) throw new Error('WASM matcher error');
    if (rc === 0) return { match: null, backend: 'wasm' };
    const labelsA = new Uint8Array(n);
    const labelsB = new Uint8Array(n);
    labelsA.set(heap.subarray(labelsAPtr, labelsAPtr + n));
    labelsB.set(heap.subarray(labelsBPtr, labelsBPtr + n));
    const destView = new Int32Array(memory.buffer, destOfPtr, n);
    const destOf = new Int32Array(n);
    destOf.set(destView);
    const totalCost = new DataView(memory.buffer).getFloat64(costPtr, true);
    return {
      match: { labelsA, labelsB, destOf, totalCost },
      backend: 'wasm',
    };
  };
}

async function readWasmBytes() {
  const url = new URL('./matching_kernel.wasm', import.meta.url);
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { existsSync, readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const wasmPath = fileURLToPath(url);
    if (!existsSync(wasmPath)) return null;
    return readFileSync(wasmPath);
  }
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

let packedRunner = null;
let loadState = { ok: false, reason: 'not loaded' };

export function wasmStatus() {
  return { ...loadState, ready: !!packedRunner };
}

export async function initWasmMatcher({ installBackend = true } = {}) {
  if (packedRunner) return loadState;
  const bytes = await readWasmBytes();
  if (!bytes) {
    loadState = { ok: false, reason: 'matching_kernel.wasm not found; run node solvers/dual_cube/build_wasm.mjs' };
    return loadState;
  }
  const { instance } = await WebAssembly.instantiate(bytes);
  packedRunner = wrapInstance(instance);
  if (installBackend) {
    setMatchingBackend((edges) => {
      const packed = packedRunner(packEdges(edges));
      return packed.match;
    });
  }
  loadState = { ok: true, reason: 'wasm matcher ready', bytes: bytes.byteLength };
  return loadState;
}

export function matchPackedGraphWithWasm(buf) {
  if (!packedRunner) throw new Error('WASM matcher is not initialized');
  const t0 = performance.now();
  const out = packedRunner(buf);
  return { ...out, ms: performance.now() - t0 };
}

export function matchPackedGraphReference(buf) {
  const t0 = performance.now();
  return { match: jsMatch(unpackEdges(buf)), ms: performance.now() - t0, backend: 'js-reference' };
}
