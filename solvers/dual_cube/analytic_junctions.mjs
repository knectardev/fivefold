/**
 * Analytic trim curves, global junctions, and dual-assembly closure metrics.
 * Voxel adjacency selects the intersection branch; coordinates come from frozen carriers.
 * NURBS are not used. Surface parameters stay frozen until shells close.
 */
import { parseCandidate, transformGeometricPoint } from './json_contract.mjs';
import { sub, add, scale, dot, cross, norm, unit } from './plane_only.mjs';
import { consolidateCarriers } from './carrier_surfaces.mjs';
import {
  gradSurface,
  projectToCarriers,
  meanPoint,
  aabbOf,
  inAabb,
} from './surface_eval.mjs';
import { auditCubeBMates, solveFrozenMateFeasibility, aMateResiduals } from './mate_audit.mjs';
import { classifyPieceShells } from './shell_classify.mjs';

function latticeUnit(p, N) {
  return [p[0] / N, p[1] / N, p[2] / N];
}

function sharedEdgeKeys(a, b) {
  const sa = new Set();
  for (const f of a.faces || []) for (const e of f.edges || []) sa.add(e);
  const out = [];
  for (const f of b.faces || []) {
    for (const e of f.edges || []) if (sa.has(e)) out.push(e);
  }
  return [...new Set(out)];
}

function edgePoints(edge, N) {
  const [a, b] = edge.split('|');
  return [a.split(',').map(Number), b.split(',').map(Number)].map((p) => latticeUnit(p, N));
}

export function planePlaneLine(p1, p2) {
  const dir = cross(p1.normal, p2.normal);
  const mag = norm(dir);
  if (mag < 1e-10) return null;
  const n1 = p1.normal;
  const n2 = p2.normal;
  const d1 = dot(n1, p1.origin);
  const d2 = dot(n2, p2.origin);
  const u = unit(dir);
  const pt = scale(add(scale(cross(n2, u), d1), scale(cross(u, n1), d2)), 1 / mag);
  return { point: pt, direction: u };
}

function clipLineToPoints(line, points) {
  if (!line || !points.length) return null;
  const dir = unit(line.direction);
  const ts = points.map((p) => dot(sub(p, line.point), dir));
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  if (t1 - t0 < 1e-9) return null;
  const a = add(line.point, scale(dir, t0));
  const b = add(line.point, scale(dir, t1));
  return { a, b, length: t1 - t0, samples: [a, b] };
}

function clipLineToAabb(line, points, pad = 0.08) {
  if (!line || !points.length) return null;
  const box = aabbOf(points, pad);
  if (!box) return null;
  const p = line.point;
  const d = unit(line.direction);
  let tmin = -Infinity;
  let tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      if (p[i] < box.lo[i] || p[i] > box.hi[i]) return null;
      continue;
    }
    let ta = (box.lo[i] - p[i]) / d[i];
    let tb = (box.hi[i] - p[i]) / d[i];
    if (ta > tb) [ta, tb] = [tb, ta];
    tmin = Math.max(tmin, ta);
    tmax = Math.min(tmax, tb);
    if (tmin > tmax) return null;
  }
  if (!Number.isFinite(tmin) || !Number.isFinite(tmax) || tmax - tmin < 1e-9) {
    const mid = Number.isFinite(tmin) && Number.isFinite(tmax) ? 0.5 * (tmin + tmax) : 0;
    tmin = mid - pad;
    tmax = mid + pad;
  }
  const a = add(p, scale(d, tmin));
  const b = add(p, scale(d, tmax));
  return { a, b, length: tmax - tmin, samples: [a, b], padded: true };
}

function pointLineDistance(p, line) {
  const dir = unit(line.direction);
  const closest = add(line.point, scale(dir, dot(sub(p, line.point), dir)));
  return norm(sub(p, closest));
}

function meanSeedToLine(seeds, line) {
  if (!seeds.length) return Infinity;
  return Math.sqrt(seeds.reduce((s, p) => s + pointLineDistance(p, line) ** 2, 0) / seeds.length);
}

function meanSeedToSamples(seeds, samples) {
  if (!seeds.length || !samples?.length) return Infinity;
  let acc = 0;
  for (const s of seeds) {
    let best = Infinity;
    for (const q of samples) best = Math.min(best, norm(sub(s, q)));
    acc += best * best;
  }
  return Math.sqrt(acc / seeds.length);
}

function reverseHit(hit) {
  if (!hit) return null;
  return {
    ...hit,
    a: hit.b,
    b: hit.a,
    samples: hit.samples ? [...hit.samples].reverse() : hit.samples,
  };
}

export function adjacencyKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function makeBranchId(curvedId, planeId, spec) {
  return `${curvedId}__plane_${planeId}__${spec.component}__${spec.orientation}__${spec.clip}`;
}

export function planeSphereCircle(plane, sphere) {
  if (!sphere?.center || sphere.radius == null) return null;
  const d = dot(sub(sphere.center, plane.origin), plane.normal);
  const disc = sphere.radius ** 2 - d * d;
  if (disc < 0) return null;
  return {
    center: sub(sphere.center, scale(plane.normal, d)),
    radius: Math.sqrt(Math.max(0, disc)),
    normal: plane.normal,
  };
}

export function planeCylinderConic(plane, cyl) {
  if (!cyl?.axis || cyl.radius == null || !cyl.point) return null;
  const a = unit(cyl.axis);
  const n = unit(plane.normal);
  const ndota = dot(n, a);
  if (Math.abs(ndota) < 1e-8) {
    const dist = Math.abs(dot(sub(cyl.point, plane.origin), n));
    if (dist > cyl.radius + 1e-9) return null;
    const offset = Math.sqrt(Math.max(0, cyl.radius ** 2 - dist * dist));
    const toward = unit(cross(a, n));
    const foot = sub(cyl.point, scale(n, dot(sub(cyl.point, plane.origin), n)));
    return {
      kind: 'lines',
      direction: a,
      lines: offset < 1e-8
        ? [foot]
        : [add(foot, scale(toward, offset)), add(foot, scale(toward, -offset))],
    };
  }
  const t = -dot(sub(cyl.point, plane.origin), n) / ndota;
  const center = add(cyl.point, scale(a, t));
  const majorDir = unit(sub(a, scale(n, ndota)));
  const minorDir = unit(cross(n, majorDir));
  return {
    kind: 'ellipse',
    center,
    majorDir,
    minorDir,
    majorR: cyl.radius / Math.abs(ndota),
    minorR: cyl.radius,
    normal: n,
  };
}

function planeBasis(normal) {
  const n = unit(normal);
  const ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(n, ref));
  const v = unit(cross(n, u));
  return { n, u, v };
}

function coveringArc(angles) {
  if (!angles.length) return [0, 0];
  const sorted = [...angles].sort((x, y) => x - y);
  let gap = sorted[0] + Math.PI * 2 - sorted[sorted.length - 1];
  let gi = -1;
  for (let i = 0; i < sorted.length - 1; i++) {
    const g = sorted[i + 1] - sorted[i];
    if (g > gap) {
      gap = g;
      gi = i;
    }
  }
  if (gi < 0) return [sorted[0], sorted[sorted.length - 1]];
  return [sorted[gi + 1], sorted[gi] + Math.PI * 2];
}

function sampleArc(center, u, v, radius, t0, t1, n = 12) {
  const samples = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + (t1 - t0) * (i / n);
    samples.push(add(center, add(scale(u, radius * Math.cos(t)), scale(v, radius * Math.sin(t)))));
  }
  return samples;
}

function clipCircle(cir, seeds, { complement = false } = {}) {
  const { u, v } = planeBasis(cir.normal);
  const angs = seeds.map((p) => {
    const w = sub(p, cir.center);
    return Math.atan2(dot(w, v), dot(w, u));
  });
  let [t0, t1] = coveringArc(angs);
  if (complement) {
    const span = t1 - t0;
    t0 = t1;
    t1 = t0 + Math.max(1e-9, Math.PI * 2 - span);
  }
  const samples = sampleArc(cir.center, u, v, cir.radius, t0, t1);
  return { a: samples[0], b: samples[samples.length - 1], samples, center: cir.center, radius: cir.radius };
}

function clipEllipse(ell, seeds, { complement = false } = {}) {
  const angs = seeds.map((p) => {
    const w = sub(p, ell.center);
    return Math.atan2(dot(w, ell.minorDir) / (ell.minorR || 1e-9), dot(w, ell.majorDir) / (ell.majorR || 1e-9));
  });
  let [t0, t1] = coveringArc(angs);
  if (complement) {
    const span = t1 - t0;
    t0 = t1;
    t1 = t0 + Math.max(1e-9, Math.PI * 2 - span);
  }
  const samples = [];
  const n = 16;
  for (let i = 0; i <= n; i++) {
    const t = t0 + (t1 - t0) * (i / n);
    samples.push(add(ell.center, add(
      scale(ell.majorDir, ell.majorR * Math.cos(t)),
      scale(ell.minorDir, ell.minorR * Math.sin(t)),
    )));
  }
  return { a: samples[0], b: samples[samples.length - 1], samples };
}

function traceNumerical(s1, s2, seeds) {
  const box = aabbOf(seeds, 0.12);
  const start = projectToCarriers([s1, s2], meanPoint(seeds), { pull: 0.08 });
  if (!Number.isFinite(start.rms) || start.rms > 0.08) {
    const pts = seeds.map((s) => projectToCarriers([s1, s2], s, { pull: 0.2 }).point);
    return {
      kind: `${s1.type}-${s2.type}`,
      analytic: false,
      numerical: true,
      samples: pts,
      a: pts[0],
      b: pts[pts.length - 1],
    };
  }
  const samples = [start.point];
  const step = 0.025;
  for (const sign of [-1, 1]) {
    let x = start.point;
    const branch = [];
    for (let i = 0; i < 40; i++) {
      const tan = cross(gradSurface(s1, x), gradSurface(s2, x));
      if (norm(tan) < 1e-8) break;
      const nxt = projectToCarriers([s1, s2], add(x, scale(unit(tan), sign * step)), { pull: 0.04 });
      if (nxt.rms > 0.06 || !inAabb(nxt.point, box)) break;
      if (norm(sub(nxt.point, x)) < 1e-8) break;
      branch.push(nxt.point);
      x = nxt.point;
    }
    if (sign < 0) samples.unshift(...branch.reverse());
    else samples.push(...branch);
  }
  return {
    kind: `${s1.type}-${s2.type}`,
    analytic: s1.type !== 'generalQuadric' && s2.type !== 'generalQuadric',
    numerical: true,
    samples,
    a: samples[0],
    b: samples[samples.length - 1],
  };
}

function pushOriented(out, base, hit, voxelScore, extra = {}) {
  if (!hit) {
    out.push({
      component: extra.component,
      orientation: 'forward',
      clip: extra.clip || 'none',
      accept: false,
      reason: extra.reason || 'no-hit',
      voxelScore,
      hit: null,
      form: extra.form || null,
    });
    return;
  }
  for (const orientation of ['forward', 'reverse']) {
    const oriented = orientation === 'reverse' ? reverseHit(hit) : hit;
    out.push({
      component: extra.component,
      orientation,
      clip: extra.clip,
      accept: extra.accept !== false,
      reason: extra.reason || null,
      voxelScore,
      hit: {
        ...oriented,
        branchComponent: extra.component,
        branchOrientation: orientation,
        branchClip: extra.clip,
      },
      form: extra.form || hit.form || null,
    });
  }
}

export function enumerateIntersectionBranches(sa, sb, seedPts) {
  const out = [];
  if (!sa || !sb) {
    out.push({
      component: 'missing',
      orientation: 'forward',
      clip: 'none',
      accept: false,
      reason: 'missing-surface',
      voxelScore: Infinity,
      hit: null,
      form: null,
    });
    return out;
  }
  if (sa.type === 'unfitted-curved' || sb.type === 'unfitted-curved') {
    out.push({
      component: 'open_unfitted',
      orientation: 'forward',
      clip: 'none',
      accept: false,
      reason: 'open-unfitted',
      voxelScore: meanSeedToSamples(seedPts, seedPts),
      hit: { kind: 'open-unfitted', analytic: false, seeds: seedPts.length, samples: seedPts },
      form: null,
    });
    return out;
  }
  if (sa.type === 'plane' && sb.type === 'plane') {
    const line = planePlaneLine(sa, sb);
    const seg = clipLineToPoints(line, seedPts);
    if (seg) {
      pushOriented(out, sa, { kind: 'plane-plane', analytic: true, ...seg }, meanSeedToLine(seedPts, line), {
        component: 'plane_plane',
        clip: 'seed_clip',
        form: 'line',
      });
    } else {
      const pts = seedPts.map((s) => projectToCarriers([sa], s).point);
      pushOriented(out, sa, {
        kind: 'carrier-seam',
        analytic: true,
        coincident: true,
        samples: pts,
        a: pts[0],
        b: pts[pts.length - 1],
      }, meanSeedToSamples(seedPts, pts), { component: 'carrier_seam', clip: 'none', form: 'seam' });
    }
    return out;
  }
  const plane = sa.type === 'plane' ? sa : sb.type === 'plane' ? sb : null;
  const other = plane === sa ? sb : sa;
  if (plane && other.type === 'sphere') {
    const cir = planeSphereCircle(plane, other);
    if (!cir) {
      out.push({
        component: 'covering_arc',
        orientation: 'forward',
        clip: 'none',
        accept: false,
        reason: 'no-geometric-intersection',
        voxelScore: Infinity,
        hit: null,
        form: null,
      });
      return out;
    }
    const cov = clipCircle(cir, seedPts);
    const alt = clipCircle(cir, seedPts, { complement: true });
    pushOriented(out, plane, { kind: 'plane-sphere', analytic: true, ...cov }, meanSeedToSamples(seedPts, cov.samples), {
      component: 'covering_arc',
      clip: 'seed_clip',
      form: 'circle',
    });
    pushOriented(out, plane, { kind: 'plane-sphere', analytic: true, ...alt }, meanSeedToSamples(seedPts, alt.samples), {
      component: 'complementary_arc',
      clip: 'seed_clip',
      form: 'circle',
    });
    return out;
  }
  if (plane && other.type === 'cylinder') {
    const con = planeCylinderConic(plane, other);
    if (!con) {
      const num = traceNumerical(sa, sb, seedPts);
      pushOriented(out, plane, { kind: 'plane-cylinder', ...num, form: 'numerical' }, meanSeedToSamples(seedPts, num.samples), {
        component: 'numerical',
        clip: 'none',
        form: 'numerical',
        reason: 'no-geometric-intersection',
      });
      const pts = seedPts.map((s) => projectToCarriers([sa, sb], s, { pull: 0.2 }).point);
      pushOriented(out, plane, {
        kind: 'plane-cylinder',
        analytic: false,
        numerical: true,
        form: 'seed-polyline',
        samples: pts,
        a: pts[0],
        b: pts[pts.length - 1],
      }, meanSeedToSamples(seedPts, pts), {
        component: 'seed_polyline',
        clip: 'none',
        form: 'seed-polyline',
        reason: 'no-geometric-intersection-used-seed-polyline',
      });
      return out;
    }
    if (con.kind === 'lines') {
      con.lines.forEach((pt, i) => {
        const line = { point: pt, direction: con.direction };
        const score = meanSeedToLine(seedPts, line);
        const seg = clipLineToPoints(line, seedPts);
        if (seg) {
          pushOriented(out, plane, {
            kind: 'plane-cylinder',
            analytic: true,
            form: 'lines',
            ...seg,
          }, score, { component: `generator_${i}`, clip: 'seed_clip', form: 'lines' });
        } else {
          const aabb = clipLineToAabb(line, seedPts, 0.08);
          if (aabb) {
            pushOriented(out, plane, {
              kind: 'plane-cylinder',
              analytic: true,
              form: 'lines',
              ...aabb,
            }, score, {
              component: `generator_${i}`,
              clip: 'aabb_clip',
              form: 'lines',
              reason: 'interval-clip-degenerate',
            });
          } else {
            out.push({
              component: `generator_${i}`,
              orientation: 'forward',
              clip: 'aabb_clip',
              accept: false,
              reason: 'trim-interval-clip-removed-segment',
              voxelScore: score,
              hit: null,
              form: 'lines',
            });
          }
        }
      });
      const num = traceNumerical(sa, sb, seedPts);
      pushOriented(out, plane, { kind: 'plane-cylinder', ...num, form: 'numerical' }, meanSeedToSamples(seedPts, num.samples), {
        component: 'numerical',
        clip: 'none',
        form: 'numerical',
      });
      return out;
    }
    const cov = clipEllipse(con, seedPts);
    const alt = clipEllipse(con, seedPts, { complement: true });
    pushOriented(out, plane, { kind: 'plane-cylinder', analytic: true, form: 'ellipse', ...cov }, meanSeedToSamples(seedPts, cov.samples), {
      component: 'covering_arc',
      clip: 'seed_clip',
      form: 'ellipse',
    });
    pushOriented(out, plane, { kind: 'plane-cylinder', analytic: true, form: 'ellipse', ...alt }, meanSeedToSamples(seedPts, alt.samples), {
      component: 'complementary_arc',
      clip: 'seed_clip',
      form: 'ellipse',
    });
    return out;
  }
  const num = traceNumerical(sa, sb, seedPts);
  const kind = plane && other.type === 'cone' ? 'plane-cone'
    : plane && other.type === 'generalQuadric' ? 'plane-quadric'
      : `${sa.type}-${sb.type}`;
  pushOriented(out, sa, { kind, analytic: false, numerical: true, ...num }, meanSeedToSamples(seedPts, num.samples), {
    component: 'numerical',
    clip: 'none',
    form: 'numerical',
  });
  return out;
}

export function selectIntersectionBranch(branches) {
  const accepted = branches.filter((b) => b.accept && b.hit && b.hit.kind !== 'open-unfitted');
  const clipRank = { seed_clip: 0, aabb_clip: 1, none: 2 };
  accepted.sort((a, b) => {
    const ca = clipRank[a.clip] ?? 9;
    const cb = clipRank[b.clip] ?? 9;
    if (ca !== cb) return ca - cb;
    if (a.orientation !== b.orientation) return a.orientation === 'forward' ? -1 : 1;
    return (a.voxelScore ?? Infinity) - (b.voxelScore ?? Infinity);
  });
  return accepted[0] || null;
}

function intersectPair(sa, sb, seedPts) {
  if (!sa || !sb) return null;
  if (sa.type === 'unfitted-curved' || sb.type === 'unfitted-curved') {
    return { kind: 'open-unfitted', analytic: false, seeds: seedPts.length, samples: seedPts };
  }
  if (sa.type === 'plane' && sb.type === 'plane') {
    const line = planePlaneLine(sa, sb);
    const seg = clipLineToPoints(line, seedPts);
    if (seg) return { kind: 'plane-plane', analytic: true, ...seg };
    const pts = seedPts.map((s) => projectToCarriers([sa], s).point);
    return {
      kind: 'carrier-seam',
      analytic: true,
      coincident: true,
      samples: pts,
      a: pts[0],
      b: pts[pts.length - 1],
    };
  }
  if (sa.type === 'plane' && sb.type === 'sphere') {
    const cir = planeSphereCircle(sa, sb);
    if (!cir) return null;
    return { kind: 'plane-sphere', analytic: true, ...clipCircle(cir, seedPts) };
  }
  if (sb.type === 'plane' && sa.type === 'sphere') return intersectPair(sb, sa, seedPts);
  if (sa.type === 'plane' && sb.type === 'cylinder') {
    const con = planeCylinderConic(sa, sb);
    if (!con) return null;
    if (con.kind === 'lines') {
      const line = { point: con.lines[0], direction: con.direction };
      const seg = clipLineToPoints(line, seedPts);
      return seg ? { kind: 'plane-cylinder', analytic: true, form: 'lines', ...seg } : null;
    }
    return { kind: 'plane-cylinder', analytic: true, form: 'ellipse', ...clipEllipse(con, seedPts) };
  }
  if (sb.type === 'plane' && sa.type === 'cylinder') return intersectPair(sb, sa, seedPts);
  if ((sa.type === 'plane' && sb.type === 'cone') || (sb.type === 'plane' && sa.type === 'cone')) {
    return { kind: 'plane-cone', analytic: false, numerical: true, ...traceNumerical(sa, sb, seedPts) };
  }
  if ((sa.type === 'plane' && sb.type === 'generalQuadric') || (sb.type === 'plane' && sa.type === 'generalQuadric')) {
    return { kind: 'plane-quadric', analytic: false, numerical: true, ...traceNumerical(sa, sb, seedPts) };
  }
  return { ...traceNumerical(sa, sb, seedPts), kind: `${sa.type}-${sb.type}` };
}

export function surfaceOfPatch(patch, fit) {
  if (patch.kind === 'cube-exterior' || patch.kind === 'planar-mate') {
    return { type: 'plane', origin: patch.origin, normal: patch.normal };
  }
  if (!fit?.chosen) return { type: 'unfitted-curved', origin: patch.origin, normal: patch.normal };
  const c = fit.chosen;
  if (c.type === 'sphere') return { type: 'sphere', center: c.center, radius: c.radius };
  if (c.type === 'cylinder') return { type: 'cylinder', axis: c.axis, point: c.point, radius: c.radius };
  if (c.type === 'cone') return { type: 'cone', apex: c.apex, axis: c.axis, angle: c.angle };
  if (c.type === 'generalQuadric') return { type: 'generalQuadric', coefficients: c.coefficients };
  return { type: 'unfitted-curved' };
}

function slimIntersection(hit) {
  if (!hit) return null;
  return {
    kind: hit.kind,
    analytic: !!hit.analytic,
    numerical: !!hit.numerical,
    form: hit.form,
    a: hit.a,
    b: hit.b,
    sampleCount: hit.samples?.length || 0,
    seeds: hit.seeds,
  };
}

function curvedAndPlaneIds(pa, pb) {
  if (pa.kind === 'curved' && pb.kind !== 'curved') return { curvedId: pa.id, planeId: pb.id };
  if (pb.kind === 'curved' && pa.kind !== 'curved') return { curvedId: pb.id, planeId: pa.id };
  return { curvedId: pa.id < pb.id ? pa.id : pb.id, planeId: pa.id < pb.id ? pb.id : pa.id };
}

function buildTrims(patches, surfaceOf, N, regionToCarrier, carrierSurf, opts = {}) {
  const overrides = opts.branchOverrides || {};
  const trims = [];
  for (let i = 0; i < patches.length; i++) {
    for (let j = i + 1; j < patches.length; j++) {
      if (patches[i].piece !== patches[j].piece) continue;
      const keys = sharedEdgeKeys(patches[i], patches[j]);
      if (!keys.length) continue;
      const seedPts = keys.flatMap((e) => edgePoints(e, N));
      const ca = regionToCarrier?.get(patches[i].id);
      const cb = regionToCarrier?.get(patches[j].id);
      const adj = adjacencyKey(patches[i].id, patches[j].id);
      const { curvedId, planeId } = curvedAndPlaneIds(patches[i], patches[j]);
      let hit;
      let chosenBranchId = null;
      if (ca && cb && ca === cb) {
        const surf = carrierSurf.get(ca);
        const pts = seedPts.map((s) => projectToCarriers([surf], s).point);
        hit = {
          kind: 'carrier-seam',
          analytic: surf?.type !== 'unfitted-curved',
          samples: pts,
          a: pts[0],
          b: pts[pts.length - 1],
        };
      } else if (overrides[adj]) {
        const branches = enumerateIntersectionBranches(surfaceOf(patches[i]), surfaceOf(patches[j]), seedPts);
        const wanted = overrides[adj];
        const match = branches.find((b) => makeBranchId(curvedId, planeId, b) === wanted);
        hit = match?.hit ?? null;
        chosenBranchId = match ? wanted : null;
      } else {
        hit = intersectPair(surfaceOf(patches[i]), surfaceOf(patches[j]), seedPts);
      }
      trims.push({
        piece: patches[i].piece,
        a: patches[i].id,
        b: patches[j].id,
        carrierA: ca || null,
        carrierB: cb || null,
        sharedVoxelEdges: keys.length,
        chosenBranchId,
        intersection: hit,
      });
    }
  }
  return trims;
}

export function buildJunctionGraph(raw, correspondence, fits, opts = {}) {
  const cand = parseCandidate(raw);
  const N = cand.gridResolution;
  const fitById = new Map(fits.map((f) => [f.patch, f]));
  const patches = correspondence.patches;
  const surf = (p) => surfaceOfPatch(p, fitById.get(p.id));
  const surfaces = patches.map((p) => ({
    id: p.id,
    piece: p.piece,
    kind: p.kind,
    cubeA: p.cubeA,
    cubeB: p.cubeB,
    surface: surf(p),
    transform: p.transform,
  }));
  const trims = buildTrims(patches, (p) => surf(p), N, null, new Map(), opts);
  const byPiece = new Map();
  for (const p of patches) {
    if (!byPiece.has(p.piece)) byPiece.set(p.piece, []);
    byPiece.get(p.piece).push(p);
  }
  const pieceStats = [...byPiece.entries()].map(([piece, list]) => {
    const pieceTrims = trims.filter((t) => t.piece === piece);
    return {
      piece,
      patches: list.length,
      trimAdjacencies: pieceTrims.length,
      analyticTrims: pieceTrims.filter((t) => t.intersection?.analytic).length,
      deferredTrims: pieceTrims.filter((t) => t.intersection?.numerical && !t.intersection?.analytic).length,
      openUnfittedTrims: pieceTrims.filter((t) => t.intersection?.kind === 'open-unfitted').length,
    };
  });
  return {
    schema: 'dual-cube-junction-graph',
    version: 2,
    note: 'Trim curves are analytic or numerically traced intersections clipped by voxel adjacency. Voxel polylines only select the branch. NURBS are not used.',
    surfaces: surfaces.map((s) => ({
      id: s.id,
      piece: s.piece,
      kind: s.kind,
      surfaceType: s.surface.type,
      cubeA: { mate: s.cubeA.mate, matePatch: s.cubeA.matePatch },
      cubeB: { mate: s.cubeB.mate, matePatch: s.cubeB.matePatch },
    })),
    trims: trims.map((t) => ({ ...t, intersection: slimIntersection(t.intersection) })),
    pieceStats,
  };
}

function latticeCorners(patch) {
  const set = new Set();
  for (const f of patch.faces || []) {
    for (const c of f.corners || []) set.add(c.join(','));
  }
  return set;
}

function stitchPiece(piece, patches, trims, regionToCarrier) {
  const list = patches.filter((p) => p.piece === piece);
  const edgeFaces = new Map();
  for (const p of list) {
    for (const f of p.faces || []) {
      for (const e of f.edges || []) {
        if (!edgeFaces.has(e)) edgeFaces.set(e, []);
        edgeFaces.get(e).push(p.id);
      }
    }
  }
  let regionNonmanifold = 0;
  const expected = new Map();
  for (const ids of edgeFaces.values()) {
    const uniq = [...new Set(ids)];
    if (ids.length > 2) regionNonmanifold++;
    if (ids.length === 2 && uniq.length === 2) {
      const k = uniq[0] < uniq[1] ? `${uniq[0]}|${uniq[1]}` : `${uniq[1]}|${uniq[0]}`;
      expected.set(k, (expected.get(k) || 0) + 1);
    }
  }
  const pieceTrims = trims.filter((t) => t.piece === piece);
  const trimKey = (t) => (t.a < t.b ? `${t.a}|${t.b}` : `${t.b}|${t.a}`);
  const haveGood = new Map();
  for (const t of pieceTrims) {
    if (t.intersection && t.intersection.kind !== 'open-unfitted') haveGood.set(trimKey(t), t);
  }
  let unmatchedTrims = 0;
  const unmatchedKeys = [];
  for (const k of expected.keys()) {
    if (!haveGood.has(k)) {
      unmatchedTrims++;
      unmatchedKeys.push(k);
    }
  }
  let duplicateEdges = 0;
  const seen = new Map();
  for (const t of pieceTrims) {
    const k = trimKey(t);
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  for (const c of seen.values()) if (c > 1) duplicateEdges++;

  const findFactory = (uf) => (x) => {
    while (uf.get(x) !== x) {
      uf.set(x, uf.get(uf.get(x)));
      x = uf.get(x);
    }
    return x;
  };

  const ufRegion = new Map(list.map((p) => [p.id, p.id]));
  const findR = findFactory(ufRegion);
  for (const t of pieceTrims) {
    if (!t.intersection || t.intersection.kind === 'open-unfitted') continue;
    const pa = findR(t.a);
    const pb = findR(t.b);
    if (pa !== pb) ufRegion.set(pa, pb);
  }
  const shellsBeforeDissolve = new Set(list.map((p) => findR(p.id))).size;

  const faceId = (patchId) => regionToCarrier?.get(patchId) || patchId;
  const faces = [...new Set(list.map((p) => faceId(p.id)))];
  const ufFace = new Map(faces.map((id) => [id, id]));
  const findF = findFactory(ufFace);
  for (const t of pieceTrims) {
    if (!t.intersection || t.intersection.kind === 'open-unfitted') continue;
    if (t.intersection.kind === 'carrier-seam' && faceId(t.a) === faceId(t.b)) continue;
    const pa = findF(faceId(t.a));
    const pb = findF(faceId(t.b));
    if (pa !== pb) ufFace.set(pa, pb);
  }
  const shellsAfterDissolve = new Set(faces.map((id) => findF(id))).size;
  const groups = new Map();
  for (const p of list) {
    const root = findF(faceId(p.id));
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(p.id);
  }
  const shellMembers = [...groups.values()].map((patchIds, i) => ({ id: i + 1, patchIds }));
  const nm = classifyNonmanifold(piece, patches, regionToCarrier);

  return {
    unmatchedTrims,
    unmatchedKeys,
    openEdges: unmatchedTrims,
    duplicateEdges,
    nonmanifoldEdges: regionNonmanifold,
    nonmanifoldAfterDissolve: nm.shellNonmanifold,
    nonmanifoldIssues: nm.issues.slice(0, 8),
    shells: shellsAfterDissolve,
    shellsBeforeDissolve,
    shellsAfterDissolve,
    shellMembers,
  };
}

function rms(vals) {
  if (!vals.length) return 0;
  return Math.sqrt(vals.reduce((s, v) => s + v * v, 0) / vals.length);
}

function familyTag(kind) {
  if (!kind || kind === 'carrier-seam' || kind === 'open-unfitted' || kind === 'missing') return null;
  const parts = kind.split('-');
  if (parts.length === 2) return [...parts].sort().join('-');
  return kind;
}

function trimAccounting(trims) {
  const role = { intersection: 0, carrierSeam: 0, missing: 0 };
  const status = { resolved: 0, openUnfitted: 0, missing: 0 };
  const family = {};
  for (const t of trims) {
    const kind = t.intersection?.kind || 'missing';
    if (kind === 'carrier-seam') role.carrierSeam++;
    else if (kind === 'missing' || !t.intersection) role.missing++;
    else role.intersection++;
    if (kind === 'open-unfitted') status.openUnfitted++;
    else if (kind === 'missing' || !t.intersection) status.missing++;
    else status.resolved++;
    const fam = familyTag(kind);
    if (fam) family[fam] = (family[fam] || 0) + 1;
  }
  const uniqueRecords = trims.length;
  const roleSum = role.intersection + role.carrierSeam + role.missing;
  const statusSum = status.resolved + status.openUnfitted + status.missing;
  return {
    uniqueRecords,
    role,
    status,
    family,
    consistent: uniqueRecords === roleSum && uniqueRecords === statusSum,
  };
}

function classifyNonmanifold(piece, patches, regionToCarrier) {
  const list = patches.filter((p) => p.piece === piece);
  const edgeFaces = new Map();
  for (const p of list) {
    for (const f of p.faces || []) {
      for (const e of f.edges || []) {
        if (!edgeFaces.has(e)) edgeFaces.set(e, []);
        edgeFaces.get(e).push(p.id);
      }
    }
  }
  const issues = [];
  let shellNonmanifold = 0;
  for (const [edge, ids] of edgeFaces) {
    if (ids.length <= 2) continue;
    const uniq = [...new Set(ids)];
    const carrierSet = [...new Set(uniq.map((id) => regionToCarrier?.get(id) || id))];
    const subdivisionArtifact = carrierSet.length === 1;
    const validShellEdge = carrierSet.length === 2;
    if (subdivisionArtifact || validShellEdge) continue;
    shellNonmanifold++;
    issues.push({
      edge,
      piece,
      incidentFaceCount: ids.length,
      incidentPatches: uniq,
      incidentCarriers: carrierSet,
      incidentPieces: [piece],
      subdivisionArtifact,
      trueIntersection: carrierSet.length > 1,
      validShellEdge,
      repair: 'split into canonical 2-face edges',
    });
  }
  return { issues, shellNonmanifold };
}

export function topologyMetrics(raw, correspondence, fits, opts = {}) {
  const cand = parseCandidate(raw);
  const N = cand.gridResolution;
  const patches = correspondence.patches;
  const fitById = new Map(fits.map((f) => [f.patch, f]));
  const carriers = consolidateCarriers(correspondence, fits);
  const carrierSurf = new Map(carriers._surfaces.map((c) => [c.id, c.surface]));
  const regionToCarrier = carriers._regionToCarrier;
  const surfOf = (p) => {
    const cid = regionToCarrier.get(p.id);
    return cid ? carrierSurf.get(cid) : surfaceOfPatch(p, fitById.get(p.id));
  };
  const trims = buildTrims(patches, surfOf, N, regionToCarrier, carrierSurf, opts);
  const byPiece = new Map();
  for (const p of patches) {
    if (!byPiece.has(p.piece)) byPiece.set(p.piece, []);
    byPiece.get(p.piece).push(p);
  }
  const pieces = [];
  const unmatched = [];
  let openEdges = 0;
  let nonmanifold = 0;
  let duplicateEdges = 0;
  let shells = 0;
  let unresolved = 0;
  for (const [piece, list] of byPiece) {
    const st = stitchPiece(piece, patches, trims, regionToCarrier);
    const unfittedCurved = list.filter((p) => p.kind === 'curved' && !fitById.get(p.id)?.chosen).length;
    openEdges += st.openEdges;
    nonmanifold += st.nonmanifoldAfterDissolve;
    duplicateEdges += st.duplicateEdges;
    shells += st.shellsAfterDissolve;
    unresolved += unfittedCurved;
    for (const key of st.unmatchedKeys) unmatched.push({ piece, key });
    pieces.push({
      piece,
      openEdges: st.openEdges,
      nonmanifold: st.nonmanifoldAfterDissolve,
      shells: st.shellsAfterDissolve,
      unresolved: unfittedCurved,
      fitted: list.filter((p) => p.kind === 'curved' && fitById.get(p.id)?.chosen).length,
    });
  }
  return {
    openEdges,
    nonmanifold,
    duplicateEdges,
    shells,
    unresolved,
    fitted: fits.filter((f) => f.chosen).length,
    unmatched,
    pieces,
    trims,
    patches,
    fitById,
    carriers,
    carrierSurf,
    regionToCarrier,
    surfOf,
    byPiece,
    cand,
    N,
  };
}

export function attributeOpenEdges(state) {
  const patchById = new Map(state.patches.map((p) => [p.id, p]));
  const explained = [];
  const fittedUntrimmed = [];
  const unexplained = [];
  const byOpening = {};
  const byFitted = {};
  for (const row of state.unmatched) {
    const [a, b] = row.key.split('|');
    const pa = patchById.get(a);
    const pb = patchById.get(b);
    const openings = [pa, pb].filter((p) => p && p.kind === 'curved' && !state.fitById.get(p.id)?.chosen);
    const fittedCurved = [pa, pb].filter((p) => p && p.kind === 'curved' && state.fitById.get(p.id)?.chosen);
    const rec = {
      piece: row.piece,
      key: row.key,
      a,
      b,
      kinds: [pa?.kind, pb?.kind],
      openings: openings.map((p) => p.id),
      fitted: fittedCurved.map((p) => p.id),
    };
    if (openings.length) {
      explained.push(rec);
      for (const p of openings) byOpening[p.id] = (byOpening[p.id] || 0) + 1;
    } else if (fittedCurved.length) {
      fittedUntrimmed.push(rec);
      for (const p of fittedCurved) byFitted[p.id] = (byFitted[p.id] || 0) + 1;
    } else unexplained.push(rec);
  }
  return {
    openEdges: state.openEdges,
    explainedByUnresolvedOpening: explained.length,
    explainedByFittedUntrimmed: fittedUntrimmed.length,
    unexplainedCount: unexplained.length,
    byOpening,
    byFittedUntrimmed: byFitted,
    unexplained: unexplained.slice(0, 32),
    fittedUntrimmed: fittedUntrimmed.slice(0, 16),
  };
}

function decomposeJunction(piece, vertex, regions, solved, carrierInfos, fitById) {
  const curved = regions.filter((p) => p.kind === 'curved');
  const resolved = curved.filter((p) => fitById.get(p.id)?.chosen);
  const unresolved = curved.filter((p) => !fitById.get(p.id)?.chosen);
  const families = [...new Set(carrierInfos.map((c) => c.type))];
  const inCubeA = regions.some((p) => p.kind === 'cube-exterior' || p.cubeA?.mate != null);
  const inCubeB = regions.some((p) => p.cubeB?.mate && p.cubeB.mate !== 'exterior');
  return {
    id: `J${piece}:${vertex}`,
    piece,
    vertex,
    incidenceRms: solved.rms,
    incidenceMax: solved.max,
    perConstraintRms: solved.rms,
    perConstraint: carrierInfos.map((c, i) => ({
      carrier: c.id,
      type: c.type,
      residual: solved.residuals?.[i] ?? null,
    })),
    incidentCarrierCount: carrierInfos.length,
    carrierFamilies: families,
    neighboringOpenings: {
      resolved: resolved.map((p) => p.id),
      unresolved: unresolved.map((p) => p.id),
      resolvedCount: resolved.length,
      unresolvedCount: unresolved.length,
    },
    assemblies: { A: inCubeA, B: inCubeB, both: inCubeA && inCubeB },
    bordersNewSurface: resolved.length > 0,
    seed: undefined,
    point: solved.point,
    surfaceRms: solved.rms,
    surfaceMax: solved.max,
    carriers: carrierInfos.length,
    regions: regions.map((p) => p.id),
  };
}

function summarizeJunctions(rows) {
  const byCount = {};
  const newly = rows.filter((j) => j.bordersNewSurface);
  for (const j of rows) {
    const n = j.incidentCarrierCount;
    if (!byCount[n]) byCount[n] = { count: 0, rmsVals: [], maxVals: [] };
    byCount[n].count++;
    if (Number.isFinite(j.incidenceRms)) byCount[n].rmsVals.push(j.incidenceRms);
    if (Number.isFinite(j.incidenceMax)) byCount[n].maxVals.push(j.incidenceMax);
  }
  const pack = (vals) => ({
    count: vals.count,
    rms: rms(vals.rmsVals),
    max: vals.maxVals.length ? Math.max(...vals.maxVals) : 0,
  });
  const byCarrierCount = {};
  for (const [k, v] of Object.entries(byCount)) byCarrierCount[k] = pack(v);
  const worst = [...rows]
    .sort((a, b) => (b.incidenceMax || 0) - (a.incidenceMax || 0))
    .slice(0, 24)
    .map((j) => ({
      id: j.id,
      piece: j.piece,
      incidenceRms: j.incidenceRms,
      incidenceMax: j.incidenceMax,
      incidentCarrierCount: j.incidentCarrierCount,
      carrierFamilies: j.carrierFamilies,
      neighboringOpenings: j.neighboringOpenings,
      assemblies: j.assemblies,
      bordersNewSurface: j.bordersNewSurface,
    }));
  return {
    count: rows.length,
    rms: rms(rows.map((j) => j.incidenceRms).filter(Number.isFinite)),
    max: rows.reduce((m, j) => Math.max(m, j.incidenceMax || 0), 0),
    byCarrierCount,
    newlyFitted: {
      count: newly.length,
      rms: rms(newly.map((j) => j.incidenceRms).filter(Number.isFinite)),
      max: newly.reduce((m, j) => Math.max(m, j.incidenceMax || 0), 0),
    },
    worst,
  };
}

export function buildClosureReport(raw, correspondence, fits, volumes, opts = {}) {
  const cand = parseCandidate(raw);
  const N = cand.gridResolution;
  const patches = correspondence.patches;
  const fitById = new Map(fits.map((f) => [f.patch, f]));
  const carriers = consolidateCarriers(correspondence, fits);
  const carrierSurf = new Map(carriers._surfaces.map((c) => [c.id, c.surface]));
  const regionToCarrier = carriers._regionToCarrier;
  const surfOf = (p) => {
    const cid = regionToCarrier.get(p.id);
    return cid ? carrierSurf.get(cid) : surfaceOfPatch(p, fitById.get(p.id));
  };

  const trims = buildTrims(patches, surfOf, N, regionToCarrier, carrierSurf, opts);
  const analyticTrimCount = trims.filter((t) => t.intersection?.analytic).length;
  const unmatchedTrimCount = trims.filter((t) => !t.intersection).length;

  const junctions = [];
  const byPiece = new Map();
  for (const p of patches) {
    if (!byPiece.has(p.piece)) byPiece.set(p.piece, []);
    byPiece.get(p.piece).push(p);
  }
  for (const [piece, list] of byPiece) {
    const vert = new Map();
    for (const p of list) {
      for (const key of latticeCorners(p)) {
        if (!vert.has(key)) vert.set(key, new Set());
        vert.get(key).add(p);
      }
    }
    for (const [vertex, set] of vert) {
      if (set.size < 3) continue;
      const regions = [...set];
      const carrierIds = [...new Set(regions.map((p) => regionToCarrier.get(p.id)))].filter(Boolean);
      const carrierInfos = carrierIds
        .map((id) => {
          const surf = carrierSurf.get(id);
          if (!surf || surf.type === 'unfitted-curved') return null;
          return { id, type: surf.type, surface: surf };
        })
        .filter(Boolean);
      const seed = latticeUnit(vertex.split(',').map(Number), N);
      const solved = projectToCarriers(carrierInfos.map((c) => c.surface), seed);
      const row = decomposeJunction(piece, vertex, regions, solved, carrierInfos, fitById);
      row.seed = seed;
      row.cubeA = solved.point;
      row.cubeB = transformGeometricPoint(solved.point.map((x) => x * N), cand.placements[piece - 1], N).map((x) => x / N);
      junctions.push(row);
    }
  }

  const auditB = auditCubeBMates(raw, correspondence);
  const aMate = aMateResiduals(patches, surfOf, N);
  const frozenSolve = solveFrozenMateFeasibility(raw, correspondence, surfOf);

  const surfaceResiduals = junctions.map((j) => j.surfaceRms).filter(Number.isFinite);
  const surfaceMaxima = junctions.map((j) => j.surfaceMax).filter(Number.isFinite);
  const accounting = trimAccounting(trims);
  const nmAll = [];
  const pieces = [];
  const unmatched = [];
  for (const [piece, list] of byPiece) {
    const vol = volumes?.find((v) => v.piece === piece);
    const st = stitchPiece(piece, patches, trims, regionToCarrier);
    nmAll.push(...st.nonmanifoldIssues);
    for (const key of st.unmatchedKeys) unmatched.push({ piece, key });
    const unfittedCurved = list.filter((p) => p.kind === 'curved' && !fitById.get(p.id)?.chosen).length;
    const fittedCurved = list.filter((p) => p.kind === 'curved' && fitById.get(p.id)?.chosen).length;
    const volumePositive = (vol?.sourceVoxelVolume || 0) > 0;
    const connectedSolid = (vol?.voxelComponents || 1) === 1
      && st.openEdges === 0
      && st.nonmanifoldAfterDissolve === 0
      && st.shellsAfterDissolve === 1
      && volumePositive;
    pieces.push({
      piece,
      patches: list.length,
      carriers: carriers.carriers.filter((c) => c.piece === piece).length,
      analyticTrims: trims.filter((t) => t.piece === piece && t.intersection?.analytic).length,
      unmatchedTrims: st.unmatchedTrims,
      openEdges: st.openEdges,
      duplicateEdges: st.duplicateEdges,
      nonmanifoldEdges: st.nonmanifoldAfterDissolve,
      nonmanifoldBeforeDissolve: st.nonmanifoldEdges,
      shells: st.shellsAfterDissolve,
      shellsBeforeDissolve: st.shellsBeforeDissolve,
      volumePositive,
      connectedSolid,
      sourceVoxelVolume: vol?.sourceVoxelVolume ?? null,
      unresolvedCurvedOpenings: unfittedCurved,
      fittedCurved,
      shellMembers: st.shellMembers,
    });
  }

  const assemblyA = {
    junctionRMS: rms(surfaceResiduals),
    junctionMax: surfaceMaxima.length ? Math.max(...surfaceMaxima) : 0,
    mateRMS: aMate.rms,
    mateMax: aMate.max,
    analyticTrims: analyticTrimCount,
    unmatchedTrims: unmatchedTrimCount,
    openEdges: pieces.reduce((s, p) => s + p.openEdges, 0),
    nonmanifoldEdges: pieces.reduce((s, p) => s + p.nonmanifoldEdges, 0),
  };
  const assemblyB = {
    junctionRMS: frozenSolve.finalRms,
    junctionMax: frozenSolve.finalMax,
    mateRMS: frozenSolve.finalRms,
    mateMax: frozenSolve.finalMax,
    voxelCorrespondenceRms: auditB.voxelRms,
    voxelCorrespondenceMax: auditB.voxelMax,
    initialRms: frozenSolve.initialRms,
    initialMax: frozenSolve.initialMax,
    analyticTrims: analyticTrimCount,
    unmatchedTrims: unmatchedTrimCount,
    openEdges: pieces.reduce((s, p) => s + p.openEdges, 0),
    nonmanifoldEdges: pieces.reduce((s, p) => s + p.nonmanifoldEdges, 0),
  };

  const topologyGate = {
    zeroNonmanifold: pieces.every((p) => p.nonmanifoldEdges === 0),
    zeroUnmatched: pieces.every((p) => p.unmatchedTrims === 0),
    carrierSeamsDissolved: true,
    oneShellPerPiece: pieces.every((p) => p.shells === 1),
    positiveVolume: pieces.every((p) => p.volumePositive),
  };
  topologyGate.pass = Object.values(topologyGate).every(Boolean);

  const geometricGate = {
    junctionRmsBelow01: assemblyA.junctionRMS < 0.01,
    mateRmsABelow01: assemblyA.mateRMS < 0.01,
    mateRmsBBelow01: assemblyB.mateRMS < 0.01,
    noResidualAbove03: assemblyA.junctionMax < 0.03 && assemblyB.mateMax < 0.03,
  };
  geometricGate.pass = Object.values(geometricGate).every(Boolean);

  const shellDiagnosis = classifyPieceShells(raw, correspondence, pieces);
  const nonmanifoldBefore = pieces.reduce((s, p) => s + p.nonmanifoldBeforeDissolve, 0);
  const openEdgeAttribution = attributeOpenEdges({
    unmatched,
    patches,
    fitById,
    openEdges: pieces.reduce((s, p) => s + p.openEdges, 0),
  });
  const junctionSummary = summarizeJunctions(junctions);

  const closedA = topologyGate.pass && pieces.every((p) => p.unresolvedCurvedOpenings === 0) && geometricGate.mateRmsABelow01;
  const closedB = closedA && geometricGate.mateRmsBBelow01;

  return {
    schema: 'dual-cube-closure',
    version: 3,
    note: 'Four metrics are separate: discrete doubled-lattice mate identity, carrier incidence, continuous trim mismatch about N/2, and shell closure. Carriers stay frozen until topology is stable. Junction residuals are decomposed by constraint count. GPU is not used for topology.',
    metrics: {
      discreteMateIdentity: auditB.discrete,
      carrierIncidence: { rms: rms(surfaceResiduals), max: surfaceMaxima.length ? Math.max(...surfaceMaxima) : 0 },
      continuousTrimMismatch: {
        rms: frozenSolve.finalRms,
        max: frozenSolve.finalMax,
        initialRms: frozenSolve.initialRms,
        initialMax: frozenSolve.initialMax,
      },
      shellClosure: {
        openEdges: pieces.reduce((s, p) => s + p.openEdges, 0),
        nonmanifoldAfterDissolve: pieces.reduce((s, p) => s + p.nonmanifoldEdges, 0),
        nonmanifoldBeforeDissolve: nonmanifoldBefore,
        diagnosis: shellDiagnosis,
        openEdgeAttribution,
      },
    },
    carriers: {
      patchCount: carriers.patchCount,
      carrierCount: carriers.carrierCount,
      frozenCount: carriers.frozenCount,
      unfittedCount: carriers.unfittedCount,
      types: carriers.types,
      items: carriers.carriers,
    },
    assemblies: { A: assemblyA, B: assemblyB },
    pieces,
    junctions: {
      count: junctionSummary.count,
      rms: junctionSummary.rms,
      max: junctionSummary.max,
      byCarrierCount: junctionSummary.byCarrierCount,
      newlyFitted: junctionSummary.newlyFitted,
      worst: junctionSummary.worst,
      samples: junctionSummary.worst.slice(0, 16),
    },
    trims: {
      uniqueRecords: accounting.uniqueRecords,
      analytic: analyticTrimCount,
      unmatched: unmatchedTrimCount,
      role: accounting.role,
      status: accounting.status,
      family: accounting.family,
      consistent: accounting.consistent,
    },
    audit: {
      cubeB: auditB,
      frozenSolve,
      aMate,
      nonmanifold: nmAll,
      shells: shellDiagnosis,
    },
    gate: {
      topology: topologyGate,
      geometric: geometricGate,
      cadReady: false,
      everyPieceNonempty: pieces.every((p) => p.volumePositive),
      everyPieceConnectedSolid: pieces.every((p) => p.connectedSolid),
      zeroOpenEdges: pieces.every((p) => p.openEdges === 0),
      zeroNonmanifold: topologyGate.zeroNonmanifold,
      zeroUnresolvedOpenings: pieces.every((p) => p.unresolvedCurvedOpenings === 0),
      cubeAClosed: closedA,
      cubeBClosed: closedB,
      bothAssembliesClosed: closedA && closedB,
      rhinoReady: false,
    },
  };
}
