/**
 * Finite half-cube basis: 6 face-diagonal planes, 12 oriented triangular prisms.
 * Local cell corners are integer {0,1}^3. Half volume is exactly 1/2.
 */
import { ROT, applyRot } from './json_contract.mjs';

export const PLANES = [
  { kind: 'eq', a: 0, b: 1 },
  { kind: 'eq', a: 0, b: 2 },
  { kind: 'eq', a: 1, b: 2 },
  { kind: 'sum', a: 0, b: 1 },
  { kind: 'sum', a: 0, b: 2 },
  { kind: 'sum', a: 1, b: 2 },
];

export const HALF_COUNT = 12;
export const HALF_VOLUME = 1 / 2;
export const FULL_VOLUME = 1;

export function halfIndex(planeIdx, side) {
  return (planeIdx << 1) | (side ? 1 : 0);
}

export function splitHalf(h) {
  return { planeIdx: h >> 1, side: h & 1 };
}

export function complementHalf(h) {
  return h ^ 1;
}

export function planeValue(plane, local) {
  const u = [2 * local[0] - 1, 2 * local[1] - 1, 2 * local[2] - 1];
  return plane.kind === 'eq' ? u[plane.a] - u[plane.b] : u[plane.a] + u[plane.b];
}

export function probePoint(h) {
  const { planeIdx, side } = splitHalf(h);
  const plane = PLANES[planeIdx];
  const p = [0.5, 0.5, 0.5];
  if (plane.kind === 'eq') {
    p[plane.a] = side === 0 ? 0.25 : 0.75;
    p[plane.b] = side === 0 ? 0.75 : 0.25;
  } else {
    p[plane.a] = side === 0 ? 0.25 : 0.75;
    p[plane.b] = side === 0 ? 0.25 : 0.75;
  }
  return p;
}

export function identifyHalf(local) {
  let best = 0;
  let bestAbs = -1;
  let bestSide = 0;
  for (let i = 0; i < PLANES.length; i++) {
    const v = planeValue(PLANES[i], local);
    const a = Math.abs(v);
    if (a > bestAbs) {
      bestAbs = a;
      best = i;
      bestSide = v <= 0 ? 0 : 1;
    }
  }
  return halfIndex(best, bestSide);
}

export function rotateHalf(h, M) {
  const p = probePoint(h);
  const u = [2 * p[0] - 1, 2 * p[1] - 1, 2 * p[2] - 1];
  const ru = applyRot(u, M);
  return identifyHalf([(ru[0] + 1) / 2, (ru[1] + 1) / 2, (ru[2] + 1) / 2]);
}

export function rotateHalfByR(h, r) {
  return rotateHalf(h, ROT[r]);
}

export function cubeCorners() {
  const out = [];
  for (let x = 0; x <= 1; x++) {
    for (let y = 0; y <= 1; y++) {
      for (let z = 0; z <= 1; z++) out.push([x, y, z]);
    }
  }
  return out;
}

export function halfCorners(h) {
  const { planeIdx, side } = splitHalf(h);
  const plane = PLANES[planeIdx];
  const pts = [];
  const seen = new Set();
  for (const c of cubeCorners()) {
    const v = planeValue(plane, c);
    const s = v <= 0 ? 0 : 1;
    if (s === side || v === 0) {
      const k = c.join(',');
      if (!seen.has(k)) {
        seen.add(k);
        pts.push(c);
      }
    }
  }
  return pts;
}

export function halfCornersWorld(cell, h) {
  return halfCorners(h).map((c) => [cell[0] + c[0], cell[1] + c[1], cell[2] + c[2]]);
}

const CUBE_FACE_CORNERS = [
  [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]],
  [[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]],
  [[0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 0]],
  [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]],
  [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
  [[0, 0, 1], [0, 1, 1], [1, 1, 1], [1, 0, 1]],
];

function uniquePts(pts) {
  const seen = new Set();
  const out = [];
  for (const p of pts) {
    const k = p.join(',');
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p.slice());
    }
  }
  return out;
}

function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalFromUnordered(pts) {
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      for (let k = j + 1; k < pts.length; k++) {
        const n = cross3(sub3(pts[j], pts[i]), sub3(pts[k], pts[i]));
        if (n[0] * n[0] + n[1] * n[1] + n[2] * n[2] > 1e-18) return n;
      }
    }
  }
  return [0, 0, 1];
}

export function orderCoplanar(pts) {
  const unique = uniquePts(pts);
  if (unique.length <= 2) return unique.map((p) => p.slice());
  let n = normalFromUnordered(unique);
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  n = n.map((x) => x / nl);
  let u = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  u = cross3(u, n);
  const ul = Math.hypot(u[0], u[1], u[2]) || 1;
  u = u.map((x) => x / ul);
  const v = cross3(n, u);
  const cx = unique.reduce((s, p) => s + p[0], 0) / unique.length;
  const cy = unique.reduce((s, p) => s + p[1], 0) / unique.length;
  const cz = unique.reduce((s, p) => s + p[2], 0) / unique.length;
  const c = [cx, cy, cz];
  return unique
    .map((p) => ({
      p: p.slice(),
      ang: Math.atan2(dot3(sub3(p, c), v), dot3(sub3(p, c), u)),
    }))
    .sort((a, b) => a.ang - b.ang || a.p[0] - b.p[0] || a.p[1] - b.p[1] || a.p[2] - b.p[2])
    .map((x) => x.p);
}

export function polygonArea(pts) {
  if (pts.length < 3) return 0;
  const o = pts[0];
  let ax = 0;
  let ay = 0;
  let az = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = [pts[i][0] - o[0], pts[i][1] - o[1], pts[i][2] - o[2]];
    const b = [pts[i + 1][0] - o[0], pts[i + 1][1] - o[1], pts[i + 1][2] - o[2]];
    ax += a[1] * b[2] - a[2] * b[1];
    ay += a[2] * b[0] - a[0] * b[2];
    az += a[0] * b[1] - a[1] * b[0];
  }
  return Math.hypot(ax, ay, az) / 2;
}

export function cutPolygon(h) {
  const { planeIdx } = splitHalf(h);
  const plane = PLANES[planeIdx];
  return orderCoplanar(cubeCorners().filter((c) => planeValue(plane, c) === 0));
}

export function halfFacePolygons(h) {
  const { planeIdx, side } = splitHalf(h);
  const plane = PLANES[planeIdx];
  const faces = [];
  for (const corners of CUBE_FACE_CORNERS) {
    const kept = corners.filter((c) => {
      const v = planeValue(plane, c);
      const s = v <= 0 ? 0 : 1;
      return s === side || v === 0;
    });
    const poly = orderCoplanar(uniquePts(kept));
    if (polygonArea(poly) > 0) faces.push(poly);
  }
  const cut = cutPolygon(h);
  if (polygonArea(cut) > 0) faces.push(cut);
  return faces;
}

export function fullFacePolygons() {
  return CUBE_FACE_CORNERS.map((c) => c.map((p) => p.slice()));
}

export function worldPolygon(cell, localPoly) {
  return localPoly.map((p) => [cell[0] + p[0], cell[1] + p[1], cell[2] + p[2]]);
}

export function atomVolume(atom) {
  return atom.kind === 'full' ? FULL_VOLUME : HALF_VOLUME;
}

function shoelace2(pts) {
  if (pts.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    s += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return s;
}

function inside(p, a, b) {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -1e-12;
}

function intersect(p, q, a, b) {
  const den = (p[0] - q[0]) * (a[1] - b[1]) - (p[1] - q[1]) * (a[0] - b[0]);
  if (den === 0) return p.slice();
  const t = ((p[0] - a[0]) * (a[1] - b[1]) - (p[1] - a[1]) * (a[0] - b[0])) / den;
  return [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
}

function clipPolygon2(subject, clip) {
  const clipCCW = shoelace2(clip) < 0 ? clip.slice().reverse() : clip;
  let out = subject.map((p) => p.slice());
  if (shoelace2(out) < 0) out.reverse();
  for (let i = 0; i < clipCCW.length; i++) {
    const a = clipCCW[i];
    const b = clipCCW[(i + 1) % clipCCW.length];
    const inp = out;
    out = [];
    if (!inp.length) break;
    for (let j = 0; j < inp.length; j++) {
      const cur = inp[j];
      const prev = inp[(j + inp.length - 1) % inp.length];
      const cIn = inside(cur, a, b);
      const pIn = inside(prev, a, b);
      if (cIn) {
        if (!pIn) out.push(intersect(prev, cur, a, b));
        out.push(cur);
      } else if (pIn) {
        out.push(intersect(prev, cur, a, b));
      }
    }
  }
  return uniquePts(out);
}

function projectFace(poly, axis) {
  const i = (axis + 1) % 3;
  const j = (axis + 2) % 3;
  return poly.map((p) => [p[i], p[j]]);
}

function facePolygonOnAxis(atom, axis, dir) {
  const localFaces = atom.kind === 'full'
    ? fullFacePolygons()
    : halfFacePolygons(halfIndex(atom.plane, atom.side));
  for (const poly of localFaces) {
    if (poly.every((p) => p[axis] === dir) && polygonArea(poly) > 0) {
      return worldPolygon(atom.cell, poly);
    }
  }
  return null;
}

export function sharedFaceArea(atomA, atomB) {
  const da = [
    atomB.cell[0] - atomA.cell[0],
    atomB.cell[1] - atomA.cell[1],
    atomB.cell[2] - atomA.cell[2],
  ];
  if (Math.abs(da[0]) + Math.abs(da[1]) + Math.abs(da[2]) !== 1) return 0;
  const axis = da[0] !== 0 ? 0 : da[1] !== 0 ? 1 : 2;
  const aFace = da[axis] > 0 ? 1 : 0;
  const bFace = da[axis] > 0 ? 0 : 1;
  const polyA = facePolygonOnAxis(atomA, axis, aFace);
  const polyB = facePolygonOnAxis(atomB, axis, bFace);
  if (!polyA || !polyB) return 0;
  const clip = clipPolygon2(projectFace(polyA, axis), projectFace(polyB, axis));
  return Math.abs(shoelace2(clip)) / 2;
}

export function atomsFaceConnected(a, b) {
  const sameCell = a.cell[0] === b.cell[0] && a.cell[1] === b.cell[1] && a.cell[2] === b.cell[2];
  if (sameCell) {
    if (a.kind === 'full' || b.kind === 'full') return true;
    return a.plane === b.plane && a.side !== b.side;
  }
  if (a.kind === 'full' && b.kind === 'full') {
    const manh = Math.abs(a.cell[0] - b.cell[0]) + Math.abs(a.cell[1] - b.cell[1]) + Math.abs(a.cell[2] - b.cell[2]);
    return manh === 1;
  }
  return sharedFaceArea(a, b) > 0;
}

export const ROTATION_TABLE = Array.from({ length: 24 }, (_, r) => {
  const row = new Uint8Array(HALF_COUNT);
  for (let h = 0; h < HALF_COUNT; h++) row[h] = rotateHalfByR(h, r);
  return row;
});
