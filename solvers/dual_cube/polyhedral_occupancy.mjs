/**
 * Canonical dual-cube polyhedral occupancy: one Cube-A atom list per piece.
 * Cube B is always derived. Same-owner splits collapse to whole cells.
 */
import {
  idx,
  unidx,
  transformVoxel,
  inverseTransformVoxel,
  parseCandidate,
} from './json_contract.mjs';
import {
  HALF_VOLUME,
  FULL_VOLUME,
  complementHalf,
  halfIndex,
  rotateHalfByR,
  splitHalf,
  atomsFaceConnected,
  atomVolume,
} from './half_cells.mjs';

export const POLY_SCHEMA = 'dual-cube-polyhedral-candidate';
export const POLY_VERSION = 1;

const FACE = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

export function labelsOf(candidate, which) {
  if (which === 'A') return candidate.labelsA || candidate.labelsA;
  return candidate.labelsB || candidate.labelsB;
}

export function inBounds(v, N) {
  return v[0] >= 0 && v[1] >= 0 && v[2] >= 0 && v[0] < N && v[1] < N && v[2] < N;
}

export function voxelToPolyhedral(candidate) {
  if (candidate?.schema === POLY_SCHEMA && Array.isArray(candidate.pieces)) {
    return candidate;
  }
  const parsed = candidate.labelsA && candidate.placements
    ? candidate
    : parseCandidate(candidate);
  const N = parsed.gridResolution ?? parsed.N;
  const P = parsed.pieceCount;
  const labelsA = parsed.labelsA || parsed.labelsA;
  const placements = parsed.placements;
  const pieces = Array.from({ length: P }, (_, id) => ({
    id,
    transformB: { r: placements[id].r, t: [...placements[id].t] },
    atoms: [],
  }));
  for (let i = 0; i < labelsA.length; i++) {
    const k = labelsA[i];
    pieces[k].atoms.push({ kind: 'full', cell: unidx(i, N) });
  }
  return {
    schema: POLY_SCHEMA,
    version: POLY_VERSION,
    gridResolution: N,
    N,
    pieceCount: P,
    pieces,
    seed: {
      schema: parsed.schema,
      N,
      pieceCount: P,
      placements: placements.map((p) => ({ r: p.r, t: [...p.t] })),
    },
  };
}

export function normalizeAtoms(atoms) {
  const byCell = new Map();
  for (const atom of atoms) {
    const key = atom.cell.join(',');
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(atom);
  }
  const out = [];
  for (const group of byCell.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const halves = group.filter((a) => a.kind === 'half');
    const fulls = group.filter((a) => a.kind === 'full');
    if (fulls.length) {
      out.push(fulls[0]);
      continue;
    }
    if (
      halves.length === 2
      && halves[0].plane === halves[1].plane
      && halves[0].side !== halves[1].side
    ) {
      out.push({ kind: 'full', cell: halves[0].cell });
      continue;
    }
    out.push(...group);
  }
  return out;
}

export function transformAtom(atom, placement, N) {
  const cell = transformVoxel(atom.cell, placement, N);
  if (atom.kind === 'full') return { kind: 'full', cell };
  const h = rotateHalfByR(halfIndex(atom.plane, atom.side), placement.r);
  const { planeIdx, side } = splitHalf(h);
  return { kind: 'half', cell, plane: planeIdx, side };
}

export function atomsForCube(pieces, which, N) {
  const out = [];
  for (const piece of pieces) {
    const src = which === 'B'
      ? piece.atoms.map((a) => transformAtom(a, piece.transformB, N))
      : piece.atoms;
    for (const atom of src) out.push({ ...atom, piece: piece.id });
  }
  return out;
}

function emptyOccupancy(N) {
  return Array.from({ length: N * N * N }, () => null);
}

export function occupancyFromAtoms(atoms, N) {
  const occ = emptyOccupancy(N);
  const reasons = [];
  for (const atom of atoms) {
    if (!inBounds(atom.cell, N)) {
      reasons.push(`atom out of bounds ${atom.cell}`);
      continue;
    }
    const i = idx(...atom.cell, N);
    const cur = occ[i];
    if (atom.kind === 'full') {
      if (cur) reasons.push(`overlap full at ${atom.cell}`);
      else occ[i] = { kind: 'full', owner: atom.piece };
      continue;
    }
    const h = halfIndex(atom.plane, atom.side);
    if (!cur) {
      occ[i] = { kind: 'split', plane: atom.plane, owners: [null, null] };
      occ[i].owners[atom.side] = atom.piece;
      continue;
    }
    if (cur.kind === 'full') {
      reasons.push(`full/half overlap at ${atom.cell}`);
      continue;
    }
    if (cur.plane !== atom.plane) {
      reasons.push(`mixed planes at ${atom.cell}`);
      continue;
    }
    if (cur.owners[atom.side] != null) {
      reasons.push(`duplicate half at ${atom.cell}`);
      continue;
    }
    cur.owners[atom.side] = atom.piece;
    if (cur.owners[0] === cur.owners[1] && cur.owners[0] != null) {
      occ[i] = { kind: 'full', owner: cur.owners[0] };
    }
  }
  for (let i = 0; i < occ.length; i++) {
    const cell = occ[i];
    if (!cell) {
      reasons.push(`uncovered cell ${unidx(i, N)}`);
      continue;
    }
    if (cell.kind === 'split' && (cell.owners[0] == null || cell.owners[1] == null)) {
      reasons.push(`unpaired half at ${unidx(i, N)}`);
    }
    if (cell.kind === 'split' && cell.owners[0] === cell.owners[1]) {
      reasons.push(`same-owner split at ${unidx(i, N)}`);
    }
  }
  return { occupancy: occ, reasons, ok: reasons.length === 0 };
}

export function verifyPolyhedralClosure(doc) {
  const N = doc.gridResolution ?? doc.N;
  const P = doc.pieceCount;
  const reasons = [];
  if (!doc.pieces || doc.pieces.length !== P) reasons.push('piece count mismatch');
  for (const piece of doc.pieces || []) {
    piece.atoms = normalizeAtoms(piece.atoms);
  }
  const aAtoms = atomsForCube(doc.pieces, 'A', N);
  const bAtoms = atomsForCube(doc.pieces, 'B', N);
  const coverA = occupancyFromAtoms(aAtoms, N);
  const coverB = occupancyFromAtoms(bAtoms, N);
  if (!coverA.ok) reasons.push(...coverA.reasons.map((r) => `A: ${r}`));
  if (!coverB.ok) reasons.push(...coverB.reasons.map((r) => `B: ${r}`));
  const volumes = [];
  const componentsA = [];
  const componentsB = [];
  for (const piece of doc.pieces) {
    const vol = piece.atoms.reduce((s, a) => s + atomVolume(a), 0);
    volumes.push(vol);
    componentsA.push(countComponents(piece.atoms));
    const bAtomsK = piece.atoms.map((a) => transformAtom(a, piece.transformB, N));
    componentsB.push(countComponents(bAtomsK));
    if (vol <= 0) reasons.push(`piece ${piece.id} has non-positive volume`);
    if (componentsA.at(-1) !== 1) reasons.push(`piece ${piece.id} is not face-connected in Cube A`);
    if (componentsB.at(-1) !== componentsA.at(-1)) {
      reasons.push(`piece ${piece.id} Cube B component count ${componentsB.at(-1)} != A ${componentsA.at(-1)} (transform regression)`);
    }
  }
  const volSum = volumes.reduce((s, v) => s + v, 0);
  if (Math.abs(volSum - N * N * N) > 1e-9) reasons.push(`volume sum ${volSum} != ${N ** 3}`);
  return {
    ok: reasons.length === 0,
    reasons,
    coverA: coverA.ok,
    coverB: coverB.ok,
    volumes,
    componentsA,
    componentsB,
    splitCellCount: countSplits(coverA.occupancy),
  };
}

function countSplits(occ) {
  let n = 0;
  for (const cell of occ) if (cell && cell.kind === 'split') n++;
  return n;
}

export function atomComponents(atoms) {
  if (!atoms.length) return [];
  const seen = new Uint8Array(atoms.length);
  const groups = [];
  for (let i = 0; i < atoms.length; i++) {
    if (seen[i]) continue;
    const q = [i];
    seen[i] = 1;
    for (let h = 0; h < q.length; h++) {
      const u = q[h];
      for (let v = 0; v < atoms.length; v++) {
        if (seen[v]) continue;
        if (atomsFaceConnected(atoms[u], atoms[v])) {
          seen[v] = 1;
          q.push(v);
        }
      }
    }
    groups.push(q.map((ix) => atoms[ix]));
  }
  return groups;
}

export function countComponents(atoms) {
  return atomComponents(atoms).length;
}

export function interfaceCells(labels, N) {
  const n = labels.length;
  const mark = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = unidx(i, N);
    const k = labels[i];
    for (const d of FACE) {
      const v = [x + d[0], y + d[1], z + d[2]];
      if (!inBounds(v, N)) continue;
      if (labels[idx(...v, N)] !== k) {
        mark[i] = 1;
        break;
      }
    }
  }
  return mark;
}

export function dualEligibleMask(candidate) {
  const parsed = candidate.labelsA || candidate.gridResolution ? candidate : parseCandidate(candidate);
  const N = parsed.gridResolution ?? parsed.N;
  const labelsA = parsed.labelsA || parsed.labelsA;
  const labelsB = parsed.labelsB || parsed.labelsB;
  const placements = parsed.placements;
  const aIface = interfaceCells(labelsA, N);
  const bIface = interfaceCells(labelsB, N);
  const eligible = new Uint8Array(labelsA.length);
  for (let i = 0; i < eligible.length; i++) if (aIface[i]) eligible[i] = 1;
  for (let y = 0; y < bIface.length; y++) {
    if (!bIface[y]) continue;
    const k = labelsB[y];
    const src = inverseTransformVoxel(unidx(y, N), placements[k], N);
    if (inBounds(src, N)) eligible[idx(...src, N)] = 1;
  }
  return { eligible, aIface, bIface, N, labelsA, labelsB, placements };
}

export function haloMask(eligible, N) {
  const n = eligible.length;
  const halo = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!eligible[i]) continue;
    halo[i] = 1;
    const [x, y, z] = unidx(i, N);
    for (const d of FACE) {
      const v = [x + d[0], y + d[1], z + d[2]];
      if (!inBounds(v, N)) continue;
      halo[idx(...v, N)] = 1;
    }
  }
  return halo;
}

export function allowedOwners(labelsA, i, N) {
  const set = new Set([labelsA[i]]);
  const [x, y, z] = unidx(i, N);
  for (const d of FACE) {
    const v = [x + d[0], y + d[1], z + d[2]];
    if (!inBounds(v, N)) continue;
    set.add(labelsA[idx(...v, N)]);
  }
  return [...set];
}

export function allCellsEligible(N) {
  return new Uint8Array(N * N * N).fill(1);
}

export function destValidOwners(dest, i, P) {
  const out = [];
  for (let k = 0; k < P; k++) if (dest[k][i] >= 0) out.push(k);
  return out;
}

export function applyCellStates(seedDoc, states, N) {
  const P = seedDoc.pieceCount;
  const pieces = Array.from({ length: P }, (_, id) => ({
    id,
    transformB: seedDoc.pieces[id].transformB,
    atoms: [],
  }));
  const n = N * N * N;
  for (let i = 0; i < n; i++) {
    const cell = unidx(i, N);
    const st = states[i];
    if (!st || st.kind === 'full') {
      const owner = st ? st.owner : seedOwner(seedDoc, i);
      pieces[owner].atoms.push({ kind: 'full', cell });
    } else {
      if (st.owners[0] === st.owners[1]) {
        pieces[st.owners[0]].atoms.push({ kind: 'full', cell });
      } else {
        pieces[st.owners[0]].atoms.push({
          kind: 'half', cell, plane: st.plane, side: 0,
        });
        pieces[st.owners[1]].atoms.push({
          kind: 'half', cell, plane: st.plane, side: 1,
        });
      }
    }
  }
  for (const p of pieces) p.atoms = normalizeAtoms(p.atoms);
  return {
    ...seedDoc,
    pieces,
  };
}

function seedOwner(seedDoc, i) {
  const N = seedDoc.N;
  const cell = unidx(i, N);
  for (const piece of seedDoc.pieces) {
    for (const atom of piece.atoms) {
      if (atom.kind === 'full'
        && atom.cell[0] === cell[0]
        && atom.cell[1] === cell[1]
        && atom.cell[2] === cell[2]) return piece.id;
    }
  }
  throw new Error(`no seed owner for cell ${cell}`);
}

export function statesFromDoc(doc) {
  const N = doc.N;
  const n = N * N * N;
  const states = Array.from({ length: n }, () => null);
  for (const piece of doc.pieces) {
    for (const atom of piece.atoms) {
      const i = idx(...atom.cell, N);
      if (atom.kind === 'full') {
        states[i] = { kind: 'full', owner: piece.id };
      } else if (!states[i] || states[i].kind === 'full') {
        const owners = [null, null];
        owners[atom.side] = piece.id;
        states[i] = { kind: 'split', plane: atom.plane, owners };
      } else {
        states[i].owners[atom.side] = piece.id;
      }
    }
  }
  return states;
}

export { complementHalf, FACE, HALF_VOLUME, FULL_VOLUME };
