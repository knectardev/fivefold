/**
 * Cube ↔ truncated octahedron dissections used by the rhombic-style viewer.
 *
 * 11-piece: Gavin Theobald's translational construction (digitized vertices
 * and cube/target offsets from the standalone lab).
 * 22-piece: exact lattice cut (rotations + translations).
 */
import {
  BufferAttribute,
  BufferGeometry,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';

export type Vec3 = [number, number, number];

export type DissectionPiece = {
  id: string;
  label: string;
  role: string;
  geometry: BufferGeometry;
  volume: number;
  color: number;
  cubeSlot: string;
  targetSlot: string;
  cubeMatrix: Matrix4;
  targetMatrix: Matrix4;
  axis: Vector3;
};

export type TruncatedOctBuild = {
  pieces: DissectionPiece[];
  totalVolume: number;
  targetVertices: Vector3[];
  cubeWireQuaternion: Quaternion;
  translational: boolean;
};

const EPSILON = 1e-7;
const Q = 32 ** (-1 / 3);
const CUBE_SHIFT: Vec3 = [0.04902917, 0.19476811, 0.23884163];
export const CUBE_BASIS_ROWS: Vec3[] = [
  [-0.76579776, -0.21583906, -0.60577825],
  [0.56277631, 0.23089821, -0.79370576],
  [0.31118582, -0.94873575, -0.05535223],
];

const COLORS = [
  0x3498db, 0xe74c3c, 0x2ecc71, 0xf1c40f, 0x9b59b6,
  0xe67e22, 0x1abc9c, 0xe84393, 0x5dade2, 0xc0392b,
  0x00cec9, 0xd35400, 0x6c5ce7, 0x27ae60, 0xfd79a8,
  0x48c9b0, 0xf39c12, 0x74b9ff, 0x16a085, 0xff7675,
  0x81ecec, 0xa29bfe,
];

type Plane = { n: Vec3; d: number };
type Polyhedron = {
  vertices: Vec3[];
  triangles: [number, number, number][];
  center: Vec3;
  volume: number;
  planes: Plane[];
};

type TheobaldRaw = {
  id: number;
  vertices: Vec3[];
  targetOffset: Vec3;
  cubeOffset: Vec3;
};

const THEOBALD_RAW: TheobaldRaw[] = [
  { id: 1, vertices: [[-0.130015415, -0.581169093, -0.133604665], [0.061019052, -0.390179945, 0.248373596], [-0.253987622, -0.075175612, 0.24838026], [0.061011626, 0.239775852, 0.248372497], [0.375996373, -0.075208142, 0.248378673], [0.498194947, 0.046959822, 0.003991905], [-0.433087742, -0.075188441, 0.06926261], [0.061002946, 0.350145777, 0.138019283], [0.219934617, 0.415330285, -0.086142555], [-0.172028279, 0.304874415, -0.396184076], [-0.345235886, 0.233815296, -0.151890557], [0.057195385, -0.393980214, -0.436956972]], targetOffset: [-0.060927762, 0.075115268, 0.381739042], cubeOffset: [-0.085104735, 0.177052796, -0.275865968] },
  { id: 2, vertices: [[0.40309618, -0.051523727, -0.046424768], [0.100884575, -0.175512358, 0.379795433], [-0.129716194, -0.234248545, 0.090514164], [0.00618125, -0.017430449, 0.443190136], [0.185274987, 0.612497966, -0.007674085], [-0.129708629, -0.017441118, 0.307286254], [-0.12971462, 0.297534628, -0.007648261], [-0.129712722, -0.017439325, -0.322634729], [-0.076101828, -0.017455706, -0.376258061], [-0.129710316, -0.222100439, -0.118005451], [0.029227317, -0.156880926, -0.342140632]], targetOffset: [-0.500205739, 0.017368341, 0.007794687], cubeOffset: [0.416823517, -0.199488386, -0.075218046] },
  { id: 3, vertices: [[-0.084049469, 0.129940357, 0.616162754], [0.230929606, 0.129938384, 0.301181094], [0.230943072, 0.444896833, -0.01377089], [0.230929344, -0.08687137, 0.084368765], [0.230926969, 0.129896036, -0.328752652], [0.230923261, -0.0747152, -0.12411934], [-0.246293344, -0.261090494, 0.387361864], [-0.564884493, -0.350865151, 0.135350752], [-0.175324227, -0.191035018, -0.414045396], [-0.08410072, 0.129905621, -0.643736951]], targetOffset: [0.398964361, -0.129837231, 0.013613062], cubeOffset: [0.056199142, -0.346842612, -0.069071429] },
  { id: 4, vertices: [[0.182316468, -0.241723759, 0.345587757], [-0.109508828, -0.533534072, 0.053760376], [0.375099267, -0.048963838, -0.039995532], [-0.201262363, 0.266058815, 0.221355807], [-0.119017383, 0.266039805, -0.21912498], [0.060108566, 0.26602749, -0.040012862], [-0.371812853, 0.266057061, 0.100434051], [0.184077127, -0.239961501, -0.422004617]], targetOffset: [0.254884129, 0.363929879, 0.039980013], cubeOffset: [-0.399182799, -0.16416596, 0.012507188] },
  { id: 5, vertices: [[-0.095900945, -0.156285653, 0.349652837], [-0.144850306, -0.007140129, 0.358360905], [-0.294012573, -0.156277961, 0.209207967], [0.156850802, -0.156304739, 0.030104243], [0.335967431, 0.473644495, -0.42075552], [0.020979109, -0.156288794, -0.105803997], [0.020966481, 0.15865278, -0.420766435]], targetOffset: [-0.020986817, -0.473671162, -0.209187659], cubeOffset: [0.266145618, -0.060603815, 0.337852208] },
  { id: 6, vertices: [[0.041604177, -0.1361302, 0.278933618], [-0.045296189, 0.12887334, 0.29440452], [0.302144541, -0.02921666, -0.088511725], [-0.405642468, -0.26216118, -0.074823962], [-0.24340254, 0.128874532, 0.153969535], [0.207456749, 0.128852785, -0.025141842], [0.071579639, 0.128868736, -0.161006311], [0.071556092, -0.087961353, -0.377823832]], targetOffset: [-0.07161683, 0.50114994, -0.154053382], cubeOffset: [0.215546723, -0.345770026, 0.393111505] },
  { id: 7, vertices: [[0.477419172, 0.04599585, -0.0237233], [0.183830029, -0.247572794, 0.45203572], [-0.154326321, -0.585718422, 0.11387355], [0.008466553, 0.287020992, 0.48322142], [0.038439359, -0.392944083, -0.271687891], [-0.537893977, -0.077949613, -0.010337464], [-0.276543392, -0.077962546, -0.271690329], [-0.438749053, 0.161000798, 0.129483561], [0.038467012, 0.335185731, -0.173537435], [0.038428996, 0.237015333, -0.271694494], [0.353435648, -0.077988973, -0.271701199], [0.269025974, 0.393917728, 0.115757861]], targetOffset: [-0.038534626, 0.078017992, -0.358406581], cubeOffset: [-0.06252795, 0.179820517, 0.244190069] },
  { id: 8, vertices: [[0.352218603, -0.015739709, -0.050396871], [0.165009129, -0.202930222, 0.252957921], [0.041021944, -0.326910538, 0.004973167], [-0.043382006, 0.144989115, 0.392442948], [0.258823535, 0.268985215, -0.033788613], [-0.115027121, 0.163612258, -0.329524287], [0.163221835, -0.204744196, -0.239411134], [-0.273961405, -0.011928264, 0.004969609], [-0.273967257, 0.086240482, 0.103136833], [-0.273957257, 0.098425859, -0.105359573]], targetOffset: [-0.355999915, -0.303058298, -0.004966654], cubeOffset: [0.249867557, 0.428757823, -0.032464464] },
  { id: 9, vertices: [[-0.010724314, 0.125992535, 0.262720906], [-0.010718663, -0.18898604, -0.052258531], [0.042886886, -0.188995839, -0.105891876], [-0.325732606, -0.188986717, -0.367270998], [0.304288698, 0.440976061, 0.2627005]], targetOffset: [0.010731796, -0.440953987, 0.367234723], cubeOffset: [0.297827496, -0.027939255, -0.345597919] },
  { id: 10, vertices: [[0.066159903, -0.185060035, -0.036064576], [0.381156815, 0.129936654, -0.036061228], [0.381150468, 0.240261356, -0.146425559], [0.38116434, 0.228095592, 0.062077138], [-0.195185233, -0.185053812, 0.225298496], [-0.365704229, -0.185045338, 0.104397308], [-0.112949926, -0.185067574, -0.215146497], [-0.096044469, 0.053901722, 0.365111728], [-0.025093044, 0.123929973, -0.436290247], [-0.414654625, -0.035898539, 0.113103436]], targetOffset: [0.248737154, -0.444813787, 0.035919281], cubeOffset: [-0.405231645, 0.286918497, 0.008563569] },
  { id: 11, vertices: [[0.105960257, -0.073918741, 0.290111334], [0.264894192, -0.00873702, 0.065953737], [-0.20906171, 0.130699601, -0.229502504], [0.10596037, 0.130696925, 0.085471286], [0.159597341, 0.130697439, 0.031858377], [-0.300279994, -0.190247472, 0.000198836], [-0.127070456, -0.119190732, -0.244091066]], targetOffset: [-0.105890312, 0.499186236, 0.229637177], cubeOffset: [0.181154938, -0.347630194, -0.483315608] },
];

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function scale(a: Vec3, amount: number): Vec3 {
  return [a[0] * amount, a[1] * amount, a[2] * amount];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
function normalize(a: Vec3): Vec3 {
  const amount = length(a);
  return amount > EPSILON ? scale(a, 1 / amount) : [0, 0, 0];
}
function distance(a: Vec3, b: Vec3): number {
  return length(subtract(a, b));
}
function determinant3(matrix: Vec3[]): number {
  return dot(matrix[0]!, cross(matrix[1]!, matrix[2]!));
}
function solve3(matrix: Vec3[], values: Vec3): Vec3 | null {
  const det = determinant3(matrix);
  if (Math.abs(det) < 1e-10) return null;
  const c0: Vec3 = [matrix[0]![0], matrix[1]![0], matrix[2]![0]];
  const c1: Vec3 = [matrix[0]![1], matrix[1]![1], matrix[2]![1]];
  const c2: Vec3 = [matrix[0]![2], matrix[1]![2], matrix[2]![2]];
  return [
    dot(values, cross(c1, c2)) / det,
    dot(c0, cross(values, c2)) / det,
    dot(c0, cross(c1, values)) / det,
  ];
}
function rowTimesMatrix(vector: Vec3, matrix: Vec3[]): Vec3 {
  return [
    vector[0] * matrix[0]![0] + vector[1] * matrix[1]![0] + vector[2] * matrix[2]![0],
    vector[0] * matrix[0]![1] + vector[1] * matrix[1]![1] + vector[2] * matrix[2]![1],
    vector[0] * matrix[0]![2] + vector[1] * matrix[1]![2] + vector[2] * matrix[2]![2],
  ];
}
function multiplyMatrices(a: Vec3[], b: Vec3[]): Vec3[] {
  return a.map((row) =>
    [0, 1, 2].map((column) =>
      row[0] * b[0]![column] + row[1] * b[1]![column] + row[2] * b[2]![column],
    ) as Vec3,
  );
}
function plane(n: Vec3, d: number): Plane {
  return { n, d };
}

function cleanPlanes(planes: Plane[]): Plane[] {
  const result: Plane[] = [];
  for (const item of planes) {
    const magnitude = length(item.n);
    if (magnitude < EPSILON) continue;
    const normalizedPlane = { n: scale(item.n, 1 / magnitude), d: item.d / magnitude };
    const duplicate = result.find(
      (old) => distance(old.n, normalizedPlane.n) < 1e-7 && Math.abs(old.d - normalizedPlane.d) < 1e-7,
    );
    if (!duplicate) result.push(normalizedPlane);
  }
  return result;
}

function buildPolyhedron(inputPlanes: Plane[]): Polyhedron | null {
  const planes = cleanPlanes(inputPlanes);
  const vertices: Vec3[] = [];
  for (let i = 0; i < planes.length - 2; i += 1) {
    for (let j = i + 1; j < planes.length - 1; j += 1) {
      for (let k = j + 1; k < planes.length; k += 1) {
        const point = solve3(
          [planes[i]!.n, planes[j]!.n, planes[k]!.n],
          [planes[i]!.d, planes[j]!.d, planes[k]!.d],
        );
        if (!point) continue;
        const inside = planes.every((boundary) => dot(boundary.n, point) <= boundary.d + 2e-7);
        if (!inside) continue;
        if (!vertices.some((old) => distance(old, point) < 2e-6)) vertices.push(point);
      }
    }
  }
  if (vertices.length < 4) return null;

  const centroid = vertices.reduce((sum, point) => add(sum, point), [0, 0, 0] as Vec3);
  const center = scale(centroid, 1 / vertices.length);
  const triangles: [number, number, number][] = [];

  for (const boundary of planes) {
    const ids = vertices
      .map((point, index) => ({ point, index }))
      .filter((entry) => Math.abs(dot(boundary.n, entry.point) - boundary.d) < 3e-6)
      .map((entry) => entry.index);
    if (ids.length < 3) continue;
    const faceCenter = ids
      .map((index) => vertices[index]!)
      .reduce((sum, point) => add(sum, point), [0, 0, 0] as Vec3);
    const faceOrigin = scale(faceCenter, 1 / ids.length);
    const normal = normalize(boundary.n);
    const reference: Vec3 = Math.abs(normal[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
    const axisU = normalize(cross(reference, normal));
    const axisV = cross(normal, axisU);
    ids.sort((left, right) => {
      const a = subtract(vertices[left]!, faceOrigin);
      const b = subtract(vertices[right]!, faceOrigin);
      return Math.atan2(dot(a, axisV), dot(a, axisU)) - Math.atan2(dot(b, axisV), dot(b, axisU));
    });
    for (let index = 1; index < ids.length - 1; index += 1) {
      triangles.push([ids[0]!, ids[index]!, ids[index + 1]!]);
    }
  }

  let signedVolume = 0;
  for (const triangle of triangles) {
    const a = subtract(vertices[triangle[0]]!, center);
    const b = subtract(vertices[triangle[1]]!, center);
    const c = subtract(vertices[triangle[2]]!, center);
    signedVolume += dot(a, cross(b, c)) / 6;
  }
  const volume = Math.abs(signedVolume);
  if (volume < 1e-7) return null;
  return { vertices, triangles, center, volume, planes };
}

function boxPlanes(dimensions: Vec3): Plane[] {
  const result: Plane[] = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const normal: Vec3 = [0, 0, 0];
    normal[axis] = 1;
    result.push(plane(normal, dimensions[axis]));
    result.push(plane(scale(normal, -1), 0));
  }
  return result;
}

function integerTriples(min: number, max: number): Vec3[] {
  const result: Vec3[] = [];
  for (let x = min; x <= max; x += 1) {
    for (let y = min; y <= max; y += 1) {
      for (let z = min; z <= max; z += 1) result.push([x, y, z]);
    }
  }
  return result;
}

export function truncatedOctahedronPlanes(): Plane[] {
  const planes: Plane[] = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const normal: Vec3 = [0, 0, 0];
    normal[axis] = 1;
    planes.push(plane(normal, 2 * Q));
    planes.push(plane(scale(normal, -1), 2 * Q));
  }
  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) {
      for (const z of [-1, 1]) planes.push(plane([x, y, z], 3 * Q));
    }
  }
  return planes;
}

export function truncatedOctahedronVertices(): Vector3[] {
  const poly = buildPolyhedron(truncatedOctahedronPlanes());
  if (!poly) throw new Error('truncated octahedron hull failed');
  return poly.vertices.map((v) => new Vector3(...v));
}

function cubeBasisQuaternion(): Quaternion {
  const m = new Matrix4().set(
    CUBE_BASIS_ROWS[0]![0], CUBE_BASIS_ROWS[1]![0], CUBE_BASIS_ROWS[2]![0], 0,
    CUBE_BASIS_ROWS[0]![1], CUBE_BASIS_ROWS[1]![1], CUBE_BASIS_ROWS[2]![1], 0,
    CUBE_BASIS_ROWS[0]![2], CUBE_BASIS_ROWS[1]![2], CUBE_BASIS_ROWS[2]![2], 0,
    0, 0, 0, 1,
  );
  return new Quaternion().setFromRotationMatrix(m);
}

function translationMatrix(offset: Vec3): Matrix4 {
  return new Matrix4().makeTranslation(offset[0], offset[1], offset[2]);
}

function composePose(position: Vec3, quaternion: Quaternion): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...position),
    quaternion.clone(),
    new Vector3(1, 1, 1),
  );
}

function geometryVolume(geometry: BufferGeometry): number {
  const position = geometry.getAttribute('position') as BufferAttribute;
  let signedVolume = 0;
  for (let index = 0; index < position.count; index += 3) {
    const a: Vec3 = [position.getX(index), position.getY(index), position.getZ(index)];
    const b: Vec3 = [position.getX(index + 1), position.getY(index + 1), position.getZ(index + 1)];
    const c: Vec3 = [position.getX(index + 2), position.getY(index + 2), position.getZ(index + 2)];
    signedVolume += dot(a, cross(b, c)) / 6;
  }
  return Math.abs(signedVolume);
}

function geometryFromPolyhedron(data: Polyhedron): BufferGeometry {
  const positions: number[] = [];
  for (const triangle of data.triangles) {
    for (const vertexIndex of triangle) {
      const local = subtract(data.vertices[vertexIndex]!, data.center);
      positions.push(local[0], local[1], local[2]);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function pieceAxis(position: Vec3): Vector3 {
  const axis = new Vector3(...position);
  if (axis.lengthSq() < 1e-10) return new Vector3(0, 1, 0);
  return axis.normalize();
}

function toPiece(
  id: string,
  label: string,
  geometry: BufferGeometry,
  volume: number,
  color: number,
  cubeMatrix: Matrix4,
  targetMatrix: Matrix4,
): DissectionPiece {
  const e = cubeMatrix.elements;
  return {
    id,
    label,
    role: 'piece',
    geometry,
    volume,
    color,
    cubeSlot: 'cube',
    targetSlot: 'truncated octahedron',
    cubeMatrix,
    targetMatrix,
    axis: pieceAxis([e[12], e[13], e[14]]),
  };
}

export function buildTheobald11(): TruncatedOctBuild {
  const identity = new Quaternion();
  const pieces = THEOBALD_RAW.map((item, index) => {
    const center = scale(
      item.vertices.reduce((sum, vertex) => add(sum, vertex), [0, 0, 0] as Vec3),
      1 / item.vertices.length,
    );
    const points = item.vertices.map((vertex) => new Vector3(...subtract(vertex, center)));
    const geometry = new ConvexGeometry(points);
    geometry.computeVertexNormals();
    const volume = geometryVolume(geometry);
    const cubePos = add(center, item.cubeOffset);
    const targetPos = add(center, item.targetOffset);
    return toPiece(
      `to11-${item.id}`,
      `Piece ${String(item.id).padStart(2, '0')}`,
      geometry,
      volume,
      COLORS[index % COLORS.length]!,
      composePose(cubePos, identity),
      composePose(targetPos, identity),
    );
  });
  return {
    pieces,
    totalVolume: pieces.reduce((sum, piece) => sum + piece.volume, 0),
    targetVertices: truncatedOctahedronVertices(),
    cubeWireQuaternion: cubeBasisQuaternion(),
    translational: true,
  };
}

function latticeRotation(): { rows: Vec3[]; quaternion: Quaternion } {
  const sortedDimensions: Vec3 = [2 * Q, 4 * Q, 4 * Q];
  const b21 = -Math.sqrt((sortedDimensions[1] * sortedDimensions[2]) ** 2 - 1) / sortedDimensions[2];
  const b32 = Math.sqrt(sortedDimensions[2] * sortedDimensions[2] - 1);
  const brickLattice: Vec3[] = [
    [1, 0, 0],
    [b21, 1, 0],
    [0, b32, 1],
  ];
  const reverseRows: Vec3[] = [];
  for (let rowIndex = 2; rowIndex >= 0; rowIndex -= 1) {
    let row = [...brickLattice[rowIndex]!] as Vec3;
    for (const old of reverseRows) {
      row = subtract(row, scale(old, dot(row, old) / dot(old, old)));
    }
    reverseRows.push(row);
  }
  const orthogonalRows = reverseRows.reverse();
  const directions = orthogonalRows.map((row, index) => scale(row, 1 / sortedDimensions[index]!));
  const permutation: Vec3[] = [
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 0],
  ];
  const rows = multiplyMatrices(permutation, directions);
  const matrix = new Matrix4().set(
    rows[0]![0], rows[1]![0], rows[2]![0], 0,
    rows[0]![1], rows[1]![1], rows[2]![1], 0,
    rows[0]![2], rows[1]![2], rows[2]![2], 0,
    0, 0, 0, 1,
  );
  return { rows, quaternion: new Quaternion().setFromRotationMatrix(matrix) };
}

export function buildLattice22(): TruncatedOctBuild {
  const brickDimensions: Vec3 = [4 * Q, 4 * Q, 2 * Q];
  const basePlanes = boxPlanes(brickDimensions);
  const targetPlanes = truncatedOctahedronPlanes();
  const targetLattice: Vec3[] = [
    [4 * Q, 0, 0],
    [0, 4 * Q, 0],
    [2 * Q, 2 * Q, 2 * Q],
  ];
  const targetPartitions: { offset: Vec3; planes: Plane[] }[] = [];
  for (const coords of integerTriples(-2, 2)) {
    const offset = rowTimesMatrix(coords, targetLattice);
    const shiftedTargetPlanes = targetPlanes.map((boundary) =>
      plane(boundary.n, boundary.d - dot(boundary.n, offset)),
    );
    const planes = [...basePlanes, ...shiftedTargetPlanes];
    const polyhedron = buildPolyhedron(planes);
    if (polyhedron) targetPartitions.push({ offset, planes });
  }

  const { rows: cubeRotationRows, quaternion: cubeQuaternion } = latticeRotation();
  const brickLattice: Vec3[] = (() => {
    const sortedDimensions: Vec3 = [2 * Q, 4 * Q, 4 * Q];
    const b21 = -Math.sqrt((sortedDimensions[1] * sortedDimensions[2]) ** 2 - 1) / sortedDimensions[2];
    const b32 = Math.sqrt(sortedDimensions[2] * sortedDimensions[2] - 1);
    return [
      [1, 0, 0],
      [b21, 1, 0],
      [0, b32, 1],
    ] as Vec3[];
  })();

  const cubePartitions: { offset: Vec3 }[] = [];
  for (const coords of integerTriples(-2, 2)) {
    const offset = rowTimesMatrix(coords, brickLattice);
    const planes = [...basePlanes];
    for (let axis = 0; axis < 3; axis += 1) {
      const normal: Vec3 = [cubeRotationRows[0]![axis], cubeRotationRows[1]![axis], cubeRotationRows[2]![axis]];
      planes.push(plane(normal, offset[axis] + 1 - CUBE_SHIFT[axis]));
      planes.push(plane(scale(normal, -1), -offset[axis] + CUBE_SHIFT[axis]));
    }
    if (buildPolyhedron(planes)) cubePartitions.push({ offset });
  }

  const pieces: DissectionPiece[] = [];
  targetPartitions.forEach((targetPart, targetIndex) => {
    for (const cubePart of cubePartitions) {
      const planes = [...targetPart.planes];
      for (let axis = 0; axis < 3; axis += 1) {
        const normal: Vec3 = [cubeRotationRows[0]![axis], cubeRotationRows[1]![axis], cubeRotationRows[2]![axis]];
        planes.push(plane(normal, cubePart.offset[axis] + 1 - CUBE_SHIFT[axis]));
        planes.push(plane(scale(normal, -1), -cubePart.offset[axis] + CUBE_SHIFT[axis]));
      }
      const polyhedron = buildPolyhedron(planes);
      if (!polyhedron) continue;
      const rotatedCenter = rowTimesMatrix(polyhedron.center, cubeRotationRows);
      const cubePos: Vec3 = [
        rotatedCenter[0] + CUBE_SHIFT[0] - cubePart.offset[0] - 0.5,
        rotatedCenter[1] + CUBE_SHIFT[1] - cubePart.offset[1] - 0.5,
        rotatedCenter[2] + CUBE_SHIFT[2] - cubePart.offset[2] - 0.5,
      ];
      const targetPos = add(polyhedron.center, targetPart.offset);
      pieces.push(
        toPiece(
          `to22-${targetIndex}-${pieces.length}`,
          `Piece ${String(pieces.length + 1).padStart(2, '0')}`,
          geometryFromPolyhedron(polyhedron),
          polyhedron.volume,
          COLORS[targetIndex % COLORS.length]!,
          composePose(cubePos, cubeQuaternion),
          translationMatrix(targetPos),
        ),
      );
    }
  });
  pieces.sort((a, b) => b.volume - a.volume);
  pieces.forEach((piece, index) => {
    piece.label = `Piece ${String(index + 1).padStart(2, '0')}`;
  });

  return {
    pieces,
    totalVolume: pieces.reduce((sum, piece) => sum + piece.volume, 0),
    targetVertices: truncatedOctahedronVertices(),
    cubeWireQuaternion: new Quaternion(),
    translational: false,
  };
}
