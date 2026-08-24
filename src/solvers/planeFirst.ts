import { Vector3 } from 'three';
import type { DesignParams, PartParams, SymmetryN } from '../model/types';
import {
  defaultParams,
  defaultPart,
  ensurePartCount,
} from '../model/types';
import { axesFromPartEuler, eulerDegreesFromAxis } from '../model/skeleton';
import { planePolygon } from '../geom/contactPolygon';
import { pointInsideMacroShape } from '../geom/convexClip';

export type SymmetryMode = 'random' | SymmetryN;

export interface PlaneFirstOptions {
  partCount: 4 | 5 | 6 | 7 | 8;
  /** Macro box edge length. */
  macroSize?: number;
  contactRadius?: number;
  clearanceGap?: number;
  symmetryMode?: SymmetryMode;
  /** Dual-seed half extent (both sides). */
  halfExtent?: number;
  /** RNG in [0, 1). Defaults to Math.random. */
  random?: () => number;
}

export interface SeededRng {
  next: () => number;
}

/** Mulberry32 — deterministic for tests. */
export function createSeededRng(seed: number): SeededRng {
  let t = seed >>> 0;
  return {
    next: () => {
      t += 0x6d2b79f5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    },
  };
}

function randRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

function pickSymmetry(mode: SymmetryMode, rng: () => number): SymmetryN {
  if (mode === 3 || mode === 4 || mode === 6) return mode;
  const choices: SymmetryN[] = [3, 4, 6];
  return choices[Math.floor(rng() * choices.length)]!;
}

/** Uniform random unit vector. */
function randomUnitNormal(rng: () => number): Vector3 {
  let x: number;
  let y: number;
  let s: number;
  do {
    x = rng() * 2 - 1;
    y = rng() * 2 - 1;
    s = x * x + y * y;
  } while (s >= 1 || s < 1e-12);
  const z = 1 - 2 * s;
  const f = 2 * Math.sqrt(1 - s);
  return new Vector3(x * f, y * f, z).normalize();
}

/**
 * Shrink planeRadius until all N-gon vertices lie inside the macro (with margin).
 * Uses the same x/y basis the skeleton will use from the part Euler angles.
 */
export function fitPlaneRadiusInMacro(
  origin: Vector3,
  xAxis: Vector3,
  yAxis: Vector3,
  sides: number,
  desiredRadius: number,
  macroShape: DesignParams['macroShape'],
  macroHalf: number,
  margin = 0.12,
): number {
  const frame = {
    origin,
    xAxis: xAxis.clone().normalize(),
    yAxis: yAxis.clone().normalize(),
  };
  let r = desiredRadius;
  for (let attempt = 0; attempt < 14; attempt++) {
    const poly = planePolygon(frame, r, sides);
    const ok = poly.every((p) =>
      pointInsideMacroShape(p, macroShape, macroHalf, margin),
    );
    if (ok) return r;
    r *= 0.7;
    if (r < 0.1) break;
  }
  const poly = planePolygon(frame, Math.max(0.08, r), sides);
  const ok = poly.every((p) =>
    pointInsideMacroShape(p, macroShape, macroHalf, margin),
  );
  return ok ? Math.max(0.08, r) : 0;
}

/**
 * Generate one plane-first Voronoi candidate as DesignParams.
 * Places midplanes first, sizes radii to fit bounds, sets dual-seed extents.
 */
export function generatePlaneFirstLayout(
  options: PlaneFirstOptions,
): DesignParams {
  const rng = options.random ?? Math.random;
  const partCount = options.partCount;
  const macroSize = options.macroSize ?? 6.5;
  // Keep disks modest so bounds + separation succeed more often.
  const contactRadius = options.contactRadius ?? 0.4;
  const clearanceGap = options.clearanceGap ?? 0.08;
  const halfExtent = options.halfExtent ?? Math.max(0.35, macroSize * 0.1);
  const symmetryMode = options.symmetryMode ?? 'random';
  const macroHalf = macroSize * 0.5;

  const params = defaultParams();
  params.partCount = partCount;
  params.layoutMode = 'voronoi';
  params.macroShape = 'box';
  params.macroSize = macroSize;
  params.contactRadius = contactRadius;
  params.clearanceGap = clearanceGap;
  params.soften = 0;
  params.facetComplexity = 0;
  params.strutGuide = 'none';
  params.showStrutGuide = false;
  params.linkLength = halfExtent * 2;
  params.protrusionTilt = 0;
  params.parts = [];

  // Keep centers well inside so footprints clear walls.
  const minSep = Math.max(0.55, contactRadius * 1.35);
  const centerMargin =
    Math.max(contactRadius * 1.2, halfExtent * 0.5) + macroHalf * 0.18;
  const centerHalf = Math.max(0.25, macroHalf - centerMargin);

  const placedOrigins: Vector3[] = [];

  for (let i = 0; i < partCount; i++) {
    const symmetryN = pickSymmetry(symmetryMode, rng);
    const axis = randomUnitNormal(rng);
    const twist = randRange(rng, -180, 180);
    const { rotX, rotY, rotZ } = eulerDegreesFromAxis(axis, twist);
    // Match skeleton basis exactly (includes twist).
    const { xAxis, yAxis } = axesFromPartEuler(rotX, rotY, rotZ);

    let posX = 0;
    let posY = 0;
    let posZ = 0;
    let planeRadius = 0;
    let placed = false;

    for (let tryPos = 0; tryPos < 60 && !placed; tryPos++) {
      posX = randRange(rng, -centerHalf, centerHalf);
      posY = randRange(rng, -centerHalf, centerHalf);
      posZ = randRange(rng, -centerHalf, centerHalf);
      const origin = new Vector3(posX, posY, posZ);
      if (placedOrigins.some((o) => o.distanceTo(origin) < minSep)) {
        continue;
      }
      planeRadius = fitPlaneRadiusInMacro(
        origin,
        xAxis,
        yAxis,
        symmetryN,
        contactRadius,
        'box',
        macroHalf,
      );
      if (planeRadius >= 0.12) {
        placedOrigins.push(origin);
        placed = true;
      }
    }

    if (!placed) {
      posX = randRange(rng, -centerHalf * 0.3, centerHalf * 0.3);
      posY = randRange(rng, -centerHalf * 0.3, centerHalf * 0.3);
      posZ = randRange(rng, -centerHalf * 0.3, centerHalf * 0.3);
      const origin = new Vector3(posX, posY, posZ);
      planeRadius = Math.max(
        0.12,
        fitPlaneRadiusInMacro(
          origin,
          xAxis,
          yAxis,
          symmetryN,
          contactRadius * 0.45,
          'box',
          macroHalf,
        ),
      );
      placedOrigins.push(origin);
    }

    const part: PartParams = {
      ...defaultPart(i, halfExtent * 2, planeRadius, 0),
      symmetryN,
      posX,
      posY,
      posZ,
      rotX,
      rotY,
      rotZ,
      planeRadius,
      halfExtentA: halfExtent,
      halfExtentB: halfExtent,
      angle: 0,
      angleA: 0,
      protrusionTilt: 0,
      visible: true,
    };
    params.parts.push(part);
  }

  ensurePartCount(params);
  return params;
}
