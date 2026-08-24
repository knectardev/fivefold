/**
 * Classify multi-shell pieces: disconnected vs cavity vs reconstruction defect.
 */
import { parseCandidate } from './json_contract.mjs';
import { connectedComponents } from './exact_cover_kernel.mjs';
import { sub, cross, dot } from './plane_only.mjs';

function signedVolume(faces, N) {
  let vol = 0;
  for (const f of faces) {
    const c = (f.corners || []).map((p) => p.map((x) => x / N));
    if (c.length < 4) continue;
    const tris = [[c[0], c[1], c[3]], [c[0], c[3], c[2]]];
    for (const t of tris) {
      vol += dot(t[0], cross(sub(t[1], t[0]), sub(t[2], t[0]))) / 6;
    }
  }
  return vol;
}

function bboxOf(faces, N) {
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  let n = 0;
  for (const f of faces) {
    for (const c of f.corners || []) {
      const p = c.map((x) => x / N);
      n++;
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], p[i]);
        hi[i] = Math.max(hi[i], p[i]);
      }
    }
  }
  return n ? { lo, hi } : null;
}

function bboxContains(outer, inner, pad = 1e-6) {
  if (!outer || !inner) return false;
  return inner.lo.every((v, i) => v >= outer.lo[i] - pad) && inner.hi.every((v, i) => v <= outer.hi[i] + pad);
}

function bboxDisjoint(a, b) {
  if (!a || !b) return true;
  return a.hi.some((v, i) => v < b.lo[i] - 1e-6) || b.hi.some((v, i) => v < a.lo[i] - 1e-6);
}

function interpret(voxelComps, shells) {
  if (voxelComps > 1 && shells.length > 1) return 'candidate-genuinely-disconnected';
  if (voxelComps === 1 && shells.length === 1) return 'single-shell';
  if (voxelComps === 1 && shells.length === 2) {
    const [a, b] = [...shells].sort((x, y) => Math.abs(y.signedVolume) - Math.abs(x.signedVolume));
    const nested = (bboxContains(a.bbox, b.bbox) || bboxContains(b.bbox, a.bbox))
      && Math.sign(a.signedVolume) * Math.sign(b.signedVolume) < 0;
    if (nested) return 'connected-solid-with-cavity';
    if (bboxDisjoint(a.bbox, b.bbox)) return 'reconstruction-topology-defect';
    return 'weak-edge-or-point-connection';
  }
  if (voxelComps === 1 && shells.length > 2) return 'reconstruction-topology-defect';
  return 'unclassified';
}

export function classifyPieceShells(raw, correspondence, pieceStats) {
  const cand = parseCandidate(raw);
  const N = cand.gridResolution;
  const out = [];
  for (const st of pieceStats) {
    if (![1, 5].includes(st.piece) && (st.shells || 0) <= 1) continue;
    const k = st.piece - 1;
    const voxel = connectedComponents(cand.labelsA, k, N);
    const members = st.shellMembers || [];
    const patchById = new Map(correspondence.patches.filter((p) => p.piece === st.piece).map((p) => [p.id, p]));
    const shells = members.map((m) => {
      const faces = m.patchIds.flatMap((id) => patchById.get(id)?.faces || []);
      const vol = signedVolume(faces, N);
      return {
        id: m.id,
        patches: m.patchIds.length,
        signedVolume: vol,
        orientation: vol > 0 ? 'positive' : vol < 0 ? 'negative' : 'zero',
        bbox: bboxOf(faces, N),
      };
    });
    const kind = interpret(voxel.comps, shells);
    out.push({
      piece: st.piece,
      sourceVoxelComponents: voxel.comps,
      sourceVoxelCount: voxel.total,
      shellCount: st.shells,
      shells,
      interpretation: kind,
    });
  }
  return out;
}
