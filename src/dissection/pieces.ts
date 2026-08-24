import {
  BoxGeometry,
  BufferGeometry,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';
import { Brush, INTERSECTION } from 'three-bvh-csg';
import { createEvaluator } from '../geom/csgEvaluator';
import { prepareForCsg } from '../geom/prepareForCsg';
import { extractDissectionSolids } from './extract';
import { OCTANTS, type DissectionParams, type OctantId } from './params';
import { buildCornerCapTransfer, translationMatrix } from './thirds';
import { meshVolume } from './volume';

export type PackingFit = 'exact' | 'provisional';

export type RigidPiece = {
  id: string;
  label: string;
  role: 'core' | 'transfer';
  geometry: BufferGeometry;
  volume: number;
  color: number;
  cubeSlot: string;
  sphereSlot: string;
  fit: PackingFit;
  cubeMatrix: Matrix4;
  sphereMatrix: Matrix4;
  axis: Vector3;
};

const CORE_COLORS = [
  0x3498db, 0x2980b9, 0x1abc9c, 0x16a085,
  0x9b59b6, 0x8e44ad, 0x5dade2, 0x48c9b0,
];

const TRANSFER_COLORS = [
  0xe74c3c, 0xc0392b, 0xe67e22, 0xd35400, 0xf1c40f, 0xf39c12,
  0x2ecc71, 0x27ae60, 0xe84393, 0xfd79a8, 0x00cec9, 0x00b894,
  0x6c5ce7, 0xa29bfe, 0xfdcb6e, 0xe17055, 0x74b9ff, 0xff7675,
  0x55efc4, 0x81ecec, 0xffeaa7, 0xdfe6e9, 0xb2bec3, 0x636e72,
];

function toBrush(geo: BufferGeometry): Brush {
  const brush = new Brush(prepareForCsg(geo));
  brush.updateMatrixWorld(true);
  return brush;
}

function evalIntersection(a: Brush, b: Brush): BufferGeometry {
  const evaluator = createEvaluator();
  return prepareForCsg(evaluator.evaluate(a, b, INTERSECTION).geometry);
}

function octantBox(o: OctantId, half: number, pad = 1e-3): BufferGeometry {
  const size = half + pad;
  const geo = new BoxGeometry(size, size, size);
  geo.translate(o.sx * (size / 2), o.sy * (size / 2), o.sz * (size / 2));
  return geo;
}

function sampleVertices(geo: BufferGeometry, maxPts: number): Vector3[] {
  const pos = geo.attributes.position;
  if (!pos || pos.count === 0) return [];
  const step = Math.max(1, Math.floor(pos.count / maxPts));
  const out: Vector3[] = [];
  for (let i = 0; i < pos.count; i += step) {
    out.push(new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
  }
  return out;
}

function meanPoint(pts: Vector3[]): Vector3 {
  const c = new Vector3();
  if (pts.length === 0) return c;
  for (const p of pts) c.add(p);
  return c.multiplyScalar(1 / pts.length);
}

function sphericalPatchPoints(
  geo: BufferGeometry,
  R: number,
  tol = 0.05,
): Vector3[] {
  const pos = geo.attributes.position;
  const out: Vector3[] = [];
  if (!pos) return out;
  for (let i = 0; i < pos.count; i++) {
    const v = new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    if (Math.abs(v.length() - R) <= tol) out.push(v);
  }
  return out.length >= 6 ? out : sampleVertices(geo, 48);
}

function orderAroundRay(pts: Vector3[], ray: Vector3): Vector3[] {
  const axis = ray.clone().normalize();
  const tmp =
    Math.abs(axis.x) < 0.85 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const u = new Vector3().crossVectors(axis, tmp).normalize();
  const v = new Vector3().crossVectors(axis, u).normalize();
  const center = meanPoint(pts);
  return pts
    .map((p) => {
      const d = p.clone().sub(center);
      return { p, a: Math.atan2(d.dot(v), d.dot(u)) };
    })
    .sort((a, b) => a.a - b.a)
    .map((x) => x.p);
}

export function alignRayFlipTwist(
  fromC: Vector3,
  toC: Vector3,
  twist: number,
  flip: boolean,
): Matrix4 {
  if (fromC.lengthSq() < 1e-12 || toC.lengthSq() < 1e-12) {
    return translationMatrix(toC.clone().sub(fromC));
  }
  const from = fromC.clone().normalize();
  const to = toC.clone().normalize();
  let q = new Quaternion().setFromUnitVectors(from, to);
  if (flip) {
    const perp =
      Math.abs(to.dot(new Vector3(1, 0, 0))) < 0.85
        ? new Vector3(1, 0, 0)
        : new Vector3(0, 1, 0);
    const flipAxis = new Vector3().crossVectors(to, perp).normalize();
    q = new Quaternion().setFromAxisAngle(flipAxis, Math.PI).multiply(q);
  }
  q = new Quaternion().setFromAxisAngle(to, twist).multiply(q);

  const R = new Matrix4().makeRotationFromQuaternion(q);
  const rotatedC = fromC.clone().applyMatrix4(R);
  const t = toC.clone().sub(rotatedC);
  return new Matrix4().makeTranslation(t.x, t.y, t.z).multiply(R);
}

function pairedRmsd(src: Vector3[], dst: Vector3[], m: Matrix4): number {
  const n = Math.min(src.length, dst.length);
  if (n === 0) return Infinity;
  let e = 0;
  for (let i = 0; i < n; i++) {
    e += src[i]!.clone().applyMatrix4(m).distanceToSquared(dst[i]!);
  }
  return e / n;
}

function outsideCubePenalty(pts: Vector3[], m: Matrix4, half: number): number {
  let e = 0;
  for (const p of pts) {
    const v = p.clone().applyMatrix4(m);
    const ox = Math.max(0, Math.abs(v.x) - half);
    const oy = Math.max(0, Math.abs(v.y) - half);
    const oz = Math.max(0, Math.abs(v.z) - half);
    e += ox * ox + oy * oy + oz * oz;
  }
  return e / Math.max(1, pts.length);
}

/** Best-fit rigid seat of a cap sector into its volume-paired corner third. */
export function seatCapSectorInCorner(
  sectorGeo: BufferGeometry,
  thirdGeo: BufferGeometry,
  R: number,
  half: number,
): Matrix4 {
  const srcPatch = sphericalPatchPoints(sectorGeo, R);
  const dstPatch = sphericalPatchPoints(thirdGeo, R);
  const srcC = meanPoint(srcPatch);
  const dstC = meanPoint(dstPatch);
  const srcOrdered = orderAroundRay(srcPatch, srcC);
  const dstOrdered = orderAroundRay(dstPatch, dstC);
  const solidPts = sampleVertices(sectorGeo, 36);

  let best = new Matrix4().identity();
  let bestScore = Infinity;

  for (const flip of [true, false]) {
    for (let k = 0; k < 72; k++) {
      const twist = (k / 72) * Math.PI * 2;
      const m = alignRayFlipTwist(srcC, dstC, twist, flip);
      const score =
        pairedRmsd(srcOrdered, dstOrdered, m) +
        0.6 * outsideCubePenalty(solidPts, m, half);
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
  }
  return best;
}

export function seatCornerInCap(
  cornerGeo: BufferGeometry,
  capGeo: BufferGeometry,
  R: number,
): Matrix4 {
  return seatCapSectorInCorner(capGeo, cornerGeo, R, 0.5).clone().invert();
}

/** @deprecated kept for tests */
export function cornerThirdToCapMatrix(
  thirdCentroid: Vector3,
  sectorCentroid: Vector3,
): Matrix4 {
  return alignRayFlipTwist(thirdCentroid, sectorCentroid, 0, true);
}

/**
 * Sphere-exact assembly with the same pieces attempted on the cube:
 * - 8 core octants + 24 face-cap sectors
 * - Sphere = identity (exact ball)
 * - Cube = twist-optimized best-fit into volume-paired corner thirds (provisional)
 *
 * A clean cube with these same meshes needs congruent recuts (see pullback.ts);
 * face-cap shapes cannot form flat cube corners by rigid motion alone.
 */
export function buildRigidPieces(p: DissectionParams): {
  pieces: RigidPiece[];
  notes: string[];
  cubeVol: number;
  sphereTargetVol: number;
} {
  const notes: string[] = [];
  const solids = extractDissectionSolids(p);
  const transfer = buildCornerCapTransfer(p, solids.corners, solids.caps);
  const half = p.a / 2;
  const coreBrush = toBrush(solids.core.geometry);

  const pieces: RigidPiece[] = [];
  let pieceVol = 0;

  for (let i = 0; i < OCTANTS.length; i++) {
    const o = OCTANTS[i]!;
    const box = toBrush(octantBox(o, half));
    const geo = evalIntersection(coreBrush, box);
    const vol = meshVolume(geo);
    pieceVol += vol;
    pieces.push({
      id: `core-${o.label}`,
      label: `Core ${o.label}`,
      role: 'core',
      geometry: geo,
      volume: vol,
      color: CORE_COLORS[i % CORE_COLORS.length]!,
      cubeSlot: `Cube∩Ball octant ${o.label}`,
      sphereSlot: `Ball∩Cube octant ${o.label}`,
      fit: 'exact',
      cubeMatrix: new Matrix4().identity(),
      sphereMatrix: new Matrix4().identity(),
      axis: new Vector3(o.sx, o.sy, o.sz).normalize(),
    });
  }

  for (let i = 0; i < transfer.pairs.length; i++) {
    const pair = transfer.pairs[i]!;
    const { third, sector } = pair;
    const vol = sector.volume;
    pieceVol += vol;
    pieces.push({
      id: `transfer-${i}-${sector.label}`,
      label: `T${i + 1} ${sector.face.label}#${sector.sectorIndex}`,
      role: 'transfer',
      geometry: sector.geometry,
      volume: vol,
      color: TRANSFER_COLORS[i % TRANSFER_COLORS.length]!,
      cubeSlot: `Corner ${third.label} (best-fit)`,
      sphereSlot: `Cap sector ${sector.label}`,
      fit: 'provisional',
      cubeMatrix: seatCapSectorInCorner(
        sector.geometry,
        third.geometry,
        p.R,
        half,
      ),
      sphereMatrix: new Matrix4().identity(),
      axis: third.homeCentroid.clone().normalize(),
    });
  }

  const sphereTargetVol = solids.core.volume + solids.allCaps.volume;
  const nCore = pieces.filter((x) => x.role === 'core').length;
  const nTransfer = pieces.filter((x) => x.role === 'transfer').length;

  notes.push(
    `Sphere-exact cut: ${nCore} core octants + ${nTransfer} face-cap sectors = ${pieces.length} pieces.`,
  );
  notes.push(
    'Sphere mode is exact (core ∪ Ball\\Cube). Same meshes in cube mode.',
  );
  notes.push(
    'Cube is provisional: cap sectors ≠ corner thirds. Congruent pullback recuts are the path to a clean cube without giving up the sphere.',
  );
  notes.push(...transfer.notes);

  return { pieces, notes, cubeVol: pieceVol, sphereTargetVol };
}

export function blendMatrix(a: Matrix4, b: Matrix4, t: number): Matrix4 {
  const ae = a.elements;
  const be = b.elements;
  const aPos = new Vector3(ae[12], ae[13], ae[14]);
  const bPos = new Vector3(be[12], be[13], be[14]);
  const aQuat = new Quaternion().setFromRotationMatrix(a);
  const bQuat = new Quaternion().setFromRotationMatrix(b);
  const pos = aPos.clone().lerp(bPos, t);
  const quat = aQuat.clone().slerp(bQuat, t);
  return new Matrix4().compose(pos, quat, new Vector3(1, 1, 1));
}

/** @deprecated kept for older tests */
export function faceCapFlip(
  face: { axis: 0 | 1 | 2; sign: 1 | -1 },
  a: number,
): Matrix4 {
  const half = a / 2;
  const center = new Vector3();
  center.setComponent(face.axis, face.sign * half);
  const axis = new Vector3();
  if (face.axis === 0) axis.set(0, 1, 0);
  else if (face.axis === 1) axis.set(0, 0, 1);
  else axis.set(1, 0, 0);
  return new Matrix4()
    .makeTranslation(center.x, center.y, center.z)
    .multiply(new Matrix4().makeRotationAxis(axis, Math.PI))
    .multiply(new Matrix4().makeTranslation(-center.x, -center.y, -center.z));
}

/** @deprecated */
export function allWedges(): { label: string }[] {
  return OCTANTS.flatMap((o) =>
    (['x', 'y', 'z'] as const).map((axis) => ({ label: `${o.label}/${axis}` })),
  );
}
