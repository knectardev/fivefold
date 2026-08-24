/**
 * Physical boundary-patch correspondence across Cube A and Cube B.
 * Canonical object: physical piece + A partner + B partner + connected component.
 * Mixed Cube B contacts are subdivided rather than rejected.
 *
 *   node solvers/dual_cube/physical_correspondence.mjs solvers/dual_cube/results/candidate_N8_P8.json
 *   node solvers/dual_cube/physical_correspondence.mjs --regression solvers/dual_cube/results/candidate_N6_P8.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  parseCandidate,
  idx,
  transformVoxel,
  transformDirection,
  inverseIndexPoint,
  inverseTransformVoxel,
  rotTranspose,
  ROT,
  applyRot,
  cadEligibility,
} from './json_contract.mjs';
import { connectedComponents, fragileVoxelRatio } from './exact_cover_kernel.mjs';
import { fitPlane, sub, cross, dot } from './plane_only.mjs';
import { selectJointSurface } from './joint_quadrics.mjs';
import { fitOpeningsBatched } from './gpu_fit_cpu.mjs';
import { insertCarriersTransactional } from './insert_carriers.mjs';
import { searchTrimBranches } from './trim_branches.mjs';
import { buildJunctionGraph, buildClosureReport } from './analytic_junctions.mjs';
import { buildClosureView } from './closure_view.mjs';

const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const PLANE_TOL = 0.018;
const MAJORITY = 0.8;
const EXTERIOR = -1;

function inBounds(v, N) {
  return v[0] >= 0 && v[1] >= 0 && v[2] >= 0 && v[0] < N && v[1] < N && v[2] < N;
}

function partnerAt(labels, v, d, N) {
  const w = [v[0] + d[0], v[1] + d[1], v[2] + d[2]];
  if (!inBounds(w, N)) return EXTERIOR;
  return labels[idx(w[0], w[1], w[2], N)];
}

function faceCorners(v, d) {
  const axis = d[0] ? 0 : d[1] ? 1 : 2;
  const origin = [...v];
  if (d[axis] > 0) origin[axis] += 1;
  const a = (axis + 1) % 3;
  const b = (axis + 2) % 3;
  const corners = [];
  for (const s0 of [0, 1]) {
    for (const s1 of [0, 1]) {
      const p = [...origin];
      p[a] += s0;
      p[b] += s1;
      corners.push(p);
    }
  }
  const keys = corners.map((p) => p.join(','));
  const edges = [];
  const order = [0, 1, 3, 2];
  for (let i = 0; i < 4; i++) {
    const A = keys[order[i]];
    const B = keys[order[(i + 1) % 4]];
    edges.push(A < B ? `${A}|${B}` : `${B}|${A}`);
  }
  return { corners, keys, edges };
}

function faceCenterIndex(v, d) {
  return [v[0] + 0.5 + 0.5 * d[0], v[1] + 0.5 + 0.5 * d[1], v[2] + 0.5 + 0.5 * d[2]];
}

function collectFaces(labels, piece, N) {
  const faces = [];
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (labels[idx(x, y, z, N)] !== piece) continue;
        const v = [x, y, z];
        for (const d of DIRS) {
          const p = partnerAt(labels, v, d, N);
          if (p === piece) continue;
          const geom = faceCorners(v, d);
          const center = faceCenterIndex(v, d);
          faces.push({
            v,
            d,
            partner: p,
            center,
            ...geom,
          });
        }
      }
    }
  }
  return faces;
}

function connectedFaceGroups(faces) {
  const edgeMap = new Map();
  faces.forEach((f, i) => {
    for (const e of f.edges) {
      if (!edgeMap.has(e)) edgeMap.set(e, []);
      edgeMap.get(e).push(i);
    }
  });
  const adj = Array.from({ length: faces.length }, () => []);
  for (const ids of edgeMap.values()) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        adj[ids[i]].push(ids[j]);
        adj[ids[j]].push(ids[i]);
      }
    }
  }
  const seen = new Uint8Array(faces.length);
  const groups = [];
  for (let i = 0; i < faces.length; i++) {
    if (seen[i]) continue;
    const q = [i];
    seen[i] = 1;
    const comp = [];
    for (let h = 0; h < q.length; h++) {
      const u = q[h];
      comp.push(faces[u]);
      for (const v of adj[u]) {
        if (seen[v]) continue;
        seen[v] = 1;
        q.push(v);
      }
    }
    groups.push(comp);
  }
  return groups;
}

function partnerName(p) {
  return p === EXTERIOR ? 'exterior' : p + 1;
}

function signedVoxelVolume(faces, N) {
  let vol = 0;
  for (const f of faces) {
    const c = f.corners.map((p) => p.map((x) => x / N));
    const tris = [[c[0], c[1], c[3]], [c[0], c[3], c[2]]];
    for (const t of tris) {
      vol += dot(t[0], cross(sub(t[1], t[0]), sub(t[2], t[0]))) / 6;
    }
  }
  return Math.abs(vol);
}

function nonmanifoldEdges(faces) {
  const count = new Map();
  for (const f of faces) {
    for (const e of f.edges) count.set(e, (count.get(e) || 0) + 1);
  }
  return [...count.entries()].filter(([, c]) => c > 2).map(([e]) => e);
}

function makePatchRecord(comp, k, aPartner, bPartner, cand, N, planeTol, id) {
  const samplesA = [];
  const samplesJoint = [];
  for (const f of comp) {
    samplesA.push(f.center.map((x) => x / N));
    const cB = f.vB && f.dB ? faceCenterIndex(f.vB, f.dB) : faceCenterIndex(f.v, f.d);
    const back = inverseIndexPoint(cB, cand.placements[k], N);
    samplesJoint.push(back.map((x) => x / N));
  }
  const plane = fitPlane(samplesA);
  const kind = aPartner === EXTERIOR ? 'cube-exterior' : (plane.rms <= planeTol ? 'planar-mate' : 'curved');
  return {
    id,
    piece: k + 1,
    faceLoop: `${k + 1}:${id}`,
    areaFaces: comp.length,
    cubeA: { mate: partnerName(aPartner), mateIndex: aPartner, unique: true },
    cubeB: {
      mate: partnerName(bPartner),
      mateIndex: bPartner,
      unique: true,
      majority: 1,
      distinctPartners: 1,
    },
    transform: { r: cand.placements[k].r, t: cand.placements[k].t },
    kind,
    planeRMS: plane.rms,
    origin: plane.origin,
    normal: plane.normal,
    samplesA,
    samplesJoint,
    adjacentPlanarHint: kind === 'planar-mate',
    ambiguous: false,
    rejectReason: null,
    subdivided: true,
    faceKeys: comp.map((f) => `${f.v.join(',')}:${f.d.join(',')}`),
    oppositeKeys: comp.map((f) => {
      const w = [f.v[0] + f.d[0], f.v[1] + f.d[1], f.v[2] + f.d[2]];
      return `${w.join(',')}:${-f.d[0]},${-f.d[1]},${-f.d[2]}`;
    }),
    faces: comp.map((f) => ({ v: f.v, d: f.d, edges: f.edges, corners: f.corners })),
  };
}

export function buildCorrespondence(raw, opts = {}) {
  const planeTol = opts.planeTol ?? PLANE_TOL;
  const minFaces = opts.minFaces ?? 1;
  const cand = parseCandidate(raw);
  const N = cand.gridResolution;
  const P = cand.pieceCount;
  const patches = [];
  const rejected = [];
  let nextId = 1;
  let subdividedGroups = 0;

  for (let k = 0; k < P; k++) {
    const facesA = collectFaces(cand.labelsA, k, N);
    for (const f of facesA) {
      const vB = transformVoxel(f.v, cand.placements[k], N);
      const dB = transformDirection(f.d, cand.placements[k]);
      f.vB = vB;
      f.dB = dB;
      if (!inBounds(vB, N)) {
        f.oob = true;
        f.bPartner = 'oob';
      } else {
        f.oob = false;
        f.bPartner = partnerAt(cand.labelsB, vB, dB, N);
      }
    }
    const bySig = new Map();
    for (const f of facesA) {
      const sig = `${f.partner}|${f.bPartner}`;
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig).push(f);
    }
    const aOnly = new Map();
    for (const f of facesA) {
      if (!aOnly.has(f.partner)) aOnly.set(f.partner, new Set());
      aOnly.get(f.partner).add(f.bPartner);
    }
    for (const set of aOnly.values()) if (set.size > 1) subdividedGroups++;

    for (const [sig, groupFaces] of bySig) {
      const [aStr, bStr] = sig.split('|');
      const aPartner = +aStr;
      for (const comp of connectedFaceGroups(groupFaces)) {
        const id = `S${nextId++}`;
        if (bStr === 'oob' || comp.some((f) => f.oob)) {
          rejected.push({
            id,
            piece: k + 1,
            kind: 'contradictory',
            cubeA: { mate: partnerName(aPartner), mateIndex: aPartner },
            cubeB: { mate: 'oob' },
            reason: 'transformed faces leave Cube B',
            areaFaces: comp.length,
          });
          continue;
        }
        const bPartner = +bStr;
        const nm = nonmanifoldEdges(comp);
        if (nm.length) {
          rejected.push({
            id,
            piece: k + 1,
            kind: 'nonmanifold',
            cubeA: { mate: partnerName(aPartner), mateIndex: aPartner },
            cubeB: { mate: partnerName(bPartner), mateIndex: bPartner },
            reason: `nonmanifold fragment (${nm.length} edges)`,
            areaFaces: comp.length,
          });
          continue;
        }
        if (comp.length < minFaces) {
          rejected.push({
            id,
            piece: k + 1,
            kind: 'too-small',
            cubeA: { mate: partnerName(aPartner), mateIndex: aPartner },
            cubeB: { mate: partnerName(bPartner), mateIndex: bPartner },
            reason: `fragment has ${comp.length} faces < ${minFaces}`,
            areaFaces: comp.length,
          });
          continue;
        }
        patches.push(makePatchRecord(comp, k, aPartner, bPartner, cand, N, planeTol, id));
      }
    }
  }

  for (const p of patches) {
    if (p.cubeA.mateIndex < 0) {
      p.cubeA.matePatch = null;
      continue;
    }
    const candidates = patches.filter((q) => q.piece === p.cubeA.mate && q.cubeA.mateIndex === p.piece - 1);
    const op = new Set(p.oppositeKeys);
    let best = null;
    let bestN = 0;
    for (const q of candidates) {
      let n = 0;
      for (const k of q.faceKeys) if (op.has(k)) n++;
      if (n > bestN) {
        best = q;
        bestN = n;
      }
    }
    if (!best || bestN / p.areaFaces < MAJORITY) {
      p.cubeA.matePatch = null;
      p.cubeA.mateOverlap = bestN;
    } else {
      p.cubeA.matePatch = best.id;
      p.cubeA.mateOverlap = bestN;
    }
  }

  const keyIndex = new Map();
  for (const p of patches) {
    for (const fk of p.faceKeys) keyIndex.set(`${p.piece}:${fk}`, p.id);
  }
  for (const p of patches) {
    if (p.cubeB.mateIndex < 0) {
      p.cubeB.matePatch = null;
      continue;
    }
    const counts = new Map();
    const plK = cand.placements[p.piece - 1];
    const plM = cand.placements[p.cubeB.mateIndex];
    for (const f of p.faces) {
      const vB = transformVoxel(f.v, plK, N);
      const dB = transformDirection(f.d, plK);
      const wB = [vB[0] + dB[0], vB[1] + dB[1], vB[2] + dB[2]];
      if (!inBounds(wB, N)) continue;
      const dOpp = [-dB[0], -dB[1], -dB[2]];
      const vA = inverseTransformVoxel(wB, plM, N);
      const dA = applyRot(dOpp, rotTranspose(ROT[plM.r])).map((x) => Math.round(x));
      const hit = keyIndex.get(`${p.cubeB.mate}:${vA.join(',')}:${dA.join(',')}`);
      if (hit) counts.set(hit, (counts.get(hit) || 0) + 1);
    }
    let best = null;
    let bestN = 0;
    for (const [id, n] of counts) {
      if (n > bestN) {
        best = id;
        bestN = n;
      }
    }
    p.cubeB.matePatch = bestN / p.areaFaces >= MAJORITY ? best : null;
  }

  const still = [];
  for (const p of patches) {
    if (p.ambiguous) rejected.push(p);
    else still.push(p);
  }

  return {
    schema: 'dual-cube-physical-correspondence',
    version: 1,
    gridResolution: N,
    pieceCount: P,
    planeTolerance: planeTol,
    patches: still,
    rejected: rejected.map((p) => ({
      id: p.id,
      piece: p.piece,
      kind: p.kind,
      cubeA: p.cubeA,
      cubeB: p.cubeB,
      reason: p.rejectReason,
      areaFaces: p.areaFaces,
    })),
    counts: {
      accepted: still.length,
      rejected: rejected.length,
      curved: still.filter((p) => p.kind === 'curved').length,
      planar: still.filter((p) => p.kind === 'planar-mate').length,
      exterior: still.filter((p) => p.kind === 'cube-exterior').length,
      partnerSignatureSplits: subdividedGroups,
    },
  };
}

function jointPoints(patch, all) {
  const pts = [...patch.samplesA, ...patch.samplesJoint];
  const mateId = patch.cubeA.matePatch;
  if (typeof mateId === 'string') {
    const mate = all.find((p) => p.id === mateId);
    if (mate) pts.push(...mate.samplesA);
  }
  return pts;
}

export function fitCorrespondingPatches(correspondence, opts = {}) {
  const planeTol = opts.planeTol ?? PLANE_TOL;
  const fits = [];
  for (const patch of correspondence.patches) {
    if (patch.kind !== 'curved') continue;
    const points = jointPoints(patch, correspondence.patches);
    const result = selectJointSurface(points, planeTol);
    fits.push({
      patch: patch.id,
      piece: patch.piece,
      cubeA: patch.cubeA,
      cubeB: patch.cubeB,
      sampleCount: points.length,
      planeRMS: result.planeRMS,
      chosen: result.chosen ? {
        type: result.chosen.type,
        rms: result.chosen.rms,
        params: result.chosen.params,
        score: result.chosen.score,
        center: result.chosen.center,
        radius: result.chosen.radius,
        axis: result.chosen.axis,
        point: result.chosen.point,
        apex: result.chosen.apex,
        angle: result.chosen.angle,
        coefficients: result.chosen.coefficients,
      } : null,
      tried: result.tried,
    });
  }
  return fits;
}

export function pieceVolumeReport(raw, correspondence, fits) {
  const cand = parseCandidate(raw);
  const N = cand.gridResolution;
  const P = cand.pieceCount;
  const fitted = new Set(fits.filter((f) => f.chosen).map((f) => f.patch));
  const rows = [];
  for (let k = 0; k < P; k++) {
    const comps = connectedComponents(cand.labelsA, k, N);
    const sourceVoxelVolume = comps.total / (N * N * N);
    const faces = collectFaces(cand.labelsA, k, N);
    const piecePatches = correspondence.patches.filter((p) => p.piece === k + 1);
    const covered = piecePatches.filter((p) => p.kind !== 'curved' || fitted.has(p.id));
    const coveredFaces = covered.reduce((n, p) => n + p.areaFaces, 0);
    const analyticShellVolume = faces.length
      ? signedVoxelVolume(faces, N) * (coveredFaces / faces.length)
      : 0;
    let failure = null;
    if (sourceVoxelVolume === 0 && analyticShellVolume === 0) failure = 'malformed-empty';
    else if (sourceVoxelVolume > 0 && analyticShellVolume === 0) failure = 'reconstruction-or-missing-coverage';
    rows.push({
      piece: k + 1,
      sourceVoxelVolume,
      analyticShellVolume,
      voxelCount: comps.total,
      voxelComponents: comps.comps,
      patches: piecePatches.length,
      fittedCurved: piecePatches.filter((p) => p.kind === 'curved' && fitted.has(p.id)).length,
      unfittedCurved: piecePatches.filter((p) => p.kind === 'curved' && !fitted.has(p.id)).length,
      failure,
    });
  }
  return rows;
}

function sourceCadMetrics(raw) {
  const parsed = parseCandidate(raw);
  const { N, pieceCount, labelsA } = parsed;
  const counts = new Array(pieceCount).fill(0);
  for (const k of labelsA) counts[k]++;
  const components = [];
  for (let k = 0; k < pieceCount; k++) components.push(connectedComponents(labelsA, k, N));
  const connected = components.filter((c) => c.comps === 1).length;
  const n = N * N * N;
  return {
    counts,
    connected,
    components,
    minVol: n ? Math.min(...counts) / n : 0,
    fragileRatio: fragileVoxelRatio(labelsA, N),
  };
}

export function analyzePhysicalCorrespondence(raw, opts = {}) {
  const correspondence = buildCorrespondence(raw, opts);
  const topology = sourceCadMetrics(raw);
  const cad = cadEligibility(topology.counts, topology.counts.length, topology);
  const runCad = cad.cadEligible || opts.fitAnyway || opts.junctionsAnyway;
  const useBatched = runCad && (opts.batchedFit === true || (cad.cadEligible && opts.batchedFit !== false));
  let gpuFit = null;
  let insertion = null;
  let trimRepair = null;
  let branchOverrides = opts.branchOverrides || {};
  let fits = [];
  if (runCad) {
    if (useBatched) {
      gpuFit = fitOpeningsBatched(correspondence, opts);
      insertion = insertCarriersTransactional(raw, correspondence, gpuFit.fits);
      fits = insertion.fits;
      if (opts.trimSearch !== false) {
        trimRepair = searchTrimBranches(raw, correspondence, fits, {
          patchIds: opts.trimPatchIds,
          includeMate: opts.trimMate !== false,
        });
        branchOverrides = trimRepair.chosen.overrides;
      }
    } else {
      fits = fitCorrespondingPatches(correspondence, opts);
    }
  }
  const volumes = pieceVolumeReport(raw, correspondence, fits);
  const junctions = runCad
    ? buildJunctionGraph(raw, correspondence, fits, { branchOverrides })
    : null;
  const closure = runCad
    ? buildClosureReport(raw, correspondence, fits, volumes, { branchOverrides })
    : null;
  return {
    schema: 'dual-cube-physical-correspondence-report',
    version: 3,
    rhinoReady: false,
    cadEligible: cad.cadEligible,
    cadQueue: cad.cadQueue,
    cadRole: cad.cadRole,
    cadBlockers: cad.reasons,
    cadWarnings: cad.warnings,
    gpuFit: gpuFit && {
      backend: 'cpu',
      engine: 'batched',
      openings: gpuFit.openingCount,
      jobs: gpuFit.jobCount,
      selected: gpuFit.selectedCount,
      inserted: insertion?.acceptedCount ?? 0,
      rolledBack: insertion?.rejectedCount ?? 0,
      note: 'Packed opening × family × initialization residuals. CPU inserts carriers transactionally. WebGPU scores the same buffer when navigator.gpu is present; CPU is the oracle.',
    },
    insertion: insertion && {
      proposedCount: insertion.proposedCount,
      acceptedCount: insertion.acceptedCount,
      rejectedCount: insertion.rejectedCount,
      accepted: insertion.accepted,
      rejected: insertion.rejected,
      baseline: insertion.baseline,
      final: trimRepair?.chosen.metrics ?? insertion.final,
      openEdges: trimRepair?.openEdges ?? insertion.openEdges,
      carrierStatus: trimRepair?.carrierStatus ?? insertion.carrierStatus,
      trimRepair: trimRepair && {
        overrides: trimRepair.chosen.overrides,
        baseline: trimRepair.baseline,
        chosen: trimRepair.chosen.metrics,
        cubeB: trimRepair.chosen.cubeB,
        diagnostics: trimRepair.diagnostics.map((d) => ({
          patch: d.patch,
          family: d.family,
          incidentPlanarIds: d.incidentPlanarIds,
          fittedUntrimmed: d.fittedUntrimmed,
          adjacencies: d.adjacencies.map((a) => ({
            planeId: a.planeId,
            missing: a.missing,
            selectedBranchId: a.selectedBranchId,
            rejected: a.rejected,
            branches: a.branches.map((b) => ({
              id: b.id,
              component: b.component,
              orientation: b.orientation,
              clip: b.clip,
              accept: b.accept,
              reason: b.reason,
              voxelScore: b.voxelScore,
              matchedEndpoints: b.endpoints.matched,
            })),
          })),
        })),
      },
    },
    note: 'Canonical patches are trim regions on frozen physical-piece carriers. Mixed Cube B contacts are subdivided, then consolidated onto shared analytic surfaces when they agree geometrically. Junctions and shell stitching stay on the CPU. Batched sphere/cylinder/cone/quadric residuals use a packed ABI; WebGPU is optional.',
    correspondence: {
      ...correspondence,
      patches: correspondence.patches.map((p) => ({
        id: p.id,
        piece: p.piece,
        faceLoop: p.faceLoop,
        kind: p.kind,
        areaFaces: p.areaFaces,
        cubeA: p.cubeA,
        cubeB: p.cubeB,
        planeRMS: p.planeRMS,
        origin: p.origin,
        normal: p.normal,
        carrier: closure?.carriers.items.find((c) => c.regions.some((r) => r.patch === p.id))?.id || null,
      })),
    },
    jointFits: fits,
    junctions,
    closure: closure && {
      schema: closure.schema,
      version: closure.version,
      note: closure.note,
      metrics: closure.metrics,
      carriers: closure.carriers,
      assemblies: closure.assemblies,
      pieces: closure.pieces,
      junctions: closure.junctions,
      trims: closure.trims,
      audit: closure.audit,
      gate: closure.gate,
    },
    volumes,
    gate: {
      correspondenceUnambiguous: correspondence.rejected.length === 0,
      everyPieceNonempty: cad.emptyPieces.length === 0,
      everyPieceConnected: cad.disconnectedPieces.length === 0 && topology.connected === topology.counts.length,
      voxelVsAnalytic: volumes.map((v) => ({
        piece: v.piece,
        sourceVoxelVolume: v.sourceVoxelVolume,
        analyticShellVolume: v.analyticShellVolume,
        failure: v.failure,
      })),
      allCurvedFitted: cad.cadEligible && fits.length > 0 && fits.every((f) => f.chosen),
      analyticTrimsPresent: !!junctions && junctions.trims.some((t) => t.intersection?.analytic),
      cubeAClosed: !!closure?.gate.cubeAClosed,
      cubeBClosed: !!closure?.gate.cubeBClosed,
      bothAssembliesClosed: !!closure?.gate.bothAssembliesClosed,
      assembliesClosed: !!closure?.gate.bothAssembliesClosed,
      rhinoReady: false,
    },
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const jsonArg = process.argv.find((a) => a.endsWith('.json') && !a.includes('correspondence') && !a.includes('shell') && !a.startsWith('--'));
if (isMain && jsonArg) {
  const raw = JSON.parse(readFileSync(jsonArg, 'utf8'));
  const regression = process.argv.includes('--regression');
  const report = analyzePhysicalCorrespondence(raw, regression
    ? { fitAnyway: true, junctionsAnyway: true }
    : {});
  const arg = jsonArg;
  const out = arg.replace(/\.json$/i, '.correspondence.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  if (report.closure) {
    const closureOut = arg.replace(/\.json$/i, '.closure.json');
    writeFileSync(closureOut, JSON.stringify(report.closure, null, 2));
  }
  if (report.cadEligible && report.insertion?.trimRepair?.overrides) {
    writeFileSync(arg.replace(/\.json$/i, '.trim_overrides.json'), JSON.stringify({
      schema: 'dual-cube-trim-overrides',
      version: 1,
      overrides: report.insertion.trimRepair.overrides,
    }, null, 2));
  }
  if (report.cadEligible && report.closure) {
    const view = buildClosureView(raw, report);
    writeFileSync(arg.replace(/\.json$/i, '.closure_view.json'), JSON.stringify(view));
  }
  console.log(JSON.stringify({
    input: arg,
    output: out,
    cadEligible: report.cadEligible,
    cadQueue: report.cadQueue,
    accepted: report.correspondence.counts.accepted,
    rejected: report.correspondence.counts.rejected,
    splits: report.correspondence.counts.partnerSignatureSplits,
    carriers: report.closure?.carriers.carrierCount ?? 0,
    curved: report.correspondence.counts.curved,
    fitted: report.jointFits.filter((f) => f.chosen).length,
    unfitted: report.jointFits.filter((f) => !f.chosen).length,
    families: report.jointFits.filter((f) => f.chosen).reduce((m, f) => {
      m[f.chosen.type] = (m[f.chosen.type] || 0) + 1;
      return m;
    }, {}),
    gpuFit: report.gpuFit,
    insertion: report.insertion && {
      proposedCount: report.insertion.proposedCount,
      acceptedCount: report.insertion.acceptedCount,
      baseline: report.insertion.baseline,
      final: report.insertion.final,
      openEdges: {
        openEdges: report.insertion.openEdges?.openEdges,
        explainedByUnresolvedOpening: report.insertion.openEdges?.explainedByUnresolvedOpening,
        explainedByFittedUntrimmed: report.insertion.openEdges?.explainedByFittedUntrimmed,
        unexplainedCount: report.insertion.openEdges?.unexplainedCount,
      },
      carrierStatus: report.insertion.carrierStatus,
    },
    trimOverrides: report.insertion?.trimRepair?.overrides ?? null,
    junctionByCarrierCount: report.closure?.junctions.byCarrierCount ?? null,
    analyticTrims: report.closure?.trims.analytic ?? 0,
    trims: report.closure?.trims ?? null,
    junctionRMS: report.closure?.junctions.rms ?? null,
    junctionMax: report.closure?.junctions.max ?? null,
    metrics: report.closure?.metrics ?? null,
    cubeBVoxel: report.closure?.audit
      ? {
        rms: report.closure.audit.cubeB.voxelRms,
        max: report.closure.audit.cubeB.voxelMax,
        geometricRms: report.closure.audit.cubeB.geometricRms,
        geometricMax: report.closure.audit.cubeB.geometricMax,
      }
      : null,
    frozenSolve: report.closure?.audit
      ? {
        initialRms: report.closure.audit.frozenSolve.initialRms,
        finalRms: report.closure.audit.frozenSolve.finalRms,
        finalMax: report.closure.audit.frozenSolve.finalMax,
        incompatible: report.closure.audit.frozenSolve.incompatibleCount,
      }
      : null,
    worstB: report.closure?.audit?.cubeB.worst10.slice(0, 5) ?? [],
    assemblies: report.closure?.assemblies ?? null,
    pieces: report.closure?.pieces.map((p) => ({
      piece: p.piece,
      openEdges: p.openEdges,
      nonmanifold: p.nonmanifoldEdges,
      shells: p.shells,
      shellsBefore: p.shellsBeforeDissolve,
      volumePositive: p.volumePositive,
      connectedSolid: p.connectedSolid,
      openings: p.unresolvedCurvedOpenings,
    })) ?? [],
    gate: report.closure?.gate ?? report.gate,
    empty: report.volumes.filter((v) => v.failure === 'malformed-empty').map((v) => v.piece),
    rhinoReady: report.rhinoReady,
  }, null, 2));
}
