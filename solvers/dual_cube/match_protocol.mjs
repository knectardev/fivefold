/**
 * Packed bipartite assignment graph — the buffer contract for a future WASM matcher.
 * Layout (little-endian):
 *   u32 n
 *   for x in 0..n:
 *     u32 degree
 *     for each edge: u32 y, u32 piece, f64 cost
 *
 * The JS matcher remains the correctness oracle. Compile matching_kernel.c with
 *   node solvers/dual_cube/build_wasm.mjs
 * The packed layout below is the frozen ABI the WASM kernel consumes.
 */
import { minCostPerfectMatchingJS } from './exact_cover_kernel.mjs';

export function packEdges(edges) {
  let bytes = 4;
  for (const list of edges) bytes += 4 + list.length * (4 + 4 + 8);
  const buf = new ArrayBuffer(bytes);
  const view = new DataView(buf);
  let o = 0;
  view.setUint32(o, edges.length, true);
  o += 4;
  for (const list of edges) {
    view.setUint32(o, list.length, true);
    o += 4;
    for (const e of list) {
      view.setUint32(o, e.y, true);
      o += 4;
      view.setUint32(o, e.piece, true);
      o += 4;
      view.setFloat64(o, e.cost, true);
      o += 8;
    }
  }
  return buf;
}

export function unpackEdges(buf) {
  const view = new DataView(buf);
  let o = 0;
  const n = view.getUint32(o, true);
  o += 4;
  const edges = Array.from({ length: n }, () => []);
  for (let x = 0; x < n; x++) {
    const deg = view.getUint32(o, true);
    o += 4;
    for (let i = 0; i < deg; i++) {
      const y = view.getUint32(o, true);
      o += 4;
      const piece = view.getUint32(o, true);
      o += 4;
      const cost = view.getFloat64(o, true);
      o += 8;
      edges[x].push({ y, piece, cost });
    }
  }
  return edges;
}

/** Reference implementation of the WASM matching entry point. */
export function matchPackedGraph(buf) {
  const t0 = performance.now();
  const match = minCostPerfectMatchingJS(unpackEdges(buf));
  return { match, ms: performance.now() - t0, backend: 'js-reference' };
}
