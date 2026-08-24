import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import type {
  AdjacencyRest,
  DesignParams,
  PartRest,
  Skeleton,
} from '../model/types';
import { effectiveMacroSize, partPlaneRadius, partProtrusionTilt, partHalfExtent } from '../model/types';
import { protrusionDirection } from '../model/skeleton';
import { offsetPolygon, planePolygon } from './contactPolygon';
import { finalizeHull } from './convexHull';
import {
  clipConvexPointsToMacro,
  clampPointToMacroShape,
  tetrahedronClipPlanes,
} from './convexClip';
import {
  aabbFaces,
  clampFacesToSphere,
  clipPolyhedron,
  facesToPoints,
  sphereBoundFaces,
  voronoiBisector,
  type ClipPlane,
} from './polyhedron';
import {
  collectDualSeeds,
  type DualHalfSeed,
  type HalfId as DualHalfId,
} from '../solvers/dualSeeds';

export { finalizeHull } from './convexHull';

function boxCorners(center: Vector3, hx: number, hy: number, hz: number): Vector3[] {
  const corners: Vector3[] = [];
  for (const x of [-hx, hx]) {
    for (const y of [-hy, hy]) {
      for (const z of [-hz, hz]) {
        corners.push(center.clone().add(new Vector3(x, y, z)));
      }
    }
  }
  return corners;
}

export function radialSides(baseN: number, complexity: number): number {
  const c = Math.max(0, Math.round(complexity));
  const base = Math.max(3, baseN);
  if (c <= 0) return base;
  return base * (1 + c);
}

export type HalfId = 'A' | 'B';

function findAdjacencyForOuter(
  skeleton: Skeleton,
  partIndex: number,
  half: HalfId,
): AdjacencyRest | null {
  if (half === 'B') {
    return skeleton.adjacencies.find((a) => a.partA === partIndex) ?? null;
  }
  return skeleton.adjacencies.find((a) => a.partB === partIndex) ?? null;
}

/**
 * Chain/free half: interior N-gon flush at mid-plane → planar outer face.
 * Clearance is applied at part–part outer faces (via skeleton outerA/B + adj origin),
 * not between the two halves of a part.
 */
export function buildHalfHull(
  skeleton: Skeleton,
  part: PartRest,
  params: DesignParams,
  half: HalfId,
): BufferGeometry {
  const softenT = Math.min(
    0.45,
    params.soften / Math.max(params.contactRadius, 0.01),
  );
  const radius = params.contactRadius * (1 - softenT * 0.5);
  const sides = radialSides(part.symmetryN, params.facetComplexity);
  // Keep halves flush at the interior plane; only a tiny soften bevel.
  const interiorOffset = Math.max(params.soften * 0.15, 0.001);

  const sign = half === 'A' ? -1 : 1;
  const outward = part.axis.clone().multiplyScalar(sign);
  const outerCenter = half === 'A' ? part.outerA : part.outerB;
  const span = Math.abs(outerCenter.clone().sub(part.origin).dot(outward));

  const interior = offsetPolygon(
    planePolygon(part, radius, sides),
    outward,
    interiorOffset,
  );

  const adj = findAdjacencyForOuter(skeleton, part.index, half);
  // Pull outer polygon to the clearance face (skeleton already inset outer centers).
  const outerOrigin = adj
    ? half === 'A'
      ? part.outerA.clone()
      : part.outerB.clone()
    : outerCenter.clone();

  const outerFrame = adj
    ? { origin: outerOrigin, xAxis: adj.xAxis, yAxis: adj.yAxis }
    : {
        origin: outerOrigin,
        xAxis: part.xAxis.clone(),
        yAxis: part.yAxis.clone(),
      };

  const outerSides = adj ? 4 : sides;
  const outer = planePolygon(outerFrame, radius, outerSides);

  const points: Vector3[] = [...interior, ...outer];

  if (params.facetComplexity > 0) {
    const rings = Math.round(params.facetComplexity);
    for (let r = 1; r <= rings; r++) {
      const t = r / (rings + 1);
      const along = interiorOffset + (span - interiorOffset) * t;
      const rad = radius * (1 - t * 0.05);
      points.push(
        ...offsetPolygon(planePolygon(part, rad, sides), outward, along),
      );
    }
  }

  try {
    return finalizeHull(points);
  } catch {
    const mid = part.origin.clone().addScaledVector(outward, span * 0.5);
    const h = Math.max(radius, params.linkLength * 0.2);
    return finalizeHull(boxCorners(mid, h, h, h));
  }
}

/**
 * Free-mode prism half: N-gon at mid-plane extruded along tilted axis.
 * Shared tilt at generation is the default; snap rotation is applied via FK.
 */
export function buildPrismHalfHull(
  part: PartRest,
  params: DesignParams,
  half: HalfId,
): BufferGeometry {
  const pp = params.parts[part.index];
  const planeR = partPlaneRadius(params, pp);
  const softenT = Math.min(0.45, params.soften / Math.max(planeR, 0.01));
  const radius = planeR * (1 - softenT * 0.5);
  const sides = radialSides(part.symmetryN, params.facetComplexity);
  const interiorOffset = Math.max(params.soften * 0.15, 0.001);
  const extent = partHalfExtent(params, pp, half);
  const tilt = partProtrusionTilt(params, pp);
  const dir = protrusionDirection(part.axis, part.xAxis, tilt);
  const sign = half === 'A' ? -1 : 1;
  const outward = dir.clone().multiplyScalar(sign);

  const interior = offsetPolygon(
    planePolygon(part, radius, sides),
    outward,
    interiorOffset,
  );
  const outerOrigin = part.origin.clone().addScaledVector(dir, sign * extent);
  const outer = planePolygon(
    {
      origin: outerOrigin,
      xAxis: part.xAxis,
      yAxis: part.yAxis,
    },
    radius,
    sides,
  );

  const points: Vector3[] = [...interior, ...outer];

  if (params.facetComplexity > 0) {
    const rings = Math.round(params.facetComplexity);
    for (let r = 1; r <= rings; r++) {
      const t = r / (rings + 1);
      const along = interiorOffset + (extent - interiorOffset) * t;
      const rad = radius * (1 - t * 0.05);
      points.push(
        ...offsetPolygon(planePolygon(part, rad, sides), outward, along),
      );
    }
  }

  try {
    return finalizeHull(points);
  } catch {
    const mid = part.origin.clone().addScaledVector(outward, extent * 0.5);
    const h = Math.max(radius, extent * 0.4);
    return finalizeHull(boxCorners(mid, h, h, h));
  }
}

function macroBoundFaces(
  params: DesignParams,
  half: number,
): Vector3[][] {
  let faces =
    params.macroShape === 'sphere'
      ? sphereBoundFaces(half, 10)
      : aabbFaces(half);
  if (params.macroShape === 'tetrahedron') {
    for (const pl of tetrahedronClipPlanes(half)) {
      faces = clipPolyhedron(faces, pl);
      if (!faces.length) break;
    }
  }
  return faces;
}

function softenFacesTowardSeed(
  faces: Vector3[][],
  seed: Vector3,
  params: DesignParams,
  half: number,
): Vector3[][] {
  if (params.soften <= 1e-6 || !faces.length) return faces;
  const s = Math.min(0.25, params.soften / Math.max(half, 0.1));
  return faces.map((face) =>
    face.map((p) => {
      const q = p.clone().lerp(seed, s);
      clampPointToMacro(q, params.macroShape, half);
      return q;
    }),
  );
}

/** Voronoi cell for seed i inside the macro domain, with part–part clearance. */
export function buildVoronoiCellFaces(
  skeleton: Skeleton,
  params: DesignParams,
  partIndex: number,
): Vector3[][] {
  const macro = effectiveMacroSize(params);
  const half = macro * 0.5;
  let faces = macroBoundFaces(params, half);
  const seed = skeleton.parts[partIndex].origin.clone();
  // Keep the generative seed inside the domain so soften/bisectors stay valid.
  clampPointToMacro(seed, params.macroShape, half);
  const gap = Math.max(0, params.clearanceGap);

  for (let j = 0; j < skeleton.parts.length; j++) {
    if (j === partIndex) continue;
    const other = skeleton.parts[j].origin.clone();
    clampPointToMacro(other, params.macroShape, half);
    const plane = voronoiBisector(seed, other, gap);
    faces = clipPolyhedron(faces, plane);
    if (faces.length === 0) break;
  }

  if (params.macroShape === 'sphere' && faces.length) {
    faces = clampFacesToSphere(faces, half);
  }

  return softenFacesTowardSeed(faces, seed, params, half);
}

function clampPointToMacro(
  p: Vector3,
  shape: DesignParams['macroShape'],
  half: number,
): void {
  clampPointToMacroShape(p, shape, half);
}

export function buildVoronoiCellPoints(
  skeleton: Skeleton,
  params: DesignParams,
  partIndex: number,
): Vector3[] {
  return facesToPoints(buildVoronoiCellFaces(skeleton, params, partIndex));
}

/**
 * Voronoi cell for one half-seed among all 2N dual half-seeds.
 * Same-part opposite half uses gap 0 so the midplane is the exact bisector;
 * other parts use clearanceGap.
 */
export function buildDualSeedVoronoiCellFaces(
  skeleton: Skeleton,
  params: DesignParams,
  partIndex: number,
  half: DualHalfId,
  allSeeds?: DualHalfSeed[],
): Vector3[][] {
  const macro = effectiveMacroSize(params);
  const halfSize = macro * 0.5;
  const seeds = allSeeds ?? collectDualSeeds(skeleton, params);
  const self = seeds.find(
    (s) => s.partIndex === partIndex && s.half === half,
  );
  if (!self) return [];

  let faces = macroBoundFaces(params, halfSize);
  const seed = self.position.clone();
  const partGap = Math.max(0, params.clearanceGap);

  for (const other of seeds) {
    if (other.partIndex === partIndex && other.half === half) continue;
    const samePart = other.partIndex === partIndex;
    const gap = samePart ? 0 : partGap;
    const plane = voronoiBisector(seed, other.position, gap);
    faces = clipPolyhedron(faces, plane);
    if (faces.length === 0) break;
  }

  if (params.macroShape === 'sphere' && faces.length) {
    faces = clampFacesToSphere(faces, halfSize);
  }

  return softenFacesTowardSeed(faces, seed, params, halfSize);
}

function splitCellByInteriorPlane(
  cellFaces: Vector3[][],
  part: PartRest,
  half: HalfId,
  interiorOffset: number,
  _contactRadius: number,
  _symmetryN: number,
): Vector3[] {
  const n = part.axis.clone().normalize();
  const plane: ClipPlane =
    half === 'A'
      ? { n: n.clone(), d: n.dot(part.origin) - interiorOffset }
      : {
          n: n.clone().multiplyScalar(-1),
          d: -n.dot(part.origin) - interiorOffset,
        };

  // Use only the clipped cell — do not inject an oversized N-gon that would
  // escape the macro bounds when hulled.
  const clipped = clipPolyhedron(cellFaces, plane);
  return facesToPoints(clipped);
}

/** Legacy fallback: full cell then split by interior plane. */
function buildVoronoiHalfHullLegacy(
  skeleton: Skeleton,
  part: PartRest,
  params: DesignParams,
  half: HalfId,
): BufferGeometry {
  const cellFaces = buildVoronoiCellFaces(skeleton, params, part.index);
  const interiorOffset = Math.max(params.soften * 0.15, 0.001);
  const pts = splitCellByInteriorPlane(
    cellFaces,
    part,
    half,
    interiorOffset,
    params.contactRadius,
    part.symmetryN,
  );
  try {
    return finalizeHull(pts);
  } catch {
    const sign = half === 'A' ? -1 : 1;
    const mid = part.origin
      .clone()
      .addScaledVector(part.axis, sign * params.linkLength * 0.2);
    const h = params.contactRadius;
    return finalizeHull(boxCorners(mid, h, h, h));
  }
}

/**
 * Dual-seed Voronoi half: cell of this half-seed among all 2N half-seeds.
 * Falls back to cell-then-split if the dual-seed cell collapses.
 */
export function buildVoronoiHalfHull(
  skeleton: Skeleton,
  part: PartRest,
  params: DesignParams,
  half: HalfId,
  allSeeds?: DualHalfSeed[],
): BufferGeometry {
  const faces = buildDualSeedVoronoiCellFaces(
    skeleton,
    params,
    part.index,
    half,
    allSeeds,
  );
  if (faces.length >= 4) {
    const pts = facesToPoints(faces);
    if (pts.length >= 4) {
      try {
        return finalizeHull(pts);
      } catch {
        /* fall through */
      }
    }
  }
  return buildVoronoiHalfHullLegacy(skeleton, part, params, half);
}

export interface PartHalvesGeometry {
  halfA: BufferGeometry;
  halfB: BufferGeometry;
}

export function buildAllPartHalves(
  skeleton: Skeleton,
  params: DesignParams,
): PartHalvesGeometry[] {
  if (params.layoutMode === 'voronoi') {
    const allSeeds = collectDualSeeds(skeleton, params);
    return skeleton.parts.map((part) => ({
      halfA: buildVoronoiHalfHull(skeleton, part, params, 'A', allSeeds),
      halfB: buildVoronoiHalfHull(skeleton, part, params, 'B', allSeeds),
    }));
  }
  if (params.layoutMode === 'free') {
    return skeleton.parts.map((part) => ({
      halfA: buildPrismHalfHull(part, params, 'A'),
      halfB: buildPrismHalfHull(part, params, 'B'),
    }));
  }
  return skeleton.parts.map((part) => ({
    halfA: buildHalfHull(skeleton, part, params, 'A'),
    halfB: buildHalfHull(skeleton, part, params, 'B'),
  }));
}

export function softClipToMacro(
  geometry: BufferGeometry,
  params: DesignParams,
  macroSize: number,
): BufferGeometry {
  const pos = geometry.attributes.position as BufferAttribute;
  const pts: Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    pts.push(new Vector3().fromBufferAttribute(pos, i));
  }
  const clipped = clipConvexPointsToMacro(pts, params, macroSize);
  try {
    return finalizeHull(clipped);
  } catch {
    return geometry.clone();
  }
}
