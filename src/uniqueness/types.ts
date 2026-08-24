import type { Matrix4 } from 'three';

/** Closed polyhedron with exact lattice-aligned coordinates. */
export interface UnitSolid {
  /** Vertex positions [x, y, z], ideally integers. */
  vertices: ReadonlyArray<readonly [number, number, number]>;
  /** Triangle indices into `vertices` (for rendering). */
  faces: ReadonlyArray<readonly [number, number, number]>;
}

/** One placed copy of the unit solid. */
export interface UnitInstance {
  /** Rigid transform; must be Oh-aligned (signed permutation + integer translation). */
  transform: Matrix4;
}

/** A named assembly of one or more unit instances. */
export interface ShapeConfig {
  id: string;
  label: string;
  instances: UnitInstance[];
}

export type Fingerprint = string;

export interface CongruenceMatrix {
  /** N×N: true iff configs i and j share a canonical fingerprint. */
  matrix: boolean[][];
  fingerprints: Fingerprint[];
  /** Equivalence class id per config index (0 .. classCount-1). */
  classOf: number[];
  classCount: number;
}
