import type { Matrix4, Vector3 } from 'three';

export type MacroShape = 'sphere' | 'box' | 'tetrahedron';
/** Interior symmetry fold count for a part's mid-plane. */
export type SymmetryN = 3 | 4 | 6;
export type LayoutMode = 'chain' | 'free' | 'voronoi';

/**
 * One kinetic part = two halves meeting at an interior symmetry plane.
 * The plane may sit anywhere in 3D with arbitrary orientation.
 */
export interface PartParams {
  symmetryN: SymmetryN;
  /**
   * Degrees: rotation of half B about the interior axis
   * (perpendicular to the symmetry plane).
   */
  angle: number;
  /**
   * Degrees: rotation of half A about the interior axis (free / voronoi).
   * Ignored in chain layout.
   */
  angleA: number;
  /** Interior-plane / seed origin in world space. */
  posX: number;
  posY: number;
  posZ: number;
  /**
   * Euler degrees (ZYX) rotating the default +X axis into the plane normal.
   * Identity ⇒ axis along +X (classic chain).
   */
  rotX: number;
  rotY: number;
  rotZ: number;
  /** When false, hide this part in the viewport (pose/context preserved). */
  visible: boolean;
  /** Symmetry-plane N-gon radius for this part (grows midplane area + volume). */
  planeRadius: number;
  /**
   * Distance from the mid-plane to outer face A (along protrusion).
   * Independent of half B — stubby vs long halves are allowed.
   */
  halfExtentA: number;
  /** Distance from the mid-plane to outer face B. */
  halfExtentB: number;
  /**
   * Protrusion tilt (degrees, ±30) for this part's prism extrusion off the
   * rotation axis toward +xAxis. Default shared at generation; edit per part.
   */
  protrusionTilt: number;
}

export interface DesignParams {
  partCount: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  /**
   * chain = auto-place on +X with path FK.
   * free = independent prisms at arbitrary plane poses (primary).
   * voronoi = experimental domain fill (secondary).
   */
  layoutMode: LayoutMode;
  /** Default half-extent (each side) for newly created parts / chain spacing. */
  linkLength: number;
  /** Default symmetry plane radius applied to newly created parts. */
  contactRadius: number;
  /** Default protrusion tilt (°) applied to newly created parts. */
  protrusionTilt: number;
  facetComplexity: number;
  macroShape: MacroShape;
  /** Bounding region size (box edge / sphere diameter / tetra circumdiameter). */
  macroSize: number;
  /** Gap between adjoining *parts* (not between halves). */
  clearanceGap: number;
  soften: number;
  showAxes: boolean;
  /** Axis arrows for each part's rotational normal. */
  showArrows: boolean;
  /** When false, hide solid half meshes (planes/axes only). */
  showSolids: boolean;
  /**
   * Hide solids and wireframes; show only rotational (symmetry) planes.
   * Independent of showSolids — turning this off restores the prior body mode.
   */
  planesOnly: boolean;
  /** Solid body opacity (1 = opaque). */
  solidOpacity: number;
  showEnvelopes: boolean;
  /** Draw the macro bounding region in the viewport. */
  showBounds: boolean;
  /**
   * Align part rotation axes to edges of a guide polyhedron.
   * `none` = manual / free placement; `tetrahedron` = 6 struts (auto partCount).
   */
  strutGuide: 'none' | 'tetrahedron';
  /**
   * Strut-guide circumdiameter (independent of macro bounding size).
   * Tetra edges are scaled from this alone.
   */
  strutGuideSize: number;
  /** ZYX Euler degrees for the strut guide about the origin. */
  strutGuideRotX: number;
  strutGuideRotY: number;
  strutGuideRotZ: number;
  /** Draw strut-guide edges in the viewport. */
  showStrutGuide: boolean;
  /**
   * Contact faces between parts (internal collisions).
   * Distinct color from bound contacts.
   */
  showPartIntersections: boolean;
  /** Contact faces where parts meet the macro bound (yellow). */
  showBoundIntersections: boolean;
  /**
   * When true, hide every part except `activePart` — without moving or
   * rescaling anything (in-context solo view).
   */
  soloActivePart: boolean;
  snapPreview: boolean;
  activePart: number;
  parts: PartParams[];
}

export interface PartRest {
  id: string;
  index: number;
  origin: Vector3;
  axis: Vector3;
  xAxis: Vector3;
  yAxis: Vector3;
  symmetryN: SymmetryN;
  outerA: Vector3;
  outerB: Vector3;
}

export interface AdjacencyRest {
  partA: number;
  partB: number;
  origin: Vector3;
  normal: Vector3;
  xAxis: Vector3;
  yAxis: Vector3;
}

export interface Skeleton {
  parts: PartRest[];
  adjacencies: AdjacencyRest[];
}

export interface HalfPose {
  matrix: Matrix4;
}

export interface PartKinematics {
  halfA: HalfPose;
  halfB: HalfPose;
}

export const CSG_EPSILON = 0.001;

export function defaultPart(
  index = 0,
  linkLength = 2.2,
  planeRadius = 0.65,
  protrusionTilt = 0,
): PartParams {
  const half = Math.max(0.15, linkLength * 0.5);
  return {
    symmetryN: 4,
    angle: 0,
    angleA: 0,
    posX: index * linkLength,
    posY: 0,
    posZ: 0,
    rotX: 0,
    rotY: 0,
    rotZ: 0,
    visible: true,
    planeRadius,
    halfExtentA: half,
    halfExtentB: half,
    protrusionTilt,
  };
}

export function defaultParams(): DesignParams {
  const params: DesignParams = {
    partCount: 4,
    layoutMode: 'free',
    linkLength: 1.8,
    contactRadius: 0.65,
    protrusionTilt: 0,
    facetComplexity: 0,
    macroShape: 'box',
    macroSize: 5,
    clearanceGap: 0,
    soften: 0,
    showAxes: true,
    showArrows: true,
    showSolids: true,
    planesOnly: false,
    solidOpacity: 0.85,
    showEnvelopes: false,
    showBounds: true,
    strutGuide: 'none',
    strutGuideSize: 5,
    strutGuideRotX: 0,
    strutGuideRotY: 0,
    strutGuideRotZ: 0,
    showStrutGuide: true,
    showPartIntersections: true,
    showBoundIntersections: true,
    soloActivePart: false,
    snapPreview: true,
    activePart: 0,
    parts: [
      defaultPart(0, 1.8, 0.65, 0),
      defaultPart(1, 1.8, 0.65, 0),
      defaultPart(2, 1.8, 0.65, 0),
      defaultPart(3, 1.8, 0.65, 0),
    ],
  };
  rescatterParts(params);
  return params;
}

export function partPlaneRadius(
  params: DesignParams,
  part: PartParams,
): number {
  const r = part.planeRadius ?? params.contactRadius;
  return Math.max(0.05, r);
}

export function partHalfExtent(
  params: DesignParams,
  part: PartParams,
  half: 'A' | 'B',
): number {
  const fallback = Math.max(0.15, params.linkLength * 0.5);
  const raw = half === 'A' ? part.halfExtentA : part.halfExtentB;
  return Math.max(0.1, raw ?? fallback);
}

export function partMaxHalfExtent(
  params: DesignParams,
  part: PartParams,
): number {
  return Math.max(
    partHalfExtent(params, part, 'A'),
    partHalfExtent(params, part, 'B'),
  );
}

export function partProtrusionTilt(
  params: DesignParams,
  part: PartParams,
): number {
  const t = part.protrusionTilt ?? params.protrusionTilt ?? 0;
  return Math.max(-30, Math.min(30, t));
}

/** Grow one part's symmetry-plane area (and thus half volumes). */
export function growPartPlane(
  part: PartParams,
  factor = 1.15,
  maxRadius = 2.5,
): void {
  const cur = part.planeRadius ?? 0.65;
  part.planeRadius = Math.min(maxRadius, Math.max(0.05, cur * factor));
}

export function syncChainLayout(params: DesignParams): void {
  const start = -((params.partCount - 1) * params.linkLength) / 2;
  for (let i = 0; i < params.parts.length; i++) {
    params.parts[i].posX = start + i * params.linkLength;
    params.parts[i].posY = 0;
    params.parts[i].posZ = 0;
  }
}

/** Deterministic seed placement inside the bounding region (initial / fit). */
export function syncVoronoiSeeds(params: DesignParams): void {
  const n = params.partCount;
  // Keep seeds inside both box and sphere of diameter macroSize.
  const h = params.macroSize * 0.5 * 0.55;
  const templates: [number, number, number][] = [
    [-0.55, -0.35, -0.4],
    [0.5, -0.4, 0.35],
    [-0.35, 0.5, 0.45],
    [0.4, 0.35, -0.5],
    [0.15, -0.55, 0.5],
    [-0.5, 0.2, -0.55],
    [0.55, 0.45, 0.15],
    [-0.2, -0.5, 0.55],
  ];
  for (let i = 0; i < n; i++) {
    const t = templates[i % templates.length];
    const jitter = i >= templates.length ? 0.12 : 0;
    params.parts[i].posX = t[0] * h + jitter;
    params.parts[i].posY = t[1] * h - jitter * 0.5;
    params.parts[i].posZ = t[2] * h + jitter * 0.3;
  }
}

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Point inside regular tetrahedron of circumradius `radius` (horizontal base). */
function pointInRegularTetra(
  x: number,
  y: number,
  z: number,
  radius: number,
): boolean {
  const verts = [
    [0, radius, 0],
    [Math.sqrt(8 / 9) * radius, (-1 / 3) * radius, 0],
    [-Math.sqrt(2 / 9) * radius, (-1 / 3) * radius, Math.sqrt(2 / 3) * radius],
    [-Math.sqrt(2 / 9) * radius, (-1 / 3) * radius, -Math.sqrt(2 / 3) * radius],
  ] as const;
  const faces: [number, number, number][] = [
    [1, 3, 2],
    [0, 1, 2],
    [0, 2, 3],
    [0, 3, 1],
  ];
  for (const [i0, i1, i2] of faces) {
    const a = verts[i0];
    const b = verts[i1];
    const c = verts[i2];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const ez = b[2] - a[2];
    const fx = c[0] - a[0];
    const fy = c[1] - a[1];
    const fz = c[2] - a[2];
    let nx = ey * fz - ez * fy;
    let ny = ez * fx - ex * fz;
    let nz = ex * fy - ey * fx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    if (nx * a[0] + ny * a[1] + nz * a[2] > 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const d = nx * a[0] + ny * a[1] + nz * a[2];
    if (nx * x + ny * y + nz * z - d > 1e-6) return false;
  }
  return true;
}

/** Random positions + orientations for every part (free / voronoi). */
export function rescatterParts(params: DesignParams): void {
  ensurePartCount(params);
  const circum = params.macroSize * 0.5;
  // Keep seeds well inside so typical half-extents still fit the bound.
  const maxHalf = Math.max(
    0.15,
    ...params.parts.map((p) =>
      Math.max(p.halfExtentA ?? 0, p.halfExtentB ?? 0, params.linkLength * 0.5),
    ),
  );
  const planeR = Math.max(
    params.contactRadius,
    ...params.parts.map((p) => p.planeRadius ?? params.contactRadius),
  );
  const margin = maxHalf * 0.55 + planeR * 0.35;

  for (const p of params.parts) {
    let x = 0;
    let y = 0;
    let z = 0;
    if (params.macroShape === 'sphere') {
      const seedR = Math.max(0.15, circum * 0.72 - margin);
      do {
        x = randRange(-seedR, seedR);
        y = randRange(-seedR, seedR);
        z = randRange(-seedR, seedR);
      } while (x * x + y * y + z * z > seedR * seedR);
    } else if (params.macroShape === 'tetrahedron') {
      // Inradius = circum/3; shrink further by part size so bodies stay inside.
      const inR = circum / 3;
      const seedR = Math.max(0.12, inR * 0.85 - margin * 0.5);
      let tries = 0;
      do {
        x = randRange(-seedR * 1.2, seedR * 1.2);
        y = randRange(-seedR, seedR);
        z = randRange(-seedR * 1.2, seedR * 1.2);
        tries++;
      } while (
        tries < 120 &&
        !pointInRegularTetra(x, y, z, Math.max(0.2, circum - margin))
      );
      // Fallback: pull toward origin inside the shrunk tetra.
      if (!pointInRegularTetra(x, y, z, Math.max(0.2, circum - margin))) {
        x = randRange(-seedR * 0.4, seedR * 0.4);
        y = randRange(-seedR * 0.3, seedR * 0.5);
        z = randRange(-seedR * 0.4, seedR * 0.4);
      }
    } else {
      const seedH = Math.max(0.15, circum * 0.72 - margin);
      x = randRange(-seedH, seedH);
      y = randRange(-seedH, seedH);
      z = randRange(-seedH, seedH);
    }
    p.posX = x;
    p.posY = y;
    p.posZ = z;
    p.rotX = randRange(-180, 180);
    p.rotY = randRange(-180, 180);
    p.rotZ = randRange(-180, 180);
    p.angle = 0;
    p.angleA = 0;
    if (typeof p.planeRadius !== 'number') {
      p.planeRadius = params.contactRadius;
    }
    if (typeof p.halfExtentA !== 'number') {
      p.halfExtentA = Math.max(0.15, params.linkLength * 0.5);
    }
    if (typeof p.halfExtentB !== 'number') {
      p.halfExtentB = Math.max(0.15, params.linkLength * 0.5);
    }
    if (typeof p.protrusionTilt !== 'number') {
      p.protrusionTilt = params.protrusionTilt;
    }
  }
}

/** @deprecated alias — use rescatterParts */
export function rescatterVoronoiSeeds(params: DesignParams): void {
  rescatterParts(params);
}

/** Scale existing seed positions when the bounding size changes. */
export function scaleVoronoiSeeds(
  params: DesignParams,
  previousSize: number,
): void {
  if (previousSize < 1e-6) {
    syncVoronoiSeeds(params);
    return;
  }
  const s = params.macroSize / previousSize;
  if (Math.abs(s - 1) < 1e-9) return;
  for (const p of params.parts) {
    p.posX *= s;
    p.posY *= s;
    p.posZ *= s;
  }
}

export function ensurePartCount(params: DesignParams): void {
  const needed = params.partCount;
  while (params.parts.length < needed) {
    params.parts.push(
      defaultPart(
        params.parts.length,
        params.linkLength,
        params.contactRadius,
        params.protrusionTilt,
      ),
    );
  }
  if (params.parts.length > needed) {
    params.parts.length = needed;
  }
  for (const p of params.parts) {
    if ((p.symmetryN as number) === 2) p.symmetryN = 4;
    if (typeof p.visible !== 'boolean') p.visible = true;
    if (typeof p.planeRadius !== 'number') p.planeRadius = params.contactRadius;
    if (typeof p.halfExtentA !== 'number') {
      p.halfExtentA = Math.max(0.15, params.linkLength * 0.5);
    }
    if (typeof p.halfExtentB !== 'number') {
      p.halfExtentB = Math.max(0.15, params.linkLength * 0.5);
    }
    if (typeof p.protrusionTilt !== 'number') {
      p.protrusionTilt = params.protrusionTilt ?? 0;
    }
    if (typeof p.angle !== 'number') p.angle = 0;
    if (typeof p.angleA !== 'number') p.angleA = 0;
  }
  if (params.activePart >= needed) {
    params.activePart = Math.max(0, needed - 1);
  }
  if (params.layoutMode === 'chain') {
    syncChainLayout(params);
  } else if (params.layoutMode === 'voronoi') {
    const ys = params.parts.map((p) => Math.abs(p.posY) + Math.abs(p.posZ));
    const flat = ys.every((v) => v < 0.05);
    if (flat) syncVoronoiSeeds(params);
  }
}

export function snapAngle(degrees: number, n: SymmetryN): number {
  const step = 360 / n;
  return Math.round(degrees / step) * step;
}

/** Apply the same N-fold symmetry to every part. */
export function setAllPartsSymmetry(
  params: DesignParams,
  n: SymmetryN,
): void {
  ensurePartCount(params);
  for (const p of params.parts) {
    p.symmetryN = n;
    p.angle = snapAngle(p.angle, n);
    p.angleA = snapAngle(p.angleA ?? 0, n);
  }
}

const SYMMETRY_CHOICES: SymmetryN[] = [3, 4, 6];

/** Assign a random 3/4/6-fold symmetry to each part independently. */
export function randomizeAllPartsSymmetry(params: DesignParams): void {
  ensurePartCount(params);
  for (const p of params.parts) {
    const n = SYMMETRY_CHOICES[Math.floor(Math.random() * SYMMETRY_CHOICES.length)];
    p.symmetryN = n;
    p.angle = snapAngle(p.angle, n);
    p.angleA = snapAngle(p.angleA ?? 0, n);
  }
}

/** Place a part's origin just outside the macro bound along a cardinal direction. */
export function placePartOutsideMacro(
  part: PartParams,
  params: DesignParams,
  slot = 0,
): void {
  const half = effectiveMacroSize(params) * 0.5;
  const reach =
    Math.max(part.halfExtentA, part.halfExtentB, params.linkLength * 0.5) +
    (part.planeRadius ?? params.contactRadius) +
    0.45;
  const dist = half + reach;
  const dirs: [number, number, number][] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
    [0.7, 0.7, 0],
    [-0.7, 0.7, 0],
  ];
  const d = dirs[Math.abs(slot) % dirs.length];
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  part.posX = (d[0] / len) * dist;
  part.posY = (d[1] / len) * dist;
  part.posZ = (d[2] / len) * dist;
}

/**
 * Append one new part (up to 8) outside the bounding volume, using global
 * prism defaults and the Assembly N-fold mode (`random` | 3 | 4 | 6).
 */
export function nucleatePart(
  params: DesignParams,
  nMode: 'random' | SymmetryN = 'random',
): boolean {
  if (params.partCount >= 8) return false;
  if (params.layoutMode === 'chain') params.layoutMode = 'free';

  const nextCount = (params.partCount + 1) as DesignParams['partCount'];
  params.partCount = nextCount;
  ensurePartCount(params);

  const index = params.parts.length - 1;
  const part = params.parts[index];
  const half = Math.max(0.15, params.linkLength * 0.5);
  const choices: SymmetryN[] = [3, 4, 6];
  const n: SymmetryN =
    nMode === 'random'
      ? choices[Math.floor(Math.random() * choices.length)]
      : nMode;

  part.symmetryN = n;
  part.angle = 0;
  part.angleA = 0;
  part.planeRadius = params.contactRadius;
  part.halfExtentA = half;
  part.halfExtentB = half;
  part.protrusionTilt = params.protrusionTilt;
  part.visible = true;
  part.rotX = 0;
  part.rotY = 0;
  part.rotZ = 0;

  placePartOutsideMacro(part, params, index);
  params.activePart = index;
  return true;
}

export function requiredMacroSize(params: DesignParams): number {
  if (params.layoutMode === 'voronoi') {
    return params.macroSize;
  }
  let maxR = params.linkLength * 0.6 + params.contactRadius;
  for (const p of params.parts) {
    const pr = partPlaneRadius(params, p);
    const extent = partMaxHalfExtent(params, p);
    const r = Math.hypot(p.posX, p.posY, p.posZ) + extent * 1.3 + pr;
    maxR = Math.max(maxR, r);
  }
  return maxR * 2 * 1.08;
}

/** Macro domain size used for clipping / Voronoi fill — honors the UI value. */
export function effectiveMacroSize(params: DesignParams): number {
  return Math.max(params.macroSize, 0.5);
}

export function fitMacroToChain(params: DesignParams): boolean {
  // Free / Voronoi: honor the explicit Bounding size (do not auto-grow from scatter).
  if (params.layoutMode !== 'chain') return false;
  const needed = requiredMacroSize(params);
  if (params.macroSize + 1e-6 < needed) {
    params.macroSize = Math.ceil(needed * 10) / 10;
    return true;
  }
  return false;
}
