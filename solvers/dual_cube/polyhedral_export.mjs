/**
 * Combinatorial polyhedral export: emit atom faces, cancel opposite internals,
 * merge coplanar exterior polygons. Vertices stay on the integer lattice.
 */
import * as geom from './half_cells.mjs';

function doubled(p) {
  return [Math.round(p[0] * 2), Math.round(p[1] * 2), Math.round(p[2] * 2)];
}

function undoubled(p) {
  return [p[0] / 2, p[1] / 2, p[2] / 2];
}

function triNormal(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
}

function orientKey(a, b, c) {
  const n = triNormal(a, b, c);
  const mag = Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]);
  const s = n[0] > 0 || (n[0] === 0 && n[1] > 0) || (n[0] === 0 && n[1] === 0 && n[2] >= 0) ? 1 : -1;
  const verts = [a, b, c].map((p) => p.join(',')).sort();
  return { geom: verts.join('|'), sign: s, mag };
}

function lexLess(a, b) {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) || (a[0] === b[0] && a[1] === b[1] && a[2] < b[2]);
}

function triangulate(poly) {
  if (poly.length < 3) return [];
  const ordered = geom.orderCoplanar(poly);
  if (ordered.length < 3) return [];
  let start = 0;
  for (let i = 1; i < ordered.length; i++) {
    if (lexLess(ordered[i], ordered[start])) start = i;
  }
  const rot = ordered.slice(start).concat(ordered.slice(0, start));
  const tris = [];
  for (let i = 1; i < rot.length - 1; i++) tris.push([rot[0], rot[i], rot[i + 1]]);
  return tris;
}

function centroid(pts) {
  const n = pts.length || 1;
  return [
    pts.reduce((s, p) => s + p[0], 0) / n,
    pts.reduce((s, p) => s + p[1], 0) / n,
    pts.reduce((s, p) => s + p[2], 0) / n,
  ];
}

function orientOutward(poly, interior) {
  if (poly.length < 3) return poly;
  const n = triNormal(poly[0], poly[1], poly[2]);
  const mid = centroid(poly);
  const toFace = [mid[0] - interior[0], mid[1] - interior[1], mid[2] - interior[2]];
  if (n[0] * toFace[0] + n[1] * toFace[1] + n[2] * toFace[2] < 0) {
    return poly.slice().reverse();
  }
  return poly;
}

function atomPolygons(atom) {
  const local = atom.kind === 'full'
    ? geom.fullFacePolygons()
    : geom.halfFacePolygons(geom.halfIndex(atom.plane, atom.side));
  const localIn = atom.kind === 'full'
    ? [0.5, 0.5, 0.5]
    : geom.probePoint(geom.halfIndex(atom.plane, atom.side));
  const interior = [
    atom.cell[0] + localIn[0],
    atom.cell[1] + localIn[1],
    atom.cell[2] + localIn[2],
  ];
  return local.map((p) => orientOutward(geom.worldPolygon(atom.cell, p), interior));
}

export function pieceTriangles(atoms) {
  const counts = new Map();
  const samples = new Map();
  for (const atom of atoms) {
    for (const poly of atomPolygons(atom)) {
      for (const tri of triangulate(poly)) {
        const d = tri.map(doubled);
        const { geom, sign, mag } = orientKey(d[0], d[1], d[2]);
        if (mag === 0) continue;
        counts.set(geom, (counts.get(geom) || 0) + sign);
        if (!samples.has(geom)) samples.set(geom, d);
      }
    }
  }
  const out = [];
  for (const [geom, n] of counts) {
    if (n === 0) continue;
    const d = samples.get(geom);
    const verts = geom.split('|').map((s) => s.split(',').map(Number));
    let tri = verts.length === 3 ? verts : d;
    if (n < 0) tri = [tri[0], tri[2], tri[1]];
    out.push(tri.map(undoubled));
  }
  return out;
}

function planeKey(tri) {
  const n = triNormal(tri[0], tri[1], tri[2]);
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  let axis = 2;
  if (ax >= ay && ax >= az) axis = 0;
  else if (ay >= ax && ay >= az) axis = 1;
  const sign = n[axis] >= 0 ? 1 : -1;
  const nn = [0, 0, 0];
  nn[axis] = sign;
  if (ax > 0 && ay > 0 && az === 0) {
    return `dxy:${Math.round(2 * (tri[0][0] - sign * tri[0][1]))}`;
  }
  if (ax > 0 && az > 0 && ay === 0) {
    return `dxz:${Math.round(2 * (tri[0][0] - sign * tri[0][2]))}`;
  }
  if (ay > 0 && az > 0 && ax === 0) {
    return `dyz:${Math.round(2 * (tri[0][1] - sign * tri[0][2]))}`;
  }
  const off = Math.round(2 * (nn[0] * tri[0][0] + nn[1] * tri[0][1] + nn[2] * tri[0][2]));
  return `a${axis}s${sign}o${off}`;
}

export function mergeCoplanar(tris) {
  const groups = new Map();
  for (const tri of tris) {
    const k = planeKey(tri);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(tri);
  }
  const faces = [];
  for (const [key, group] of groups) {
    const area = group.reduce((s, t) => s + geom.polygonArea(t), 0);
    faces.push({
      key,
      triangles: group,
      area,
      vertexCount: new Set(group.flat().map((p) => p.join(','))).size,
    });
  }
  return faces;
}

export function pieceShell(atoms) {
  const tris = pieceTriangles(atoms);
  const faces = mergeCoplanar(tris);
  const area = faces.reduce((s, f) => s + f.area, 0);
  const minFace = faces.reduce((m, f) => Math.min(m, f.area), Infinity);
  const edgeCount = countBoundaryEdges(tris);
  return {
    triangles: tris,
    faces,
    faceCount: faces.length,
    triangleCount: tris.length,
    area,
    minFaceArea: faces.length ? minFace : 0,
    boundaryEdgeCount: edgeCount,
    manifold: edgeCount >= 0 && tris.length > 0,
  };
}

function countBoundaryEdges(tris) {
  const edges = new Map();
  for (const tri of tris) {
    for (let i = 0; i < 3; i++) {
      const a = doubled(tri[i]).join(',');
      const b = doubled(tri[(i + 1) % 3]).join(',');
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const k = `${lo}|${hi}`;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  let boundary = 0;
  let bad = 0;
  for (const n of edges.values()) {
    if (n === 1) boundary++;
    else if (n !== 2) bad++;
  }
  return bad ? -1 : boundary;
}

export function exportOBJ(doc, which = 'A') {
  const N = doc.N;
  const lines = [`# dual-cube polyhedral ${which}`, `g cube_${which}`];
  let vOff = 1;
  const materials = [];
  for (const piece of doc.pieces) {
    const atoms = which === 'B'
      ? piece.atoms.map((a) => ({
        ...a,
        cell: a.cell,
      }))
      : piece.atoms;
    const shell = pieceShell(
      which === 'B' ? transformAtomsForExport(piece, N) : atoms,
    );
    lines.push(`o piece_${piece.id}`);
    lines.push(`usemtl piece_${piece.id}`);
    for (const tri of shell.triangles) {
      for (const p of tri) lines.push(`v ${p[0]} ${p[1]} ${p[2]}`);
      lines.push(`f ${vOff} ${vOff + 1} ${vOff + 2}`);
      vOff += 3;
    }
    materials.push(piece.id);
  }
  return lines.join('\n') + '\n';
}

export function exportSTL(doc, which = 'A') {
  const lines = [`solid dual_cube_${which}`];
  for (const piece of doc.pieces) {
    const atoms = which === 'B' ? (piece._bAtoms || piece.atoms) : piece.atoms;
    const shell = pieceShell(atoms);
    for (const tri of shell.triangles) {
      const n = triNormal(tri[0], tri[1], tri[2]);
      const mag = Math.hypot(n[0], n[1], n[2]) || 1;
      lines.push(`  facet normal ${n[0] / mag} ${n[1] / mag} ${n[2] / mag}`);
      lines.push('    outer loop');
      for (const p of tri) lines.push(`      vertex ${p[0]} ${p[1]} ${p[2]}`);
      lines.push('    endloop');
      lines.push('  endfacet');
    }
  }
  lines.push(`endsolid dual_cube_${which}`);
  return lines.join('\n') + '\n';
}

function transformAtomsForExport(piece, N) {
  return piece._bAtoms || piece.atoms;
}

export function attachBAtoms(doc, transformAtom, N) {
  for (const piece of doc.pieces) {
    piece._bAtoms = piece.atoms.map((a) => transformAtom(a, piece.transformB, N));
  }
  return doc;
}

export function geometryMetrics(doc, transformAtom) {
  const N = doc.N;
  const perPiece = [];
  let faceCount = 0;
  let edgeCount = 0;
  let minFace = Infinity;
  let splitCells = 0;
  let diagonalArea = 0;
  let maxDiagonal = 0;
  for (const piece of doc.pieces) {
    const shellA = pieceShell(piece.atoms);
    const shellB = pieceShell(piece.atoms.map((a) => transformAtom(a, piece.transformB, N)));
    perPiece.push({ id: piece.id, A: shellA, B: shellB });
    faceCount += shellA.faceCount;
    edgeCount += Math.max(0, shellA.boundaryEdgeCount);
    minFace = Math.min(minFace, shellA.minFaceArea || Infinity);
    for (const face of shellA.faces) {
      if (face.key.startsWith('d')) {
        diagonalArea += face.area;
        if (face.area > maxDiagonal) maxDiagonal = face.area;
      }
    }
    for (const atom of piece.atoms) if (atom.kind === 'half') splitCells += 0.5;
  }
  return {
    faceCount,
    boundaryEdgeCount: edgeCount,
    minFaceArea: minFace === Infinity ? 0 : minFace,
    splitCellCount: splitCells,
    mergedDiagonalArea: diagonalArea,
    maxDiagonalFace: maxDiagonal,
    perPiece,
  };
}
