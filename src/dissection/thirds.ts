import {
  BoxGeometry,
  BufferGeometry,
  Matrix4,
  Vector3,
} from 'three';
import { Brush, INTERSECTION } from 'three-bvh-csg';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { createEvaluator } from '../geom/csgEvaluator';
import { prepareForCsg } from '../geom/prepareForCsg';
import {
  FACES,
  OCTANTS,
  facesForOctant,
  type DissectionParams,
  type FaceId,
  type OctantId,
} from './params';
import { meshVolume } from './volume';
import type { ExtractedSolid } from './extract';

export type CornerThird = {
  geometry: BufferGeometry;
  volume: number;
  octant: OctantId;
  face: FaceId;
  label: string;
  homeCentroid: Vector3;
};

export type CapSector = {
  geometry: BufferGeometry;
  volume: number;
  face: FaceId;
  sectorIndex: number;
  label: string;
  homeCentroid: Vector3;
};

export type ThirdCapPair = {
  third: CornerThird;
  sector: CapSector;
  morphTranslation: Vector3;
  /** Coarse test: translated third AABB inside padded cap AABB */
  seatsInCapAabb: boolean;
};

export type CornerCapTransfer = {
  thirds: CornerThird[];
  sectors: CapSector[];
  pairs: ThirdCapPair[];
  movablePieceCount: number;
  seatedCount: number;
  notes: string[];
};

function toBrush(geo: BufferGeometry): Brush {
  const brush = new Brush(prepareForCsg(geo));
  brush.updateMatrixWorld(true);
  return brush;
}

function evalIntersection(a: Brush, b: Brush): BufferGeometry {
  const evaluator = createEvaluator();
  return prepareForCsg(evaluator.evaluate(a, b, INTERSECTION).geometry);
}

function meshCentroid(geo: BufferGeometry): Vector3 {
  geo.computeBoundingBox();
  const c = new Vector3();
  geo.boundingBox!.getCenter(c);
  return c;
}

/**
 * Polyhedron vertices for the face-associated third of an octant cell:
 * points of the octant cube where the face coordinate dominates the other two.
 */
function thirdConvexPoints(o: OctantId, face: FaceId, half: number): Vector3[] {
  const verts: Vector3[] = [];
  for (const ix of [0, 1]) {
    for (const iy of [0, 1]) {
      for (const iz of [0, 1]) {
        verts.push(
          new Vector3(o.sx * ix * half, o.sy * iy * half, o.sz * iz * half),
        );
      }
    }
  }

  const absAxes = (v: Vector3) => [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
  const eps = 1e-9;
  const kept = verts.filter((v) => {
    const ax = absAxes(v);
    const fc = ax[face.axis]!;
    return ax.every((c, i) => i === face.axis || fc + eps >= c);
  });

  kept.push(new Vector3(0, 0, 0));
  kept.push(new Vector3(o.sx * half, o.sy * half, o.sz * half));

  const out: Vector3[] = [];
  for (const p of kept) {
    if (!out.some((q) => q.distanceToSquared(p) < 1e-12)) out.push(p);
  }
  return out;
}

function capSectorWedge(
  face: FaceId,
  sectorIndex: number,
  p: DissectionParams,
): BufferGeometry {
  const half = p.a / 2;
  const big = p.a * 3;
  const bit0 = sectorIndex & 1;
  const bit1 = (sectorIndex >> 1) & 1;
  const uSign = bit0 ? 1 : -1;
  const vSign = bit1 ? 1 : -1;

  const axes = ([0, 1, 2] as const).filter((i) => i !== face.axis);
  const u = axes[0]!;
  const v = axes[1]!;

  const sizes = [big, big, big];
  sizes[u] = big / 2;
  sizes[v] = big / 2;
  sizes[face.axis] = p.h + half;

  const geo = new BoxGeometry(sizes[0], sizes[1], sizes[2]);
  const t = new Vector3();
  t.setComponent(u, uSign * (big / 4));
  t.setComponent(v, vSign * (big / 4));
  t.setComponent(face.axis, face.sign * (half + p.h / 2));
  geo.translate(t.x, t.y, t.z);
  return prepareForCsg(geo);
}

function aabbSeatsAfterTranslate(
  piece: BufferGeometry,
  translation: Vector3,
  container: BufferGeometry,
  pad: number,
): boolean {
  piece.computeBoundingBox();
  container.computeBoundingBox();
  const A = piece.boundingBox!.clone();
  A.translate(translation);
  const B = container.boundingBox!;
  return (
    A.min.x >= B.min.x - pad &&
    A.max.x <= B.max.x + pad &&
    A.min.y >= B.min.y - pad &&
    A.max.y <= B.max.y + pad &&
    A.min.z >= B.min.z - pad &&
    A.max.z <= B.max.z + pad
  );
}

/**
 * Split 8 corners → 24 face-associated thirds; 6 caps → 24 sectors;
 * pair by face (volume-matched groups of 4); run AABB seating heuristic.
 *
 * Piece count is 24 (+ core), above the ≤20 target — documents the best
 * exact volume-paired transfer found with plane + sphere faces.
 */
export function buildCornerCapTransfer(
  p: DissectionParams,
  corners: ExtractedSolid[],
  caps: ExtractedSolid[],
): CornerCapTransfer {
  const notes: string[] = [];
  const half = p.a / 2;
  const thirds: CornerThird[] = [];

  for (let ci = 0; ci < OCTANTS.length; ci++) {
    const o = OCTANTS[ci]!;
    const cornerBrush = toBrush(corners[ci]!.geometry);

    for (const face of facesForOctant(o)) {
      const wedge = prepareForCsg(
        new ConvexGeometry(thirdConvexPoints(o, face, half)),
      );
      const geo = evalIntersection(cornerBrush, toBrush(wedge));
      thirds.push({
        geometry: geo,
        volume: meshVolume(geo),
        octant: o,
        face,
        label: `third ${o.label}→${face.label}`,
        homeCentroid: meshCentroid(geo),
      });
    }
  }

  const sectors: CapSector[] = [];
  for (let fi = 0; fi < FACES.length; fi++) {
    const face = FACES[fi]!;
    const capBrush = toBrush(caps[fi]!.geometry);
    for (let s = 0; s < 4; s++) {
      const geo = evalIntersection(capBrush, toBrush(capSectorWedge(face, s, p)));
      sectors.push({
        geometry: geo,
        volume: meshVolume(geo),
        face,
        sectorIndex: s,
        label: `sector ${face.label}#${s}`,
        homeCentroid: meshCentroid(geo),
      });
    }
  }

  const pairs: ThirdCapPair[] = [];
  let seatedCount = 0;

  for (let fi = 0; fi < FACES.length; fi++) {
    const face = FACES[fi]!;
    const capSolid = caps[fi]!;
    const faceThirds = thirds
      .filter((t) => t.face.label === face.label)
      .sort((a, b) => a.octant.label.localeCompare(b.octant.label));
    const faceSectors = sectors
      .filter((s) => s.face.label === face.label)
      .sort((a, b) => a.sectorIndex - b.sectorIndex);

    for (let i = 0; i < 4; i++) {
      const third = faceThirds[i];
      const sector = faceSectors[i];
      if (!third || !sector) continue;
      const morphTranslation = sector.homeCentroid.clone().sub(third.homeCentroid);
      const seatsInCapAabb = aabbSeatsAfterTranslate(
        third.geometry,
        morphTranslation,
        capSolid.geometry,
        0.12,
      );
      if (seatsInCapAabb) seatedCount++;
      pairs.push({ third, sector, morphTranslation, seatsInCapAabb });
    }
  }

  const thirdVolSum = thirds.reduce((s, t) => s + t.volume, 0);
  const sectorVolSum = sectors.reduce((s, t) => s + t.volume, 0);
  const meanThird = thirdVolSum / Math.max(1, thirds.length);

  notes.push(
    'Cut: each corner → 3 face-associated thirds (planes through octant diagonals).',
  );
  notes.push(
    'Cut: each cap → 4 quadrant sectors. Per face: 4 thirds volume-match 1 cap.',
  );
  notes.push(
    `Movable pieces = ${thirds.length} (+ 1 core) — above ≤20; volume-paired, not congruent.`,
  );
  notes.push(
    `AABB seating after centroid align: ${seatedCount}/${pairs.length} thirds.`,
  );
  notes.push(
    `Σ third vols = ${thirdVolSum.toFixed(6)}, Σ sector vols = ${sectorVolSum.toFixed(6)}, mean third = ${meanThird.toFixed(6)}.`,
  );

  return {
    thirds,
    sectors,
    pairs,
    movablePieceCount: thirds.length,
    seatedCount,
    notes,
  };
}

export function translationMatrix(t: Vector3): Matrix4 {
  return new Matrix4().makeTranslation(t.x, t.y, t.z);
}
