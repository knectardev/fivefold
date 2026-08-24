import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  SphereGeometry,
  Vector3,
} from 'three';
import { Brush, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import { createEvaluator } from '../geom/csgEvaluator';
import { prepareForCsg } from '../geom/prepareForCsg';
import {
  FACES,
  OCTANTS,
  cubeVolume,
  type DissectionParams,
  type FaceId,
  type OctantId,
} from './params';
import { meshVolume } from './volume';

/** Uniformly scale a centered mesh so its volume equals `targetVolume`. */
function scaleToVolume(geo: BufferGeometry, targetVolume: number): BufferGeometry {
  const v = meshVolume(geo);
  if (v < 1e-12) return geo;
  const s = Math.cbrt(targetVolume / v);
  const pos = geo.attributes.position as BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i, pos.getX(i) * s, pos.getY(i) * s, pos.getZ(i) * s);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

export type ExtractedSolid = {
  geometry: BufferGeometry;
  volume: number;
  label: string;
};

export type DissectionSolids = {
  core: ExtractedSolid;
  corners: ExtractedSolid[];
  caps: ExtractedSolid[];
  /** Cube − Ball (unsplit) */
  allCorners: ExtractedSolid;
  /** Ball − Cube (unsplit) */
  allCaps: ExtractedSolid;
};

function toBrush(geo: BufferGeometry): Brush {
  const brush = new Brush(prepareForCsg(geo));
  brush.updateMatrixWorld(true);
  return brush;
}

function evalOp(
  a: Brush,
  b: Brush,
  op: typeof INTERSECTION | typeof SUBTRACTION,
): BufferGeometry {
  const evaluator = createEvaluator();
  const result = evaluator.evaluate(a, b, op);
  const geo = prepareForCsg(result.geometry);
  return geo;
}

function octantBox(o: OctantId, half: number, pad = 1e-3): BufferGeometry {
  const size = half + pad;
  const geo = new BoxGeometry(size, size, size);
  geo.translate(
    o.sx * (size / 2),
    o.sy * (size / 2),
    o.sz * (size / 2),
  );
  return geo;
}

function faceCapSlab(face: FaceId, p: DissectionParams, ballR: number, pad = 0.02): BufferGeometry {
  const half = p.a / 2;
  const h = Math.max(p.h, ballR - half) + pad;
  const depth = h;
  const span = p.a * 2;
  const sizes = [span, span, span];
  sizes[face.axis] = depth;
  const geo = new BoxGeometry(sizes[0], sizes[1], sizes[2]);
  const center = half + depth / 2;
  const t = new Vector3();
  t.setComponent(face.axis, face.sign * center);
  geo.translate(t.x, t.y, t.z);
  return geo;
}

/**
 * CSG-extract core, 8 corners, and 6 caps for equal-volume concentric cube/ball.
 */
export function extractDissectionSolids(
  p: DissectionParams,
  sphereSeg = 64,
  sphereRing = 32,
): DissectionSolids {
  const cubeGeo = prepareForCsg(new BoxGeometry(p.a, p.a, p.a));
  // Tessellated spheres undershoot true ball volume; scale so mesh Vol = cube Vol.
  const ballGeo = scaleToVolume(
    prepareForCsg(new SphereGeometry(p.R, sphereSeg, sphereRing)),
    cubeVolume(p.a),
  );
  ballGeo.computeBoundingSphere();
  const ballR = ballGeo.boundingSphere?.radius ?? p.R;
  const cube = toBrush(cubeGeo);
  const ball = toBrush(ballGeo);

  const coreGeo = evalOp(cube, ball, INTERSECTION);
  const allCornersGeo = evalOp(cube, ball, SUBTRACTION);
  const allCapsGeo = evalOp(ball, cube, SUBTRACTION);

  const half = p.a / 2;
  const allCornersBrush = toBrush(allCornersGeo);
  const allCapsBrush = toBrush(allCapsGeo);

  const corners: ExtractedSolid[] = OCTANTS.map((o) => {
    const box = toBrush(octantBox(o, half));
    const geo = evalOp(allCornersBrush, box, INTERSECTION);
    return { geometry: geo, volume: meshVolume(geo), label: `corner ${o.label}` };
  });

  const caps: ExtractedSolid[] = FACES.map((f) => {
    const slab = toBrush(faceCapSlab(f, p, ballR));
    const geo = evalOp(allCapsBrush, slab, INTERSECTION);
    return { geometry: geo, volume: meshVolume(geo), label: `cap ${f.label}` };
  });

  return {
    core: {
      geometry: coreGeo,
      volume: meshVolume(coreGeo),
      label: 'core',
    },
    corners,
    caps,
    allCorners: {
      geometry: allCornersGeo,
      volume: meshVolume(allCornersGeo),
      label: 'all corners',
    },
    allCaps: {
      geometry: allCapsGeo,
      volume: meshVolume(allCapsGeo),
      label: 'all caps',
    },
  };
}
