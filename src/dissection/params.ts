/**
 * Equal-volume concentric cube and ball parameters for the
 * cube ↔ sphere caps/corners dissection model.
 *
 * Cube side a; ball radius R = a * (3/(4π))^(1/3) so Vol(cube) = Vol(ball).
 * Then a/2 < R < (a√3)/2: ball bulges through faces; cube corners stick out.
 */

export type DissectionParams = {
  /** Cube side length */
  a: number;
  /** Equal-volume ball radius */
  R: number;
  /** Spherical-cap height h = R - a/2 */
  h: number;
  /** Cap base radius ρ = √(R² - (a/2)²) */
  rho: number;
};

export function equalVolumeRadius(a: number): number {
  return a * Math.cbrt(3 / (4 * Math.PI));
}

export function makeParams(a = 1): DissectionParams {
  const R = equalVolumeRadius(a);
  const h = R - a / 2;
  const rho = Math.sqrt(Math.max(0, R * R - (a / 2) * (a / 2)));
  return { a, R, h, rho };
}

/** Cube volume a³ */
export function cubeVolume(a: number): number {
  return a * a * a;
}

/** Ball volume (4/3)πR³ */
export function ballVolume(R: number): number {
  return (4 / 3) * Math.PI * R * R * R;
}

/**
 * Volume of one spherical cap of height h on a sphere of radius R.
 * V = (1/3) π h² (3R − h)
 */
export function sphericalCapVolume(R: number, h: number): number {
  return (1 / 3) * Math.PI * h * h * (3 * R - h);
}

export type AnalyticalVolumes = {
  cube: number;
  ball: number;
  /** One of six non-overlapping face caps (Ball − Cube) */
  oneCap: number;
  /** Total Ball − Cube (= 6 × oneCap) */
  allCaps: number;
  /** One of eight corners (Cube − Ball) */
  oneCorner: number;
  /** Total Cube − Ball (= 8 × oneCorner = allCaps) */
  allCorners: number;
  /** Cube ∩ Ball */
  core: number;
  /** Cube surface area 6a² */
  cubeArea: number;
  /** Sphere surface area 4πR² */
  sphereArea: number;
};

export function analyticalVolumes(p: DissectionParams): AnalyticalVolumes {
  const cube = cubeVolume(p.a);
  const ball = ballVolume(p.R);
  const oneCap = sphericalCapVolume(p.R, p.h);
  const allCaps = 6 * oneCap;
  const allCorners = allCaps; // equal volumes ⇒ symmetric difference halves match
  const oneCorner = allCorners / 8;
  const core = cube - allCorners;
  return {
    cube,
    ball,
    oneCap,
    allCaps,
    oneCorner,
    allCorners,
    core,
    cubeArea: 6 * p.a * p.a,
    sphereArea: 4 * Math.PI * p.R * p.R,
  };
}

/** Face axis and sign for the six cube faces / caps. */
export type FaceId = {
  axis: 0 | 1 | 2;
  sign: 1 | -1;
  /** Short label, e.g. "+z" */
  label: string;
};

export const FACES: FaceId[] = [
  { axis: 0, sign: 1, label: '+x' },
  { axis: 0, sign: -1, label: '-x' },
  { axis: 1, sign: 1, label: '+y' },
  { axis: 1, sign: -1, label: '-y' },
  { axis: 2, sign: 1, label: '+z' },
  { axis: 2, sign: -1, label: '-z' },
];

/** Eight cube-corner octant sign triples. */
export type OctantId = {
  sx: 1 | -1;
  sy: 1 | -1;
  sz: 1 | -1;
  label: string;
};

export const OCTANTS: OctantId[] = (
  [
    [1, 1, 1],
    [1, 1, -1],
    [1, -1, 1],
    [1, -1, -1],
    [-1, 1, 1],
    [-1, 1, -1],
    [-1, -1, 1],
    [-1, -1, -1],
  ] as const
).map(([sx, sy, sz]) => ({
  sx,
  sy,
  sz,
  label: `${sx > 0 ? '+' : '-'}x${sy > 0 ? '+' : '-'}y${sz > 0 ? '+' : '-'}z`,
}));

/** The three faces adjacent to an octant corner. */
export function facesForOctant(o: OctantId): FaceId[] {
  return [
    FACES.find((f) => f.axis === 0 && f.sign === o.sx)!,
    FACES.find((f) => f.axis === 1 && f.sign === o.sy)!,
    FACES.find((f) => f.axis === 2 && f.sign === o.sz)!,
  ];
}

/** The four octants adjacent to a face. */
export function octantsForFace(face: FaceId): OctantId[] {
  return OCTANTS.filter((o) => {
    const s = face.axis === 0 ? o.sx : face.axis === 1 ? o.sy : o.sz;
    return s === face.sign;
  });
}
