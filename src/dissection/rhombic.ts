/**
 * Exact cube ↔ rhombic dodecahedron dissection.
 *
 * Math: an RD of volume 1 is exactly a core cube of side σ = 2^(-1/3)
 * plus 6 square pyramids (base σ×σ, height σ/2) seated on its faces —
 * and those 6 pyramids themselves tile a second σ-cube.
 * So the construction is:
 *
 *   unit cube ──(slide dissection in xy)──▶ box σ × 1/σ × 1
 *             ──(slide dissection in yz)──▶ box σ × σ × 2σ  (two σ-cubes)
 *             ──(z-cut + pyramid cuts)────▶ RD core + 6 face pyramids
 *
 * Each slide stage is the classic strip-tiling dissection (finite, exact,
 * translations + one frame rotation). All cuts are planar, all pieces are
 * convex polytopes, and both assemblies are exact by construction.
 */
import { BufferAttribute, BufferGeometry, Matrix4, Plane, Vector3 } from 'three';
import { aabbFaces, clipPolyhedron, type ClipPlane } from '../geom/polyhedron';

/** Side of the RD core cube (= cube-root of 1/2). */
export const SIGMA = Math.cbrt(0.5);

/* ------------------------------------------------------------------ */
/* 2D slide dissection: rectangle a×b → rectangle c×d (ab = cd, c < a) */
/* ------------------------------------------------------------------ */

export type Vec2 = { x: number; y: number };

/** 2D rigid motion p → R·p + t with R = [[m00,m01],[m10,m11]], det = +1. */
export type Motion2 = {
  m00: number;
  m01: number;
  m10: number;
  m11: number;
  tx: number;
  ty: number;
};

export type Piece2 = {
  /** Convex polygon in source-rectangle coordinates [0,a]×[0,b]. */
  poly: Vec2[];
  /** Rigid motion into target-rectangle coordinates [0,c]×[0,d]. */
  motion: Motion2;
  tag: string;
};

export function applyMotion2(m: Motion2, p: Vec2): Vec2 {
  return {
    x: m.m00 * p.x + m.m01 * p.y + m.tx,
    y: m.m10 * p.x + m.m11 * p.y + m.ty,
  };
}

function polygonArea(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

/** Sutherland–Hodgman: keep the side n·p <= d of a convex polygon. */
function clipPolygon(poly: Vec2[], nx: number, ny: number, d: number): Vec2[] {
  const out: Vec2[] = [];
  const eps = 1e-12;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const sp = nx * p.x + ny * p.y - d;
    const sq = nx * q.x + ny * q.y - d;
    if (sp <= eps) out.push(p);
    if ((sp < -eps && sq > eps) || (sp > eps && sq < -eps)) {
      const t = sp / (sp - sq);
      out.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
    }
  }
  return out;
}

/** Clip `poly` to convex polygon `region` (CCW). */
function clipToConvex(poly: Vec2[], region: Vec2[]): Vec2[] {
  let out = poly;
  for (let i = 0; i < region.length && out.length >= 3; i++) {
    const p = region[i];
    const q = region[(i + 1) % region.length];
    // CCW region: interior is left of p→q; outward normal = (ty, -tx).
    const nx = q.y - p.y;
    const ny = -(q.x - p.x);
    out = clipPolygon(out, nx, ny, nx * p.x + ny * p.y);
  }
  return out.length >= 3 ? out : [];
}

function translatePoly(poly: Vec2[], dx: number, dy: number): Vec2[] {
  return poly.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

export type StripPhase = {
  /** Phase of the sheared strip tiling, in units of a (0 ≤ psi < 1). */
  psi: number;
  /** Phase of the target strip tiling, in units of d (0 ≤ phi < 1). */
  phi: number;
  /** Shear the strip the other way (mirror-conjugated construction). */
  mirror?: boolean;
};

/**
 * Exact dissection of rectangle [0,a]×[0,b] into rectangle [0,c]×[0,d]
 * (ab = cd, c < a). Two strip-tiling passes:
 *  1. re-tile modulo (a,0) into the parallelogram P* with side v = (e,b),
 *     |v| = d  (e = √(d²−b²));
 *  2. re-tile P* modulo v into a d×c rectangle aligned with v, then rotate
 *     the frame so it becomes [0,c]×[0,d].
 * Every motion is a translation composed with one shared rotation → rigid.
 * `phase` shifts where each strip tiling is anchored; any phase is exact,
 * but some phases produce fewer pieces.
 */
export function rectToRect(
  a: number,
  b: number,
  c: number,
  d: number,
  phase: StripPhase = { psi: 0, phi: 0 },
): Piece2[] {
  if (Math.abs(a * b - c * d) > 1e-9) throw new Error('rectToRect: area mismatch');
  if (Math.abs(a - c) < 1e-12) {
    return [
      {
        poly: [
          { x: 0, y: 0 },
          { x: a, y: 0 },
          { x: a, y: b },
          { x: 0, y: b },
        ],
        motion: { m00: 1, m01: 0, m10: 0, m11: 1, tx: 0, ty: 0 },
        tag: 'id',
      },
    ];
  }
  if (c > a) throw new Error('rectToRect: expected c < a');

  if (phase.mirror) {
    // Conjugate by x-mirrors of source and target: reflect the problem,
    // solve, reflect back. Reflection ∘ rotation ∘ reflection = rotation.
    const inner = rectToRect(a, b, c, d, { ...phase, mirror: false });
    return inner.map((piece) => {
      const { m00, m01, m10, m11, tx, ty } = piece.motion;
      return {
        poly: piece.poly.map((p) => ({ x: a - p.x, y: p.y })),
        // q = S_c ∘ M ∘ S_a: linear [[m00, -m01], [-m10, m11]],
        // translation (c - m00·a - tx, m10·a + ty).
        motion: {
          m00,
          m01: -m01,
          m10: -m10,
          m11,
          tx: c - m00 * a - tx,
          ty: m10 * a + ty,
        },
        tag: `${piece.tag}m`,
      };
    });
  }

  const e = Math.sqrt(d * d - b * b);
  const v = { x: e, y: b };
  const vhat = { x: e / d, y: b / d };
  const nhat = { x: -b / d, y: e / d };
  const shift = phase.psi * a;

  const source: Vec2[] = [
    { x: 0, y: 0 },
    { x: a, y: 0 },
    { x: a, y: b },
    { x: 0, y: b },
  ];
  // Sheared fundamental domain of the strip 0≤y≤b (mod (a,0)), phase-shifted.
  const pstar: Vec2[] = [
    { x: shift, y: 0 },
    { x: shift + a, y: 0 },
    { x: shift + a + e, y: b },
    { x: shift + e, y: b },
  ];
  // Target window in (v̂, n̂) coordinates: α∈[α0, α0+d], β∈[β0−c, β0].
  const beta0 = -c * phase.psi;
  const alpha0 = phase.phi * d;
  const corner = (al: number, be: number): Vec2 => ({
    x: al * vhat.x + be * nhat.x,
    y: al * vhat.y + be * nhat.y,
  });
  const r2: Vec2[] = [
    corner(alpha0, beta0),
    corner(alpha0, beta0 - c),
    corner(alpha0 + d, beta0 - c),
    corner(alpha0 + d, beta0),
  ];
  if (polygonArea(r2) < 0) r2.reverse();

  // Final frame map: q → (β0 − q·n̂, q·v̂ − α0)  (rotation, det +1).
  const M = { m00: -nhat.x, m01: -nhat.y, m10: vhat.x, m11: vhat.y };

  const jMax = Math.ceil(e / a + phase.psi) + 2;
  const kMax = Math.ceil((a * (e / d) + d) / d) + 3;
  const pieces: Piece2[] = [];
  for (let j = -2; j <= jMax; j++) {
    const pj = translatePoly(pstar, -j * a, 0);
    const regionJ = clipToConvex(source, pj);
    if (regionJ.length < 3 || Math.abs(polygonArea(regionJ)) < 1e-10) continue;
    for (let k = -3; k <= kMax; k++) {
      const rk = translatePoly(r2, k * v.x - j * a, k * v.y);
      const region = clipToConvex(regionJ, rk);
      if (region.length < 3 || Math.abs(polygonArea(region)) < 1e-10) continue;
      // p → M · (p + (ja,0) − k·v) + (β0, −α0)
      const sx = j * a - k * v.x;
      const sy = -k * v.y;
      pieces.push({
        poly: region,
        motion: {
          ...M,
          tx: M.m00 * sx + M.m01 * sy + beta0,
          ty: M.m10 * sx + M.m11 * sy - alpha0,
        },
        tag: `j${j}k${k}`,
      });
    }
  }
  return pieces;
}

/* ------------------------------------------------------------------ */
/* 3D composition                                                      */
/* ------------------------------------------------------------------ */

type Stage3D = {
  /** Half-space description of the region, in the stage's input frame. */
  planes: ClipPlane[];
  /** Rigid motion from the stage's input frame to its output frame. */
  motion: Matrix4;
  tag: string;
};

/** CCW-orient a polygon, then emit its edges as inward 3D clip planes. */
function polygonPlanes(
  poly: Vec2[],
  embed: (x: number, y: number) => Vector3,
  embedNormal: (nx: number, ny: number) => Vector3,
): ClipPlane[] {
  const ccw = polygonArea(poly) >= 0 ? poly : [...poly].reverse();
  const planes: ClipPlane[] = [];
  for (let i = 0; i < ccw.length; i++) {
    const p = ccw[i];
    const q = ccw[(i + 1) % ccw.length];
    const nx = q.y - p.y;
    const ny = -(q.x - p.x);
    const len = Math.hypot(nx, ny);
    if (len < 1e-12) continue;
    const n = embedNormal(nx / len, ny / len);
    planes.push({ n, d: n.dot(embed(p.x, p.y)) });
  }
  return planes;
}

function motion2ToMatrix(
  m: Motion2,
  axes: 'xy' | 'yz',
): Matrix4 {
  const mat = new Matrix4();
  if (axes === 'xy') {
    mat.set(
      m.m00, m.m01, 0, m.tx,
      m.m10, m.m11, 0, m.ty,
      0, 0, 1, 0,
      0, 0, 0, 1,
    );
  } else {
    mat.set(
      1, 0, 0, 0,
      0, m.m00, m.m01, m.tx,
      0, m.m10, m.m11, m.ty,
      0, 0, 0, 1,
    );
  }
  return mat;
}

function liftStage(pieces2: Piece2[], axes: 'xy' | 'yz', prefix: string): Stage3D[] {
  const embed =
    axes === 'xy'
      ? (x: number, y: number) => new Vector3(x, y, 0)
      : (x: number, y: number) => new Vector3(0, x, y);
  const embedNormal = embed;
  return pieces2.map((p) => ({
    planes: polygonPlanes(p.poly, embed, embedNormal),
    motion: motion2ToMatrix(p.motion, axes),
    tag: `${prefix}${p.tag}`,
  }));
}

const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];

/** Stage 3: split box σ×σ×2σ into RD core (bottom cube) + 6 pyramids (top). */
function stage3(): Stage3D[] {
  const s = SIGMA;
  const out: Stage3D[] = [];

  out.push({
    planes: [{ n: new Vector3(0, 0, 1), d: s }],
    motion: new Matrix4().makeTranslation(-s / 2, -s / 2, -s / 2),
    tag: 'core',
  });

  const ctr = new Vector3(s / 2, s / 2, 1.5 * s);
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [1, -1]) {
      const n = AXES[axis].clone().multiplyScalar(sign);
      const planes: ClipPlane[] = [{ n: new Vector3(0, 0, -1), d: -s }];
      for (const perpAxis of [(axis + 1) % 3, (axis + 2) % 3]) {
        for (const ps of [1, -1]) {
          // (p−ctr)·n ≥ ps·(p−ctr)·w  ⇔  (ps·w − n)·p ≤ (ps·w − n)·ctr
          const nn = AXES[perpAxis]
            .clone()
            .multiplyScalar(ps)
            .sub(n)
            .normalize();
          planes.push({ n: nn, d: nn.dot(ctr) });
        }
      }
      // Base center in box frame / on the centered RD core.
      const b0 = ctr.clone().addScaledVector(n, s / 2);
      const b1 = n.clone().multiplyScalar(s / 2);
      const u = AXES[(axis + 1) % 3];
      const motion = new Matrix4()
        .makeTranslation(b1.x, b1.y, b1.z)
        .multiply(new Matrix4().makeRotationAxis(u, Math.PI))
        .multiply(new Matrix4().makeTranslation(-b0.x, -b0.y, -b0.z));
      const label = `${sign > 0 ? '+' : '-'}${'xyz'[axis]}`;
      out.push({ planes, motion, tag: `pyr${label}` });
    }
  }
  return out;
}

/** Pull a clip plane back through rigid motion m (plane in m's output frame). */
function pullbackPlane(plane: ClipPlane, m: Matrix4): ClipPlane {
  const p = new Plane(plane.n.clone(), -plane.d);
  p.applyMatrix4(m.clone().invert());
  return { n: p.normal.clone(), d: -p.constant };
}

/**
 * Clip a convex face-list polyhedron, skipping no-op planes.
 * clipPolyhedron would add a duplicate cap face when the plane coincides with
 * an existing boundary face (inflating volume); for a convex body a plane
 * that contains a face never cuts the interior, so skipping is exact.
 */
function clipConvexFaces(faces: Vector3[][], plane: ClipPlane): Vector3[][] {
  let worst = -Infinity;
  for (const face of faces) {
    for (const p of face) {
      const s = plane.n.dot(p) - plane.d;
      if (s > worst) worst = s;
    }
  }
  if (worst <= 1e-9) return faces;
  return clipPolyhedron(faces, plane);
}

/** Signed volume of a convex polyhedron given as outward-wound face polygons. */
function facesVolume(faces: Vector3[][]): number {
  let sum = 0;
  const cross = new Vector3();
  for (const face of faces) {
    for (let i = 1; i + 1 < face.length; i++) {
      cross.crossVectors(face[i], face[i + 1]);
      sum += face[0].dot(cross);
    }
  }
  return sum / 6;
}

/** Fan-triangulate face polygons into a flat-shaded BufferGeometry. */
function facesToGeometry(faces: Vector3[][]): BufferGeometry {
  const positions: number[] = [];
  for (const face of faces) {
    for (let i = 1; i + 1 < face.length; i++) {
      positions.push(
        face[0].x, face[0].y, face[0].z,
        face[i].x, face[i].y, face[i].z,
        face[i + 1].x, face[i + 1].y, face[i + 1].z,
      );
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

export type RhombicPiece = {
  id: string;
  label: string;
  role: 'core' | 'pyramid';
  geometry: BufferGeometry;
  volume: number;
  color: number;
  cubeSlot: string;
  rdSlot: string;
  cubeMatrix: Matrix4;
  rdMatrix: Matrix4;
  axis: Vector3;
};

const CORE_COLORS = [
  0x3498db, 0x2980b9, 0x1abc9c, 0x16a085, 0x5dade2, 0x48c9b0,
  0x9b59b6, 0x8e44ad, 0x76d7c4, 0x85c1e9, 0x6c5ce7, 0x74b9ff,
];
const PYRAMID_COLORS = [
  0xe74c3c, 0xe67e22, 0xf1c40f, 0x2ecc71, 0xe84393, 0x00cec9,
  0xc0392b, 0xd35400, 0xf39c12, 0x27ae60, 0xfd79a8, 0x00b894,
  0xff7675, 0xfdcb6e, 0x55efc4, 0x81ecec, 0xa29bfe, 0xffeaa7,
];

export type RhombicBuild = {
  pieces: RhombicPiece[];
  /** Σ piece volumes (should equal 1). */
  totalVolume: number;
  /** RD vertices (centered, volume 1) for wireframes / checks. */
  rdVertices: Vector3[];
};

/** RD of volume 1 centered at origin: 6 axis vertices ±σ, 8 at (±σ/2)³. */
export function rdVertices(): Vector3[] {
  const s = SIGMA;
  const verts: Vector3[] = [];
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [1, -1]) {
      verts.push(AXES[axis].clone().multiplyScalar(sign * s));
    }
  }
  for (const sx of [1, -1])
    for (const sy of [1, -1])
      for (const sz of [1, -1]) verts.push(new Vector3(sx, sy, sz).multiplyScalar(s / 2));
  return verts;
}

/** Point-in-RD test for the centered, volume-1 RD. */
export function insideRd(p: Vector3, eps = 1e-6): boolean {
  const s = SIGMA;
  return (
    Math.abs(p.x) + Math.abs(p.y) <= s + eps &&
    Math.abs(p.y) + Math.abs(p.z) <= s + eps &&
    Math.abs(p.x) + Math.abs(p.z) <= s + eps
  );
}

const MIN_PIECE_VOLUME = 1e-7;

export type RhombicOptions = {
  phase1?: StripPhase;
  phase2?: StripPhase;
};

/**
 * Phases found by grid search: 32 pieces with the largest "smallest piece"
 * (min volume ≈ 4.3e-4) on the Pareto front. 31 pieces is possible but its
 * smallest piece is ~3× smaller.
 */
export const DEFAULT_PHASES: Required<RhombicOptions> = {
  phase1: { psi: 0, phi: 0.375, mirror: true },
  phase2: { psi: 0.375, phi: 0.375, mirror: true },
};

export function buildRhombicPieces(opts: RhombicOptions = {}): RhombicBuild {
  const s = SIGMA;
  const phase1 = opts.phase1 ?? DEFAULT_PHASES.phase1;
  const phase2 = opts.phase2 ?? DEFAULT_PHASES.phase2;

  const stage1 = liftStage(rectToRect(1, 1, s, 1 / s, phase1), 'xy', 'A');
  const stage2 = liftStage(rectToRect(1 / s, 1, s, 2 * s, phase2), 'yz', 'B');
  const stages = [stage1, stage2, stage3()];

  // Faces stay in the unit-cube frame; m accumulates frame0 → current frame.
  type Working = { faces: Vector3[][]; m: Matrix4; tags: string[] };
  const unitCubeFaces = aabbFaces(0.5).map((face) =>
    face.map((p) => p.addScalar(0.5)),
  );
  let working: Working[] = [{ faces: unitCubeFaces, m: new Matrix4(), tags: [] }];

  for (const stage of stages) {
    const next: Working[] = [];
    for (const piece of working) {
      for (const region of stage) {
        let faces = piece.faces;
        for (const plane of region.planes) {
          faces = clipConvexFaces(faces, pullbackPlane(plane, piece.m));
          if (faces.length < 4) break;
        }
        if (faces.length < 4 || facesVolume(faces) < MIN_PIECE_VOLUME) continue;
        next.push({
          faces,
          m: region.motion.clone().multiply(piece.m),
          tags: [...piece.tags, region.tag],
        });
      }
    }
    working = next;
  }

  const center = new Matrix4().makeTranslation(0.5, 0.5, 0.5);
  const pieces: RhombicPiece[] = [];
  let totalVolume = 0;
  let coreIdx = 0;
  let pyrIdx = 0;

  for (const w of working) {
    const role: RhombicPiece['role'] = w.tags[2] === 'core' ? 'core' : 'pyramid';
    const centeredFaces = w.faces.map((face) =>
      face.map((p) => p.clone().subScalar(0.5)),
    );
    const geometry = facesToGeometry(centeredFaces);
    const volume = facesVolume(centeredFaces);
    totalVolume += volume;
    const rdMatrix = w.m.clone().multiply(center);
    const flat = centeredFaces.flat();
    const centroid = flat
      .reduce((acc, p) => acc.add(p.clone()), new Vector3())
      .multiplyScalar(1 / Math.max(1, flat.length));
    const idx = role === 'core' ? coreIdx++ : pyrIdx++;
    const palette = role === 'core' ? CORE_COLORS : PYRAMID_COLORS;
    pieces.push({
      id: w.tags.join('·'),
      label: `${role === 'core' ? 'core' : w.tags[2]} · ${w.tags[0]} ${w.tags[1]}`,
      role,
      geometry,
      volume,
      color: palette[idx % palette.length],
      cubeSlot: `${w.tags[0]} ${w.tags[1]}`,
      rdSlot: role === 'core' ? 'core cube' : `pyramid ${w.tags[2]!.slice(3)}`,
      cubeMatrix: new Matrix4(),
      rdMatrix,
      axis: centroid.lengthSq() > 1e-10 ? centroid.normalize() : new Vector3(0, 0, 1),
    });
  }

  return { pieces, totalVolume, rdVertices: rdVertices() };
}
