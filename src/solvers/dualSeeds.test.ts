import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { defaultParams } from '../model/types';
import { buildSkeleton, eulerDegreesFromAxis } from '../model/skeleton';
import { voronoiBisector } from '../geom/polyhedron';
import {
  collectDualSeeds,
  halfSeedPosition,
  partDualSeeds,
} from './dualSeeds';
import {
  createSeededRng,
  fitPlaneRadiusInMacro,
  generatePlaneFirstLayout,
} from './planeFirst';
import { disposePipelineResult, evaluateCandidate } from './score';
import { solveVoronoi } from './solveVoronoi';

describe('dualSeeds', () => {
  it('places A/B seeds symmetric about the midplane origin', () => {
    const params = defaultParams();
    params.layoutMode = 'voronoi';
    params.parts[0].halfExtentA = 1.2;
    params.parts[0].halfExtentB = 1.2;
    params.parts[0].posX = 0.3;
    params.parts[0].posY = -0.2;
    params.parts[0].posZ = 0.1;
    const e = eulerDegreesFromAxis(new Vector3(0.2, 0.7, 0.4).normalize());
    params.parts[0].rotX = e.rotX;
    params.parts[0].rotY = e.rotY;
    params.parts[0].rotZ = e.rotZ;

    const skeleton = buildSkeleton(params);
    const part = skeleton.parts[0];
    const { seedA, seedB, offsetA, offsetB } = partDualSeeds(part, params);

    expect(offsetA).toBeCloseTo(1.2 * 0.45, 5);
    expect(offsetB).toBeCloseTo(1.2 * 0.45, 5);

    const mid = seedA.clone().lerp(seedB, 0.5);
    expect(mid.distanceTo(part.origin)).toBeLessThan(1e-6);

    const delta = seedB.clone().sub(seedA).normalize();
    expect(Math.abs(delta.dot(part.axis.clone().normalize()))).toBeGreaterThan(
      0.999,
    );
  });

  it('bisector of dual seeds matches midplane normal', () => {
    const origin = new Vector3(0.5, -0.3, 0.2);
    const axis = new Vector3(1, 2, -1).normalize();
    const seedA = halfSeedPosition(origin, axis, 0.4, 'A');
    const seedB = halfSeedPosition(origin, axis, 0.4, 'B');
    const plane = voronoiBisector(seedA, seedB, 0);
    expect(plane.n.dot(axis)).toBeGreaterThan(0.999);
    expect(Math.abs(plane.n.dot(origin) - plane.d)).toBeLessThan(1e-6);
  });

  it('collects 2N half-seeds', () => {
    const params = defaultParams();
    params.partCount = 4;
    params.layoutMode = 'voronoi';
    const skeleton = buildSkeleton(params);
    const seeds = collectDualSeeds(skeleton, params);
    expect(seeds).toHaveLength(8);
  });
});

describe('planeFirst', () => {
  it('fits N-gon radius inside a box macro', () => {
    const origin = new Vector3(0, 0, 0);
    const xAxis = new Vector3(1, 0, 0);
    const yAxis = new Vector3(0, 0, 1);
    const r = fitPlaneRadiusInMacro(origin, xAxis, yAxis, 4, 2.0, 'box', 3, 0.08);
    expect(r).toBeGreaterThan(0.15);
    expect(r).toBeLessThanOrEqual(2.0);
  });

  it('generates voronoi DesignParams with N parts', () => {
    const rng = createSeededRng(42);
    const params = generatePlaneFirstLayout({
      partCount: 4,
      macroSize: 6.5,
      contactRadius: 0.5,
      random: rng.next,
      symmetryMode: 4,
    });
    expect(params.layoutMode).toBe('voronoi');
    expect(params.macroShape).toBe('box');
    expect(params.partCount).toBe(4);
    expect(params.parts).toHaveLength(4);
    expect(params.strutGuide).toBe('none');
    for (const p of params.parts) {
      expect(p.symmetryN).toBe(4);
      expect(p.planeRadius).toBeGreaterThanOrEqual(0.15);
    }
  });
});

describe('solveVoronoi', () => {
  it('returns a scored candidate for a seeded 4-part search', () => {
    const result = solveVoronoi({
      partCount: 4,
      maxAttempts: 12,
      macroSize: 7,
      contactRadius: 0.45,
      clearanceGap: 0.08,
      halfExtent: 0.55,
      symmetryMode: 4,
      seed: 7,
    });
    expect(result.attempts).toBeGreaterThan(0);
    expect(result.attempts).toBeLessThanOrEqual(12);
    expect(result.params.layoutMode).toBe('voronoi');
    expect(result.params.partCount).toBe(4);
    expect(result.message.length).toBeGreaterThan(0);
    expect(typeof result.score.loss).toBe('number');
  });

  it('evaluates a deterministic plane-first layout without throwing', () => {
    const rng = createSeededRng(99);
    const params = generatePlaneFirstLayout({
      partCount: 4,
      macroSize: 7,
      contactRadius: 0.4,
      clearanceGap: 0.1,
      halfExtent: 0.5,
      symmetryMode: 4,
      random: rng.next,
    });
    const { score, pipeline } = evaluateCandidate(params);
    disposePipelineResult(pipeline);
    expect(score.results).toHaveLength(4);
    expect(Number.isFinite(score.loss)).toBe(true);
  });
});
