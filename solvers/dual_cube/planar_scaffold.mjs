/**
 * Trimmed open-shell CAD representation.
 * Oriented face graph of cube exteriors, planar mates, and curved openings.
 * Convex half-space cells are not used. Quadrics are not fitted yet.
 *
 *   node solvers/dual_cube/planar_scaffold.mjs solvers/dual_cube/results/candidate_N8_P8.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseCandidate, applyRot, ROT } from './json_contract.mjs';
import { connectedComponents } from './exact_cover_kernel.mjs';
import {
  idx,
  sub,
  scale,
  dot,
  norm,
  unit,
  fitPlane,
  extractInterfaces,
  connectedPatches,
} from './plane_only.mjs';

const PLANE_TOL = 0.018;
const COPLANAR_DOT = 0.98;
const CURVED_DOT = 0.55;
const CURVED_NEAR = 2;
const MIN_THICKNESS = 0.04;
const MIN_VOLUME = 0.05;

function latticeToUnit(p, N) {
  return [p[0] / N, p[1] / N, p[2] / N];
}

function projectToPlane(p, origin, normal) {
  return sub(p, scale(normal, dot(sub(p, origin), normal)));
}

function undirected(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function traceBoundaryLoops(faces) {
  const edgeCount = new Map();
  for (const f of faces) {
    for (let i = 0; i < 4; i++) {
      const k = undirected(f.keys[i], f.keys[(i + 1) % 4]);
      edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
    }
  }
  const adj = new Map();
  const addAdj = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.get(a).includes(b)) adj.get(a).push(b);
  };
  for (const f of faces) {
    for (let i = 0; i < 4; i++) {
      const a = f.keys[i];
      const b = f.keys[(i + 1) % 4];
      if (edgeCount.get(undirected(a, b)) !== 1) continue;
      addAdj(a, b);
      addAdj(b, a);
    }
  }
  const used = new Set();
  const loops = [];
  for (const [start, nbs] of adj) {
    for (const nb of nbs) {
      const ek0 = undirected(start, nb);
      if (used.has(ek0)) continue;
      const loop = [start];
      let prev = start;
      let cur = nb;
      used.add(ek0);
      while (cur !== start) {
        loop.push(cur);
        const options = adj.get(cur) || [];
        const next = options.find((v) => v !== prev && !used.has(undirected(cur, v)))
          || options.find((v) => v === start && loop.length >= 3)
          || options.find((v) => v !== prev);
        if (!next) break;
        used.add(undirected(cur, next));
        prev = cur;
        cur = next;
        if (loop.length > 20000) break;
      }
      if (cur === start && loop.length >= 3) loops.push(loop);
    }
  }
  return { loops, boundaryEdges: [...edgeCount.entries()].filter(([, c]) => c === 1).map(([k]) => k) };
}

function compatiblePlanes(a, b, planeTol, coplanarDot) {
  if (Math.abs(dot(a.normal, b.normal)) < coplanarDot) return false;
  return Math.abs(dot(sub(b.origin, a.origin), a.normal)) <= planeTol;
}

function patchesShareVertex(a, b) {
  const keys = new Set(a.faces.flatMap((f) => f.keys));
  return b.faces.some((f) => f.keys.some((k) => keys.has(k)));
}

function patchesNear(a, b, cheb) {
  for (const fa of a.faces) {
    for (const fb of b.faces) {
      const d = Math.max(
        Math.abs(fa.cell[0] - fb.cell[0]),
        Math.abs(fa.cell[1] - fb.cell[1]),
        Math.abs(fa.cell[2] - fb.cell[2]),
      );
      if (d <= cheb) return true;
    }
  }
  return false;
}

function mergeInterfacePatches(patches, planeTol, coplanarDot, curvedDot) {
  const n = patches.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[a] = b;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (patches[i].lo !== patches[j].lo || patches[i].hi !== patches[j].hi) continue;
      const bothPlanar = patches[i].planar && patches[j].planar;
      const bothCurved = !patches[i].planar && !patches[j].planar;
      if (bothPlanar && compatiblePlanes(patches[i].plane, patches[j].plane, planeTol, coplanarDot)) {
        union(i, j);
        continue;
      }
      if (bothCurved && Math.abs(dot(patches[i].plane.normal, patches[j].plane.normal)) >= curvedDot) {
        if (patchesShareVertex(patches[i], patches[j]) || patchesNear(patches[i], patches[j], CURVED_NEAR)) {
          union(i, j);
        }
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(patches[i]);
  }
  return [...groups.values()];
}

function annotateState(labels, N, planeTol) {
  const faces = extractInterfaces(labels, N);
  const raw = connectedPatches(faces);
  return raw.map((p, i) => {
    const plane = fitPlane(p.points);
    return {
      lo: p.lo,
      hi: p.hi,
      faces: p.faces,
      points: p.points,
      plane,
      planar: plane.rms <= planeTol,
      id: `${p.lo}-${p.hi}:${i}`,
    };
  });
}

function orientPlane(plane, faces) {
  let votes = 0;
  for (const f of faces) {
    const axisDir = [0, 0, 0];
    axisDir[f.axis] = 1;
    const fromLoToHi = f.a === f.lo ? 1 : -1;
    votes += fromLoToHi * dot(plane.normal, axisDir);
  }
  const n = [...plane.normal];
  if (votes < 0) {
    n[0] *= -1;
    n[1] *= -1;
    n[2] *= -1;
  }
  return { origin: plane.origin, normal: unit(n), rms: plane.rms };
}

function canonicalInterfaces(patches, N, planeTol, coplanarDot, curvedDot) {
  const merged = mergeInterfacePatches(patches, planeTol, coplanarDot, curvedDot);
  const records = [];
  for (const group of merged) {
    const sample = group[0];
    const faces = group.flatMap((g) => g.faces);
    const allPlanar = group.every((g) => g.planar);
    const plane = fitPlane(faces.map((f) => f.center));
    const oriented = orientPlane(plane, faces);
    const { loops, boundaryEdges } = traceBoundaryLoops(faces);
    const projected = loops.map((loop) =>
      loop.map((key) => {
        const L = key.split(',').map(Number);
        return projectToPlane(latticeToUnit(L, N), oriented.origin, oriented.normal);
      }),
    );
    records.push({
      pair: `${sample.lo}-${sample.hi}`,
      pieces: [sample.lo + 1, sample.hi + 1],
      lo: sample.lo,
      hi: sample.hi,
      kind: allPlanar ? 'planar' : 'curved',
      sourcePatches: group.length,
      areaFaces: faces.length,
      planeRMS: plane.rms,
      origin: oriented.origin,
      normal: oriented.normal,
      oppositeNormal: scale(oriented.normal, -1),
      loops: projected,
      loopVertexCounts: loops.map((l) => l.length),
      boundaryEdges,
      faces,
    });
  }
  return records;
}

function extractExteriorFaces(labels, N, piece) {
  const faces = [];
  const specs = [
    { pred: (x) => x === 0, corners: (x, y, z) => [[0, y, z], [0, y + 1, z], [0, y + 1, z + 1], [0, y, z + 1]], n: [1, 0, 0], origin: [0, 0, 0], name: 'x0' },
    { pred: (x, y, z) => x === N - 1, corners: (x, y, z) => [[N, y, z], [N, y, z + 1], [N, y + 1, z + 1], [N, y + 1, z]], n: [-1, 0, 0], origin: [1, 0, 0], name: 'x1' },
    { pred: (x, y) => y === 0, corners: (x, y, z) => [[x, 0, z], [x, 0, z + 1], [x + 1, 0, z + 1], [x + 1, 0, z]], n: [0, 1, 0], origin: [0, 0, 0], name: 'y0' },
    { pred: (x, y) => y === N - 1, corners: (x, y, z) => [[x, N, z], [x + 1, N, z], [x + 1, N, z + 1], [x, N, z + 1]], n: [0, -1, 0], origin: [0, 1, 0], name: 'y1' },
    { pred: (x, y, z) => z === 0, corners: (x, y, z) => [[x, y, 0], [x + 1, y, 0], [x + 1, y + 1, 0], [x, y + 1, 0]], n: [0, 0, 1], origin: [0, 0, 0], name: 'z0' },
    { pred: (x, y, z) => z === N - 1, corners: (x, y, z) => [[x, y, N], [x, y + 1, N], [x + 1, y + 1, N], [x + 1, y, N]], n: [0, 0, -1], origin: [0, 0, 1], name: 'z1' },
  ];
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (labels[idx(x, y, z, N)] !== piece) continue;
        for (const spec of specs) {
          if (!spec.pred(x, y, z)) continue;
          const corners = spec.corners(x, y, z);
          const keys = corners.map((p) => p.join(','));
          const edges = keys.map((k, i) => undirected(k, keys[(i + 1) % 4]));
          faces.push({
            name: spec.name,
            n: spec.n,
            origin: spec.origin,
            corners,
            keys,
            edges,
            cell: [x, y, z],
          });
        }
      }
    }
  }
  return faces;
}

function minVoxelThickness(labels, N) {
  let minT = Infinity;
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let i = 0; i < labels.length; i++) {
    const k = labels[i];
    const x = i % N;
    const y = Math.floor(i / N) % N;
    const z = Math.floor(i / (N * N));
    let dist = 0;
    let boundary = false;
    for (let s = 1; s < N; s++) {
      for (const d of dirs) {
        const X = x + d[0] * s;
        const Y = y + d[1] * s;
        const Z = z + d[2] * s;
        if (X < 0 || Y < 0 || Z < 0 || X >= N || Y >= N || Z >= N || labels[idx(X, Y, Z, N)] !== k) {
          boundary = true;
          dist = s;
          break;
        }
      }
      if (boundary) break;
    }
    if (boundary) minT = Math.min(minT, dist / N);
  }
  return Number.isFinite(minT) ? minT : 0;
}

function contactPairs(records) {
  return new Set(records.map((r) => r.pair));
}

function transformPoint(p, pl, N) {
  const L = [p[0] * N, p[1] * N, p[2] * N];
  const c = [L[0] - N / 2, L[1] - N / 2, L[2] - N / 2];
  const q = applyRot(c, ROT[pl.r]);
  return [(q[0] + N / 2 + pl.t[0]) / N, (q[1] + N / 2 + pl.t[1]) / N, (q[2] + N / 2 + pl.t[2]) / N];
}

function nonmanifoldEdges(faceLists) {
  const count = new Map();
  for (const faces of faceLists) {
    for (const f of faces) {
      for (const e of f.edges) count.set(e, (count.get(e) || 0) + 1);
    }
  }
  return [...count.entries()].filter(([, c]) => c > 2).map(([e]) => e);
}

function sharedBoundary(a, b) {
  const sa = new Set(a.boundaryEdges);
  return b.boundaryEdges.filter((e) => sa.has(e));
}

function pieceFaces(k, planar, curved, exteriors) {
  const faces = [];
  const byName = new Map();
  for (const f of exteriors) {
    if (!byName.has(f.name)) byName.set(f.name, []);
    byName.get(f.name).push(f);
  }
  for (const [name, list] of byName) {
    const { loops, boundaryEdges } = traceBoundaryLoops(list);
    faces.push({
      id: `cube:${k}:${name}`,
      kind: 'cube-exterior',
      open: false,
      surface: { type: 'plane', origin: list[0].origin, normal: scale(list[0].n, -1), name },
      pair: null,
      matePiece: null,
      areaFaces: list.length,
      loopCount: loops.length,
      boundaryEdges,
    });
  }
  for (const rec of planar) {
    if (rec.lo !== k && rec.hi !== k) continue;
    faces.push({
      id: `planar:${k}:${rec.pair}`,
      kind: 'planar-mate',
      open: false,
      surface: {
        type: 'plane',
        origin: rec.origin,
        normal: rec.lo === k ? rec.normal : rec.oppositeNormal,
      },
      pair: rec.pair,
      matePiece: rec.lo === k ? rec.hi + 1 : rec.lo + 1,
      areaFaces: rec.areaFaces,
      loopCount: rec.loops.length,
      boundaryEdges: rec.boundaryEdges,
    });
  }
  for (const rec of curved) {
    if (rec.lo !== k && rec.hi !== k) continue;
    faces.push({
      id: `curved:${k}:${rec.pair}:${faces.length}`,
      kind: 'curved-opening',
      open: true,
      surface: {
        type: 'unresolved-curved',
        origin: rec.origin,
        normal: rec.lo === k ? rec.normal : rec.oppositeNormal,
        planeRMS: rec.planeRMS,
      },
      pair: rec.pair,
      matePiece: rec.lo === k ? rec.hi + 1 : rec.lo + 1,
      areaFaces: rec.areaFaces,
      loopCount: rec.loops.length,
      boundaryEdges: rec.boundaryEdges,
    });
  }
  return faces;
}

function stitchShells(faces) {
  const n = faces.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const trims = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const shared = sharedBoundary(faces[i], faces[j]);
      if (!shared.length) continue;
      trims.push({ a: faces[i].id, b: faces[j].id, edges: shared.length });
      const pa = find(i);
      const pb = find(j);
      if (pa !== pb) parent[pa] = pb;
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(faces[i]);
  }
  const shells = [...groups.values()].map((group, idx) => {
    const count = new Map();
    for (const f of group) {
      for (const e of f.boundaryEdges) count.set(e, (count.get(e) || 0) + 1);
    }
    const boundary = [...count.entries()].filter(([, c]) => c === 1).map(([e]) => e);
    const nonmanifold = [...count.entries()].filter(([, c]) => c > 2).map(([e]) => e);
    const curvedEdges = new Set(group.filter((f) => f.open).flatMap((f) => f.boundaryEdges));
    const openBoundary = boundary.filter((e) => curvedEdges.has(e));
    const unexplainedBoundary = boundary.filter((e) => !curvedEdges.has(e));
    return {
      id: idx,
      faces: group.map((f) => f.id),
      faceCount: group.length,
      planarFaces: group.filter((f) => f.kind !== 'curved-opening').length,
      curvedOpenings: group.filter((f) => f.open).length,
      trimCount: trims.filter((t) => group.some((f) => f.id === t.a) && group.some((f) => f.id === t.b)).length,
      boundaryEdges: boundary.length,
      openBoundaryEdges: openBoundary.length,
      unexplainedBoundaryEdges: unexplainedBoundary.length,
      nonmanifoldEdges: nonmanifold.length,
      closed: boundary.length === 0,
      manifold: nonmanifold.length === 0,
    };
  });
  return { shells, trims };
}

function scaffoldForState(labels, N, pieceCount, planeTol, coplanarDot, curvedDot) {
  const patches = annotateState(labels, N, planeTol);
  const interfaces = canonicalInterfaces(patches, N, planeTol, coplanarDot, curvedDot);
  const planar = interfaces.filter((r) => r.kind === 'planar');
  const curved = interfaces.filter((r) => r.kind === 'curved');
  const pieces = [];
  const disconnected = [];
  const empty = [];
  for (let k = 0; k < pieceCount; k++) {
    const comps = connectedComponents(labels, k, N);
    if (comps.total === 0) empty.push({ piece: k + 1 });
    else if (comps.comps !== 1) disconnected.push({ piece: k + 1, components: comps.comps });
    const exteriors = extractExteriorFaces(labels, N, k);
    const faces = pieceFaces(k, planar, curved, exteriors);
    const { shells, trims } = stitchShells(faces);
    const nm = nonmanifoldEdges([exteriors, ...planar.filter((r) => r.lo === k || r.hi === k).map((r) => r.faces)]);
    pieces.push({
      piece: k + 1,
      voxelCount: comps.total,
      voxelVolume: comps.total / (N * N * N),
      voxelComponents: comps.comps,
      empty: comps.total === 0,
      exteriorFaces: exteriors.length,
      exteriorGroups: [...new Set(exteriors.map((f) => f.name))],
      analyticFaces: faces.length,
      planarMates: planar.filter((r) => r.lo === k || r.hi === k).length,
      curvedOpenings: curved.filter((r) => r.lo === k || r.hi === k).length,
      shells: shells.length,
      closedShells: shells.filter((s) => s.closed).length,
      openShells: shells.filter((s) => !s.closed).length,
      manifold: shells.every((s) => s.manifold) && nm.length === 0,
      trimCurves: trims.length,
      unexplainedBoundaryEdges: shells.reduce((n, s) => n + s.unexplainedBoundaryEdges, 0),
      openBoundaryEdges: shells.reduce((n, s) => n + s.openBoundaryEdges, 0),
      nonmanifoldEdges: nm.length,
      shellSummary: shells,
    });
  }
  return {
    patches,
    interfaces,
    planar,
    curved,
    pieces,
    disconnected,
    empty,
    curvedSourcePatches: patches.filter((p) => !p.planar).length,
    planarSourcePatches: patches.filter((p) => p.planar).length,
  };
}

export function buildPlanarScaffold(raw, opts = {}) {
  const planeTol = opts.planeTol ?? PLANE_TOL;
  const coplanarDot = opts.coplanarDot ?? COPLANAR_DOT;
  const curvedDot = opts.curvedDot ?? CURVED_DOT;
  const cand = parseCandidate(raw);
  const N = cand.gridResolution;
  const P = cand.pieceCount;
  const A = scaffoldForState(cand.labelsA, N, P, planeTol, coplanarDot, curvedDot);
  const B = scaffoldForState(cand.labelsB, N, P, planeTol, coplanarDot, curvedDot);

  const pairsA = contactPairs(A.interfaces);
  const pairsB = contactPairs(B.interfaces);
  const missingInB = [...pairsA].filter((p) => !pairsB.has(p));
  const missingInA = [...pairsB].filter((p) => !pairsA.has(p));

  const oppositeOrientation = [];
  const duplicateFaces = [];
  for (const rec of A.planar) {
    oppositeOrientation.push({
      pair: rec.pair,
      loNormal: rec.normal,
      hiNormal: rec.oppositeNormal,
      antiparallel: Math.abs(dot(rec.normal, rec.oppositeNormal) + 1) < 1e-9,
    });
    const seen = new Set();
    for (const f of rec.faces) {
      const k = [...f.keys].sort().join(';');
      if (seen.has(k)) duplicateFaces.push({ pair: rec.pair, keys: k });
      seen.add(k);
    }
  }

  const unexplainedGaps = [];
  const otherBoundary = (rec) => {
    const edges = new Set();
    for (const other of A.interfaces) {
      if (other === rec) continue;
      for (const e of other.boundaryEdges) edges.add(e);
    }
    return edges;
  };
  for (const rec of A.planar) {
    const explained = otherBoundary(rec);
    for (const e of rec.boundaryEdges) {
      if (explained.has(e)) continue;
      const [a, b] = e.split('|');
      const cubeA = a.split(',').some((v) => +v === 0 || +v === N);
      const cubeB = b.split(',').some((v) => +v === 0 || +v === N);
      if (cubeA && cubeB) continue;
      unexplainedGaps.push({ pair: rec.pair, edge: e });
    }
  }

  const thicknessA = minVoxelThickness(cand.labelsA, N);
  const thicknessB = minVoxelThickness(cand.labelsB, N);
  const volumes = A.pieces.map((p) => p.voxelVolume);
  const minVol = Math.min(...volumes);
  const minVolFailures = A.pieces.filter((p) => p.voxelVolume < MIN_VOLUME).map((p) => p.piece);
  const emptyPieces = [...A.empty, ...B.empty.map((d) => ({ ...d, cube: 'B' }))];
  const nonempty = A.pieces.filter((p) => !p.empty);

  const dualLoopCorrespondence = A.interfaces.map((rec) => {
    const mates = B.interfaces.filter((b) => b.pair === rec.pair && b.kind === rec.kind);
    const areaB = mates.reduce((n, m) => n + m.areaFaces, 0);
    return {
      pair: rec.pair,
      kind: rec.kind,
      loopsA: rec.loops.length,
      loopsB: mates.reduce((n, m) => n + m.loops.length, 0),
      facesA: rec.areaFaces,
      facesB: areaB,
      presentInB: mates.length > 0,
    };
  });

  const transformedPlanes = A.planar.map((rec) => {
    const plo = cand.placements[rec.lo];
    const phi = cand.placements[rec.hi];
    const nLo = applyRot(rec.normal, ROT[plo.r]);
    const nHi = applyRot(rec.normal, ROT[phi.r]);
    const oLo = transformPoint(rec.origin, plo, N);
    const oHi = transformPoint(rec.origin, phi, N);
    return {
      pair: rec.pair,
      transformedNormalsDot: dot(unit(nLo), unit(nHi)),
      originSeparation: norm(sub(oLo, oHi)),
    };
  });

  const patchGraph = {
    canonicalPlanarInterfaces: A.planar.every((r) => r.loops.length >= 1),
    identicalSurfacesOppositeOrientation: oppositeOrientation.length === 0
      || oppositeOrientation.every((o) => o.antiparallel),
    cubeExteriorsPresent: A.pieces.every((p) => p.empty || p.exteriorFaces > 0)
      && B.pieces.every((p) => p.empty || p.exteriorFaces > 0),
    curvedOpenLoopsPaired: A.curved.every((c) => c.loops.length >= 1)
      && B.curved.every((c) => c.loops.length >= 1),
    noDuplicatePlanarFaces: duplicateFaces.length === 0,
    noUnexplainedGaps: unexplainedGaps.length === 0,
    noNonmanifoldPlanarJunctions: A.pieces.every((p) => p.nonmanifoldEdges === 0),
    dualAssemblyTopology: A.pieces.every((p, i) => p.voxelCount === B.pieces[i].voxelCount)
      && A.pieces.every((p) => p.empty || p.exteriorFaces > 0)
      && B.pieces.every((p) => p.empty || p.exteriorFaces > 0),
    shellsStitched: nonempty.every((p) => p.shells >= 1 && p.analyticFaces >= 1),
  };
  const patchReasons = [];
  if (!patchGraph.canonicalPlanarInterfaces) patchReasons.push('a planar interface is missing trim loops');
  if (!patchGraph.identicalSurfacesOppositeOrientation) patchReasons.push('a planar mate is not opposite-oriented on the two pieces');
  if (!patchGraph.cubeExteriorsPresent) patchReasons.push('a non-empty piece has no cube-exterior faces');
  if (!patchGraph.curvedOpenLoopsPaired) patchReasons.push('a curved region is missing an open boundary loop');
  if (!patchGraph.noDuplicatePlanarFaces) patchReasons.push(`${duplicateFaces.length} duplicate planar faces`);
  if (!patchGraph.noUnexplainedGaps) patchReasons.push(`${unexplainedGaps.length} unexplained planar boundary edges`);
  if (!patchGraph.noNonmanifoldPlanarJunctions) patchReasons.push('nonmanifold planar junctions');
  if (!patchGraph.dualAssemblyTopology) patchReasons.push('Cube A/B piece voxel counts or exteriors disagree');
  if (!patchGraph.shellsStitched) patchReasons.push('a non-empty piece has no stitched shell');

  const closed = nonempty.every((p) => p.curvedOpenings === 0 && p.closedShells === p.shells && p.openShells === 0);
  const connected = nonempty.every((p) => p.voxelComponents === 1 && p.shells === 1);
  const manifold = nonempty.every((p) => p.manifold);
  const solidFeasibility = {
    nonempty: emptyPieces.length === 0,
    connected,
    closed,
    manifold,
    minVolume: minVolFailures.length === 0,
    minThickness: Math.min(thicknessA, thicknessB) >= MIN_THICKNESS,
    gapFreeCubeA: false,
    gapFreeCubeB: false,
  };
  const solidReasons = [];
  if (!solidFeasibility.nonempty) {
    solidReasons.push(`empty piece(s): ${[...new Set(emptyPieces.map((e) => e.piece))].join(', ')}`);
  }
  if (!solidFeasibility.connected) solidReasons.push('a piece is disconnected or has multiple shells');
  if (!solidFeasibility.closed) solidReasons.push('shells still have unresolved curved openings');
  if (!solidFeasibility.manifold) solidReasons.push('a shell is nonmanifold');
  if (!solidFeasibility.minVolume) solidReasons.push(`piece(s) below ${100 * MIN_VOLUME}% volume: ${minVolFailures.join(', ')}`);
  if (!solidFeasibility.minThickness) solidReasons.push(`min thickness ${Math.min(thicknessA, thicknessB).toFixed(4)} < ${MIN_THICKNESS}`);
  solidReasons.push('Cube A/B gap-overlap not certified until shells are closed');

  const patchPassed = Object.values(patchGraph).every(Boolean);
  const solidPassed = Object.values(solidFeasibility).every(Boolean);

  return {
    schema: 'dual-cube-trimmed-shell',
    version: 1,
    gridResolution: N,
    pieceCount: P,
    representation: ['trimmed-open-shell', 'planar-scaffold', 'open-b-rep', 'analytic-patch-graph'],
    rhinoReady: false,
    note: 'Non-convex trimmed analytic shells with planar faces and explicit curved openings. Convex half-space cells are not used. Quadrics are not fitted yet. GPU compute is not used.',
    planeTolerance: planeTol,
    coplanarDot,
    curvedDot,
    cubeA: {
      planarInterfaces: A.planar.length,
      curvedRegions: A.curved.length,
      sourcePatches: A.patches.length,
      mergedPlanarFrom: A.planarSourcePatches,
      mergedCurvedFrom: A.curvedSourcePatches,
    },
    cubeB: {
      planarInterfaces: B.planar.length,
      curvedRegions: B.curved.length,
      sourcePatches: B.patches.length,
      mergedPlanarFrom: B.planarSourcePatches,
      mergedCurvedFrom: B.curvedSourcePatches,
    },
    interfaces: A.interfaces.map((r) => ({
      pair: r.pair,
      pieces: r.pieces,
      kind: r.kind,
      sourcePatches: r.sourcePatches,
      areaFaces: r.areaFaces,
      planeRMS: r.planeRMS,
      origin: r.origin,
      normal: r.normal,
      oppositeNormal: r.oppositeNormal,
      loopVertexCounts: r.loopVertexCounts,
      openLoops: r.kind === 'curved' ? r.loops.length : 0,
    })),
    pieces: A.pieces.map((p) => ({
      piece: p.piece,
      voxelCount: p.voxelCount,
      voxelVolume: p.voxelVolume,
      voxelComponents: p.voxelComponents,
      empty: p.empty,
      exteriorGroups: p.exteriorGroups,
      analyticFaces: p.analyticFaces,
      planarMates: p.planarMates,
      curvedOpenings: p.curvedOpenings,
      shells: p.shells,
      closedShells: p.closedShells,
      openShells: p.openShells,
      manifold: p.manifold,
      trimCurves: p.trimCurves,
      unexplainedBoundaryEdges: p.unexplainedBoundaryEdges,
      openBoundaryEdges: p.openBoundaryEdges,
      shellSummary: p.shellSummary,
    })),
    dualAssembly: {
      note: 'Voxel contact graphs of the two assemblies need not match; pieces rearrange. Dual topology here is per-piece voxel count, cube exteriors, and loop correspondence for pairs present in both cubes.',
      contactPairsA: [...pairsA],
      contactPairsB: [...pairsB],
      missingInB,
      missingInA,
      loopCorrespondence: dualLoopCorrespondence,
      transformedPlanarMates: transformedPlanes,
    },
    risks: {
      emptyPieces,
      disconnectedScaffolds: [...A.disconnected, ...B.disconnected.map((d) => ({ ...d, cube: 'B' }))],
      minVolume: minVol,
      minVolumeFailures: minVolFailures,
      minThickness: { cubeA: thicknessA, cubeB: thicknessB, limit: MIN_THICKNESS },
      thicknessRisk: Math.min(thicknessA, thicknessB) < MIN_THICKNESS,
    },
    gate: {
      patchGraph: { ...patchGraph, passed: patchPassed, reasons: patchReasons },
      solidFeasibility: { ...solidFeasibility, passed: solidPassed, reasons: solidReasons },
      identicalSurfacesOppositeOrientation: patchGraph.identicalSurfacesOppositeOrientation,
      dualAssemblyTopology: patchGraph.dualAssemblyTopology,
    },
    diagnostics: {
      oppositeOrientation,
      duplicateFaces: duplicateFaces.length,
      unexplainedGaps: unexplainedGaps.length,
    },
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const arg = process.argv[2];
if (isMain && arg && arg.endsWith('.json') && !arg.includes('scaffold') && !arg.includes('shell') && !arg.includes('plane-only')) {
  const raw = JSON.parse(readFileSync(arg, 'utf8'));
  const report = buildPlanarScaffold(raw);
  const out = arg.replace(/\.json$/i, '.shell.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    input: arg,
    output: out,
    planar: report.cubeA.planarInterfaces,
    curved: report.cubeA.curvedRegions,
    mergedPlanarFrom: report.cubeA.mergedPlanarFrom,
    mergedCurvedFrom: report.cubeA.mergedCurvedFrom,
    patchGraph: report.gate.patchGraph.passed,
    solidFeasibility: report.gate.solidFeasibility.passed,
    patchReasons: report.gate.patchGraph.reasons,
    solidReasons: report.gate.solidFeasibility.reasons,
    emptyPieces: report.risks.emptyPieces,
    disconnected: report.risks.disconnectedScaffolds.length,
    minVol: report.risks.minVolume,
    rhinoReady: report.rhinoReady,
  }, null, 2));
}
