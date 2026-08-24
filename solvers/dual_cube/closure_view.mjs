/**
 * Normalize correspondence + closure into display buffers for the diagnostic viewer.
 * The browser must not reimplement intersection geometry.
 */
import { parseCandidate, idx } from './json_contract.mjs';
import { buildCorrespondence } from './physical_correspondence.mjs';
import { topologyMetrics, attributeOpenEdges, surfaceOfPatch } from './analytic_junctions.mjs';
import { add, scale, sub, cross, unit } from './plane_only.mjs';

const PIECE_COLORS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
  '#1abc9c', '#3498db', '#9b59b6', '#fd79a8',
];
const FAMILY_COLOR = {
  plane: '#9aa0a6',
  cylinder: '#4fc3f7',
  cone: '#ffb74d',
  sphere: '#81c784',
  generalQuadric: '#ce93d8',
  'unfitted-curved': '#ef9a9a',
};

function latticeUnit(p, N) {
  return [p[0] / N, p[1] / N, p[2] / N];
}

function mean(pts) {
  const n = pts.length || 1;
  return [
    pts.reduce((s, p) => s + p[0], 0) / n,
    pts.reduce((s, p) => s + p[1], 0) / n,
    pts.reduce((s, p) => s + p[2], 0) / n,
  ];
}

function pushQuad(positions, a, b, c, d) {
  positions.push(...a, ...b, ...c, ...a, ...c, ...d);
}

function cylinderMesh(cyl, t0, t1, segs = 12, stacks = 6) {
  const axis = unit(cyl.axis);
  const ref = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(axis, ref));
  const v = unit(cross(axis, u));
  const positions = [];
  for (let i = 0; i < stacks; i++) {
    const aT = t0 + ((t1 - t0) * i) / stacks;
    const bT = t0 + ((t1 - t0) * (i + 1)) / stacks;
    for (let j = 0; j < segs; j++) {
      const a0 = (j / segs) * Math.PI * 2;
      const a1 = ((j + 1) / segs) * Math.PI * 2;
      const ring = (t, ang) => add(
        add(cyl.point, scale(axis, t)),
        add(scale(u, cyl.radius * Math.cos(ang)), scale(v, cyl.radius * Math.sin(ang))),
      );
      pushQuad(positions, ring(aT, a0), ring(aT, a1), ring(bT, a1), ring(bT, a0));
    }
  }
  return positions;
}

function planeMesh(origin, normal, size = 0.22) {
  const n = unit(normal);
  const ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(n, ref));
  const v = unit(cross(n, u));
  const a = add(origin, add(scale(u, -size), scale(v, -size)));
  const b = add(origin, add(scale(u, size), scale(v, -size)));
  const c = add(origin, add(scale(u, size), scale(v, size)));
  const d = add(origin, add(scale(u, -size), scale(v, size)));
  const positions = [];
  pushQuad(positions, a, b, c, d);
  return positions;
}

export function buildClosureView(raw, report) {
  const cand = parseCandidate(raw);
  const N = cand.gridResolution;
  const correspondence = buildCorrespondence(raw);
  const fits = report.jointFits || [];
  const overrides = report.insertion?.trimRepair?.overrides || {};
  const state = topologyMetrics(raw, correspondence, fits, { branchOverrides: overrides });
  const attr = attributeOpenEdges(state);
  const patchById = new Map(correspondence.patches.map((p) => [p.id, p]));
  const fitById = new Map(fits.map((f) => [f.patch, f]));
  const pieceCentroid = new Map();
  const voxels = [];
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const pieceA = cand.labelsA[idx(x, y, z, N)];
        const c = [(x + 0.5) / N, (y + 0.5) / N, (z + 0.5) / N];
        if (pieceA) {
          voxels.push({ piece: pieceA, cell: [x, y, z], position: c, assembly: 'A' });
          if (!pieceCentroid.has(pieceA)) pieceCentroid.set(pieceA, []);
          pieceCentroid.get(pieceA).push(c);
        }
        const pieceB = cand.labelsB[idx(x, y, z, N)];
        if (pieceB) {
          voxels.push({ piece: pieceB, cell: [x, y, z], position: c, assembly: 'B' });
        }
      }
    }
  }
  const centroids = new Map([...pieceCentroid.entries()].map(([k, pts]) => [k, mean(pts)]));

  const patches = correspondence.patches.map((p) => {
    const positions = [];
    for (const f of p.faces || []) {
      const c = (f.corners || []).map((q) => latticeUnit(q, N));
      if (c.length >= 4) pushQuad(positions, c[0], c[1], c[2], c[3]);
      else if (c.length === 3) positions.push(...c[0], ...c[1], ...c[2]);
    }
    const fit = fitById.get(p.id);
    const surf = surfaceOfPatch(p, fit);
    const status = (report.insertion?.carrierStatus || []).find((s) => s.patch === p.id);
    return {
      id: p.id,
      piece: p.piece,
      kind: p.kind,
      family: surf.type,
      color: p.kind === 'curved' ? (FAMILY_COLOR[surf.type] || '#ccc') : PIECE_COLORS[(p.piece - 1) % 8],
      origin: p.origin,
      normal: p.normal,
      positions,
      acceptedGeometry: !!fit?.chosen,
      trimComplete: status?.trimComplete ?? (p.kind !== 'curved'),
      areaFaces: p.areaFaces,
    };
  });

  const carriers = [];
  for (const p of correspondence.patches) {
    const fit = fitById.get(p.id);
    const surf = surfaceOfPatch(p, fit);
    const corners = [];
    for (const f of p.faces || []) for (const c of f.corners || []) corners.push(latticeUnit(c, N));
    let positions = [];
    if (surf.type === 'cylinder' && surf.axis && corners.length) {
      const along = corners.map((q) => dotAxis(q, surf));
      positions = cylinderMesh(surf, Math.min(...along), Math.max(...along));
    } else if (surf.type === 'plane' || p.kind !== 'curved') {
      positions = planeMesh(p.origin, p.normal, 0.18);
    } else {
      positions = planeMesh(p.origin, p.normal, 0.14);
    }
    carriers.push({
      id: p.id,
      piece: p.piece,
      type: surf.type,
      color: FAMILY_COLOR[surf.type] || '#ccc',
      positions,
    });
  }

  const resolvedTrims = [];
  const openEdgeLines = [];
  for (const t of state.trims) {
    const samples = t.intersection?.samples;
    if (samples?.length >= 2 && t.intersection.kind !== 'open-unfitted') {
      resolvedTrims.push({
        id: `${t.a}|${t.b}`,
        piece: t.piece,
        a: t.a,
        b: t.b,
        kind: t.intersection.kind,
        chosenBranchId: t.chosenBranchId,
        points: samples,
      });
    }
  }
  for (const row of state.unmatched) {
    const [a, b] = row.key.split('|');
    const pa = patchById.get(a);
    const pb = patchById.get(b);
    const pts = [];
    const ea = new Set((pa?.faces || []).flatMap((f) => f.edges || []));
    for (const f of pb?.faces || []) {
      for (const e of f.edges || []) {
        if (!ea.has(e)) continue;
        const [p0, p1] = e.split('|').map((s) => latticeUnit(s.split(',').map(Number), N));
        pts.push(p0, p1);
      }
    }
    openEdgeLines.push({
      id: row.key,
      piece: row.piece,
      a, b,
      points: pts,
      openings: [pa, pb].filter((p) => p?.kind === 'curved' && !fitById.get(p.id)?.chosen).map((p) => p.id),
    });
  }

  const openings = correspondence.patches.filter((p) => p.kind === 'curved' && !fitById.get(p.id)?.chosen).map((p) => {
    const loop = [];
    for (const f of p.faces || []) {
      for (const c of f.corners || []) loop.push(latticeUnit(c, N));
    }
    return { id: p.id, piece: p.piece, points: loop };
  });

  const residualVectors = (report.closure?.junctions?.worst || []).slice(0, 48).map((j) => ({
    id: j.id,
    piece: j.piece,
    origin: j.point || [0, 0, 0],
    magnitude: j.incidenceMax || 0,
    carrierCount: j.incidentCarrierCount,
  }));

  const shells = (report.closure?.pieces || []).flatMap((p) => (p.shellMembers || []).map((s) => {
    const pts = [];
    for (const id of s.patchIds) {
      const patch = patchById.get(id);
      for (const f of patch?.faces || []) for (const c of f.corners || []) pts.push(latticeUnit(c, N));
    }
    const c = pts.length ? mean(pts) : centroids.get(p.piece) || [0.5, 0.5, 0.5];
    const home = centroids.get(p.piece) || c;
    const explode = scale(sub(c, home), 0.55);
    return {
      id: `piece${p.piece}-shell${s.id}`,
      piece: p.piece,
      shell: s.id,
      patchIds: s.patchIds,
      explode,
      closed: p.openEdges === 0 && p.shells === 1,
    };
  }));

  const assemblies = {
    A: { offset: [0, 0, 0] },
    B: { offset: [3.25, 0, 0] },
  };

  return {
    schema: 'dual-cube-closure-view',
    version: 1,
    note: 'Display buffers only. Intersection topology was decided on the CPU.',
    N,
    colors: { pieces: PIECE_COLORS, families: FAMILY_COLOR },
    assemblies,
    pieceCentroids: Object.fromEntries([...centroids.entries()]),
    voxels,
    patches,
    carriers,
    resolvedTrims,
    openEdges: openEdgeLines,
    openings,
    residualVectors,
    shells,
    summary: {
      openEdges: attr.openEdges,
      explainedByUnresolvedOpening: attr.explainedByUnresolvedOpening,
      explainedByFittedUntrimmed: attr.explainedByFittedUntrimmed,
      unexplainedCount: attr.unexplainedCount,
      nonmanifold: state.nonmanifold,
      pieces: report.closure?.pieces?.map((p) => ({
        piece: p.piece,
        shells: p.shells,
        openEdges: p.openEdges,
        connectedSolid: p.connectedSolid,
      })),
      carrierStatus: report.insertion?.carrierStatus || [],
    },
    visibilityGroups: [
      'voxels', 'analytic', 'resolvedTrims', 'openEdges', 'openings', 'residuals',
      'explodePieces', 'explodeShells',
    ],
  };
}

function dotAxis(q, surf) {
  return (q[0] - (surf.point?.[0] || 0)) * surf.axis[0]
    + (q[1] - (surf.point?.[1] || 0)) * surf.axis[1]
    + (q[2] - (surf.point?.[2] || 0)) * surf.axis[2];
}
