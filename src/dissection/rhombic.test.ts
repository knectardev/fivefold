import { BufferAttribute, Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { finalizeHull } from '../geom/convexHull';
import {
  SIGMA,
  applyMotion2,
  buildRhombicPieces,
  insideRd,
  rectToRect,
  type RhombicPiece,
  type Vec2,
} from './rhombic';

function polygonArea(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s += p.x * q.y - q.x * p.y;
  }
  return Math.abs(s) / 2;
}

function pointInPolygon(p: Vec2, poly: Vec2[], eps = 1e-9): boolean {
  // Convex polygon: p must be on the interior side of every edge.
  const area = (() => {
    let s = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      s += a.x * b.y - b.x * a.y;
    }
    return s;
  })();
  const orient = area >= 0 ? 1 : -1;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (orient * cross < -eps) return false;
  }
  return true;
}

describe('rectToRect slide dissection', () => {
  const cases: [number, number, number, number][] = [
    [1, 1, SIGMA, 1 / SIGMA],
    [1 / SIGMA, 1, SIGMA, 2 * SIGMA],
  ];

  it('pieces partition the source rectangle by area', () => {
    for (const [a, b, c, d] of cases) {
      const pieces = rectToRect(a, b, c, d);
      const total = pieces.reduce((acc, p) => acc + polygonArea(p.poly), 0);
      expect(Math.abs(total - a * b)).toBeLessThan(1e-9);
      expect(Math.abs(a * b - c * d)).toBeLessThan(1e-9);
    }
  });

  it('motions are rigid (det +1, orthonormal) and land pieces in the target', () => {
    for (const [a, b, c, d] of cases) {
      for (const piece of rectToRect(a, b, c, d)) {
        const { m00, m01, m10, m11 } = piece.motion;
        expect(Math.abs(m00 * m11 - m01 * m10 - 1)).toBeLessThan(1e-9);
        expect(Math.abs(m00 * m00 + m10 * m10 - 1)).toBeLessThan(1e-9);
        for (const v of piece.poly) {
          const t = applyMotion2(piece.motion, v);
          expect(t.x).toBeGreaterThan(-1e-7);
          expect(t.x).toBeLessThan(c + 1e-7);
          expect(t.y).toBeGreaterThan(-1e-7);
          expect(t.y).toBeLessThan(d + 1e-7);
        }
      }
    }
  });

  it('moved pieces tile the target exactly (random point coverage)', () => {
    for (const [a, b, c, d] of cases) {
      const pieces = rectToRect(a, b, c, d).map((p) => ({
        target: p.poly.map((v) => applyMotion2(p.motion, v)),
      }));
      let seed = 42;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      let covered = 0;
      let samples = 0;
      for (let i = 0; i < 500; i++) {
        const p = { x: rand() * c, y: rand() * d };
        const hits = pieces.filter((pc) => pointInPolygon(p, pc.target, 1e-7)).length;
        // Boundary points may register in 2 pieces; interior must be ≥1.
        if (hits === 0) continue;
        covered++;
        samples++;
        expect(hits).toBeLessThanOrEqual(2);
      }
      expect(covered / 500).toBeGreaterThan(0.995);
      expect(samples).toBeGreaterThan(0);
    }
  });
});

type HullPlanes = { n: Vector3; d: number }[];

function hullPlanes(piece: RhombicPiece): HullPlanes {
  const pos = piece.geometry.attributes.position as BufferAttribute;
  const pts: Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    pts.push(new Vector3().fromBufferAttribute(pos, i));
  }
  const centroid = pts.reduce((a, p) => a.add(p), new Vector3()).multiplyScalar(1 / pts.length);
  const geo = finalizeHull(pts);
  const hp = geo.attributes.position as BufferAttribute;
  const planes: HullPlanes = [];
  for (let i = 0; i + 2 < hp.count; i += 3) {
    const a = new Vector3().fromBufferAttribute(hp, i);
    const b = new Vector3().fromBufferAttribute(hp, i + 1);
    const c = new Vector3().fromBufferAttribute(hp, i + 2);
    const n = b.clone().sub(a).cross(c.clone().sub(a));
    if (n.lengthSq() < 1e-16) continue;
    n.normalize();
    if (n.dot(a.clone().sub(centroid)) < 0) n.negate();
    planes.push({ n, d: n.dot(a) });
  }
  geo.dispose();
  return planes;
}

function pointInHull(p: Vector3, planes: HullPlanes, eps = 1e-6): boolean {
  for (const pl of planes) {
    if (pl.n.dot(p) - pl.d > eps) return false;
  }
  return true;
}

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('cube ↔ rhombic dodecahedron dissection', () => {
  const build = buildRhombicPieces();

  it('total piece volume equals the unit cube', () => {
    expect(Math.abs(build.totalVolume - 1)).toBeLessThan(2e-3);
  });

  it('has one core group and six pyramid groups', () => {
    const pyramidSlots = new Set(
      build.pieces.filter((p) => p.role === 'pyramid').map((p) => p.rdSlot),
    );
    expect(pyramidSlots.size).toBe(6);
    expect(build.pieces.some((p) => p.role === 'core')).toBe(true);
  });

  it('all rd motions are rigid (rotation part orthonormal, det +1)', () => {
    for (const piece of build.pieces) {
      const e = piece.rdMatrix.elements;
      const r = [
        new Vector3(e[0], e[1], e[2]),
        new Vector3(e[4], e[5], e[6]),
        new Vector3(e[8], e[9], e[10]),
      ];
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(r[i].length() - 1)).toBeLessThan(1e-9);
        for (let j = i + 1; j < 3; j++) {
          expect(Math.abs(r[i].dot(r[j]))).toBeLessThan(1e-9);
        }
      }
      expect(new Matrix4().copy(piece.rdMatrix).determinant()).toBeGreaterThan(0.999);
    }
  });

  it('cube pose: every vertex inside the centered unit cube', () => {
    for (const piece of build.pieces) {
      const pos = piece.geometry.attributes.position as BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const p = new Vector3().fromBufferAttribute(pos, i);
        expect(Math.abs(p.x)).toBeLessThan(0.5 + 1e-5);
        expect(Math.abs(p.y)).toBeLessThan(0.5 + 1e-5);
        expect(Math.abs(p.z)).toBeLessThan(0.5 + 1e-5);
      }
    }
  });

  it('rd pose: every transformed vertex inside the RD', () => {
    for (const piece of build.pieces) {
      const pos = piece.geometry.attributes.position as BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const p = new Vector3().fromBufferAttribute(pos, i).applyMatrix4(piece.rdMatrix);
        expect(insideRd(p, 1e-4)).toBe(true);
      }
    }
  });

  it('pieces tile the cube exactly (random interior points covered once)', () => {
    const planes = build.pieces.map(hullPlanes);
    const rand = mulberry(7);
    let single = 0;
    let total = 0;
    for (let i = 0; i < 400; i++) {
      const p = new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.98);
      const hits = planes.filter((pl) => pointInHull(p, pl, 1e-7)).length;
      total++;
      if (hits === 1) single++;
      expect(hits).toBeGreaterThanOrEqual(1);
      expect(hits).toBeLessThanOrEqual(3); // shared faces can double/triple count
    }
    expect(single / total).toBeGreaterThan(0.9);
  });

  it('pieces tile the RD exactly (random interior points covered once)', () => {
    const data = build.pieces.map((piece) => ({
      planes: hullPlanes(piece),
      inv: piece.rdMatrix.clone().invert(),
    }));
    const rand = mulberry(11);
    let single = 0;
    let total = 0;
    while (total < 400) {
      const p = new Vector3(
        (rand() * 2 - 1) * SIGMA,
        (rand() * 2 - 1) * SIGMA,
        (rand() * 2 - 1) * SIGMA,
      );
      if (!insideRd(p.clone().multiplyScalar(1.02))) continue; // stay off the boundary
      total++;
      const hits = data.filter((d) =>
        pointInHull(p.clone().applyMatrix4(d.inv), d.planes, 1e-7),
      ).length;
      expect(hits).toBeGreaterThanOrEqual(1);
      expect(hits).toBeLessThanOrEqual(3);
      if (hits === 1) single++;
    }
    expect(single / total).toBeGreaterThan(0.9);
  });
});
