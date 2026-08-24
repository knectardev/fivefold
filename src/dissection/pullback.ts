import { BufferGeometry, Matrix4, Vector3 } from 'three';
import { Brush, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import { createEvaluator } from '../geom/csgEvaluator';
import { prepareForCsg } from '../geom/prepareForCsg';
import { meshVolume } from './volume';

function toBrush(geo: BufferGeometry): Brush {
  const brush = new Brush(prepareForCsg(geo));
  brush.updateMatrixWorld(true);
  return brush;
}

function evalOp(
  a: BufferGeometry,
  b: BufferGeometry,
  op: typeof INTERSECTION | typeof SUBTRACTION,
): BufferGeometry {
  const evaluator = createEvaluator();
  return prepareForCsg(evaluator.evaluate(toBrush(a), toBrush(b), op).geometry);
}

export function transformGeometry(
  geo: BufferGeometry,
  m: Matrix4,
): BufferGeometry {
  const g = prepareForCsg(geo.clone());
  g.applyMatrix4(m);
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return prepareForCsg(g);
}

export function csgIntersection(
  a: BufferGeometry,
  b: BufferGeometry,
): BufferGeometry {
  return evalOp(a, b, INTERSECTION);
}

export function csgSubtract(a: BufferGeometry, b: BufferGeometry): BufferGeometry {
  return evalOp(a, b, SUBTRACTION);
}

export function meshCentroid(geo: BufferGeometry): Vector3 {
  const pts: Vector3[] = [];
  const pos = geo.attributes.position;
  if (!pos || pos.count === 0) return new Vector3();
  const step = Math.max(1, Math.floor(pos.count / 64));
  for (let i = 0; i < pos.count; i += step) {
    pts.push(new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
  }
  const c = new Vector3();
  for (const p of pts) c.add(p);
  return c.multiplyScalar(1 / Math.max(1, pts.length));
}

export type PullbackRound = {
  geometry: BufferGeometry;
  volume: number;
  /** Rigid motion taking the piece from its cube (corner) seat into the cap seat */
  sphereMatrix: Matrix4;
};

const MIN_VOL = 1e-5;

/**
 * Dissect a volume-paired (corner cell, cap cell) into congruent pullback pieces.
 *
 * Round k:
 *   M maps current corner remainder → cap remainder (caller-supplied)
 *   piece = cornerRem ∩ M^{-1}(capRem)   // subset of both under M
 *   cube pose = I, sphere pose = M
 *   subtract piece from both remainders and repeat
 */
export function pullbackDissectPair(
  cornerGeo: BufferGeometry,
  capGeo: BufferGeometry,
  chooseMotion: (cornerRem: BufferGeometry, capRem: BufferGeometry) => Matrix4,
  maxRounds = 3,
): { pieces: PullbackRound[]; cornerLeft: number; capLeft: number } {
  let cornerRem = prepareForCsg(cornerGeo.clone());
  let capRem = prepareForCsg(capGeo.clone());
  const pieces: PullbackRound[] = [];

  for (let round = 0; round < maxRounds; round++) {
    const vCorner = meshVolume(cornerRem);
    const vCap = meshVolume(capRem);
    if (vCorner < MIN_VOL || vCap < MIN_VOL) break;

    const M = chooseMotion(cornerRem, capRem);
    const Minv = M.clone().invert();
    const capInCorner = transformGeometry(capRem, Minv);
    const pieceGeo = csgIntersection(cornerRem, capInCorner);
    const vol = meshVolume(pieceGeo);
    if (vol < MIN_VOL) break;
    // If overlap is tiny vs remainders, further rounds won't help with this motion family.
    if (vol < 0.01 * Math.min(vCorner, vCap) && round > 0) break;

    pieces.push({
      geometry: pieceGeo,
      volume: vol,
      sphereMatrix: M.clone(),
    });

    cornerRem = csgSubtract(cornerRem, pieceGeo);
    const pieceInCap = transformGeometry(pieceGeo, M);
    capRem = csgSubtract(capRem, pieceInCap);
  }

  return {
    pieces,
    cornerLeft: meshVolume(cornerRem),
    capLeft: meshVolume(capRem),
  };
}

/** Volume of corner ∩ M^{-1}(cap) — the pullback piece volume for motion M. */
export function pullbackOverlapVolume(
  cornerGeo: BufferGeometry,
  capGeo: BufferGeometry,
  M: Matrix4,
): number {
  const Minv = M.clone().invert();
  const capInCorner = transformGeometry(capGeo, Minv);
  return meshVolume(csgIntersection(cornerGeo, capInCorner));
}
