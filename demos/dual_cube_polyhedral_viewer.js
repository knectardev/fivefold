import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as geom from '../solvers/dual_cube/half_cells.mjs';
import * as exp from '../solvers/dual_cube/polyhedral_export.mjs';
import * as occ from '../solvers/dual_cube/polyhedral_occupancy.mjs';

const COLORS = [0x4e79a7, 0xf28e2b, 0xe15759, 0x76b7b2, 0x59a14f, 0xedc948, 0xb07aa1, 0xff9da7];
const WEDGE = 0xffe066;
const CUT = 0xfff4b0;

const canvas = document.getElementById('c');
const summary = document.getElementById('summary');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0c1018);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
camera.position.set(14, 12, 18);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
scene.add(new THREE.AmbientLight(0xffffff, 0.62));
const key = new THREE.DirectionalLight(0xffffff, 0.9);
key.position.set(8, 14, 10);
scene.add(key);
const fill = new THREE.DirectionalLight(0x88aacc, 0.35);
fill.position.set(-10, -4, -8);
scene.add(fill);
const group = new THREE.Group();
scene.add(group);

let doc = null;
let framedFor = '';

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}

function clearGroup() {
  while (group.children.length) {
    const ch = group.children.pop();
    ch.traverse((node) => {
      node.geometry?.dispose();
      if (Array.isArray(node.material)) node.material.forEach((m) => m.dispose());
      else node.material?.dispose();
    });
  }
}

function geoFromTris(tris) {
  const geo = new THREE.BufferGeometry();
  const pos = [];
  for (const t of tris) for (const p of t) pos.push(p[0], p[1], p[2]);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

function meshFromTris(tris, color, opts = {}) {
  const geo = geoFromTris(tris);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      color,
      roughness: opts.roughness ?? 0.42,
      metalness: 0.04,
      flatShading: true,
      side: THREE.DoubleSide,
      transparent: !!opts.transparent,
      opacity: opts.opacity ?? 1,
      depthWrite: opts.depthWrite ?? !opts.transparent,
      emissive: opts.emissive ?? 0x000000,
      emissiveIntensity: opts.emissiveIntensity ?? 1,
      polygonOffset: !!opts.polygonOffset,
      polygonOffsetFactor: opts.polygonOffsetFactor ?? -1,
      polygonOffsetUnits: opts.polygonOffsetUnits ?? -1,
    }),
  );
  return mesh;
}

function addEdges(mesh, color = 0x0b1018, threshold = 28) {
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry, threshold),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }),
  );
  mesh.add(edges);
}

function assemblyMode() {
  return document.querySelector('input[name="asm"]:checked')?.value || 'cuts';
}

function flag(id) {
  return !!document.getElementById(id)?.checked;
}

function listHalves(source) {
  const rows = [];
  for (const piece of source.pieces) {
    for (const atom of piece.atoms) {
      if (atom.kind !== 'half') continue;
      rows.push({
        piece: piece.id,
        cell: atom.cell.slice(),
        plane: atom.plane,
        side: atom.side,
        atom,
      });
    }
  }
  return rows;
}

function uniqueSplitCells(halves) {
  const seen = new Map();
  for (const h of halves) {
    const k = h.cell.join(',');
    if (!seen.has(k)) seen.set(k, { cell: h.cell, plane: h.plane, pieces: new Set() });
    seen.get(k).pieces.add(h.piece);
  }
  return [...seen.values()];
}

function planeNormal(planeIdx) {
  const plane = geom.PLANES[planeIdx];
  const n = [0, 0, 0];
  if (plane.kind === 'eq') {
    n[plane.a] = 1;
    n[plane.b] = -1;
  } else {
    n[plane.a] = 1;
    n[plane.b] = 1;
  }
  const mag = Math.hypot(n[0], n[1], n[2]) || 1;
  return n.map((x) => x / mag);
}

function explodeOffset(atoms, N, extra = 0) {
  const c = atoms.reduce((s, a) => [s[0] + a.cell[0], s[1] + a.cell[1], s[2] + a.cell[2]], [0, 0, 0]);
  const n = Math.max(1, atoms.length);
  return new THREE.Vector3(
    (c[0] / n - N / 2) * (0.42 + extra) + extra * N * 0.15,
    (c[1] / n - N / 2) * (0.42 + extra),
    (c[2] / n - N / 2) * (0.42 + extra),
  );
}

function cutTris(atom) {
  const shell = exp.pieceShell([atom]);
  return shell.faces.filter((f) => f.key.startsWith('d')).flatMap((f) => f.triangles);
}

function framePoints(points) {
  if (!points.length) return;
  const box = new THREE.Box3();
  for (const p of points) box.expandByPoint(new THREE.Vector3(p[0], p[1], p[2]));
  const center = box.getCenter(new THREE.Vector3());
  const size = Math.max(2.5, box.getSize(new THREE.Vector3()).length());
  controls.target.copy(center);
  camera.position.set(center.x + size * 0.95, center.y + size * 0.7, center.z + size * 1.15);
  camera.near = Math.max(0.05, size / 80);
  camera.far = Math.max(200, size * 20);
  camera.updateProjectionMatrix();
}

function splitFocusPoints(halves, N, mode, isolate, pull) {
  const pts = [];
  for (const h of halves) {
    const piece = doc.pieces.find((p) => p.id === h.piece);
    const atoms = mode === 'B'
      ? piece.atoms.map((a) => occ.transformAtom(a, piece.transformB, N))
      : piece.atoms;
    const atom = mode === 'B'
      ? occ.transformAtom(h.atom, piece.transformB, N)
      : h.atom;
    const offset = new THREE.Vector3();
    if (mode === 'explode' || (mode === 'cuts' && isolate)) {
      offset.add(explodeOffset(atoms, N, 0.25));
    } else if (mode === 'B') {
      offset.x = N + 1.5;
    }
    if (pull && (mode === 'cuts' || mode === 'explode')) {
      const n = planeNormal(atom.plane);
      offset.add(new THREE.Vector3(n[0], n[1], n[2]).multiplyScalar((atom.side ? 1 : -1) * 0.55));
    }
    pts.push([
      atom.cell[0] + 0.5 + offset.x,
      atom.cell[1] + 0.5 + offset.y,
      atom.cell[2] + 0.5 + offset.z,
    ]);
  }
  return pts;
}

function renderDoc(opts = {}) {
  clearGroup();
  if (!doc) return;
  const N = doc.N;
  const mode = assemblyMode();
  const highlight = flag('highlight') || mode === 'cuts';
  const isolate = flag('isolate');
  const pull = flag('pull') && (mode === 'cuts' || mode === 'explode');
  const halves = listHalves(doc);
  const splitPieceIds = new Set(halves.map((h) => h.piece));
  const splits = uniqueSplitCells(halves);

  for (const piece of doc.pieces) {
    const atoms = mode === 'B'
      ? piece.atoms.map((a) => occ.transformAtom(a, piece.transformB, N))
      : piece.atoms;
    const hasSplit = splitPieceIds.has(piece.id);
    const hideSolid = isolate && !hasSplit && (mode === 'cuts' || mode === 'explode');
    const ghostPacked = isolate && !hasSplit && (mode === 'A' || mode === 'B');
    const color = COLORS[piece.id % COLORS.length];
    const xray = highlight && mode !== 'explode';
    const ghost = xray || ghostPacked || mode === 'cuts';
    const shellAtoms = highlight
      ? atoms.filter((a) => a.kind === 'full')
      : atoms;
    const offset = new THREE.Vector3();
    if (mode === 'explode' || (mode === 'cuts' && isolate)) {
      offset.add(explodeOffset(atoms, N, hasSplit ? 0.25 : 0));
    } else if (mode === 'B') {
      offset.x = N + 1.5;
    }
    if (!hideSolid && shellAtoms.length) {
      const mesh = meshFromTris(exp.pieceShell(shellAtoms).triangles, color, {
        transparent: ghost,
            opacity: ghost ? (ghostPacked ? 0.06 : 0.16) : 1,
        depthWrite: !ghost,
      });
      mesh.position.copy(offset);
      if (!ghost) addEdges(mesh, 0x101820, 22);
      group.add(mesh);
    }

    if (!highlight) continue;
    for (const atom of atoms) {
      if (atom.kind !== 'half') continue;
      const wedge = meshFromTris(exp.pieceTriangles([atom]), WEDGE, {
        emissive: 0x665200,
        roughness: 0.35,
      });
      addEdges(wedge, 0x3a2a00, 12);
      const cut = cutTris(atom);
      const cutMesh = cut.length
        ? meshFromTris(cut, CUT, {
          emissive: 0xaa8800,
          polygonOffset: true,
          roughness: 0.28,
        })
        : null;
      const n = planeNormal(atom.plane);
      const pullVec = pull
        ? new THREE.Vector3(n[0], n[1], n[2]).multiplyScalar((atom.side ? 1 : -1) * 0.55)
        : new THREE.Vector3();
      const pos = offset.clone().add(pullVec);
      wedge.position.copy(pos);
      group.add(wedge);
      if (cutMesh) {
        cutMesh.position.copy(pos);
        group.add(cutMesh);
      }
    }
  }

  const proof = doc.proof || {};
  const go = proof.goNogo || {};
  const splitCount = splits.length || proof.splitCellCount || 0;
  const packedLooksVoxel = splitCount <= 2;
  const rows = halves.map((h) =>
    `<tr><td>P${h.piece}</td><td>(${h.cell.join(',')})</td><td>plane ${h.plane}</td><td>side ${h.side}</td></tr>`
  ).join('');
  summary.innerHTML = `
    <div class="note">
      <p class="${packedLooksVoxel ? 'warn' : 'ok'}">
        ${packedLooksVoxel
          ? 'Packed Cube A is still a cube of cubes. Complementary halves fill each split cell, so the outer surface stays voxel. Cuts view shows the actual 45° wedges.'
          : 'Diagonal sheets are present in this candidate.'}
      </p>
    </div>
    <p>N=${doc.N} pieces=${doc.pieceCount}</p>
    <p class="${go.pass ? 'ok' : 'bad'}">${go.pass ? 'Phase 1 fixture' : 'Not a Phase 1 pass'}: ${go.reason || ''}</p>
    <p>solver: ${proof.solver || '—'} &nbsp; split cells: ${splitCount}</p>
    <p>diagonal area: ${proof.mergedDiagonalArea ?? 0} &nbsp; faces: ${proof.faceCount ?? '—'}</p>
    <p class="stat">${halves.length} half-atoms on ${splitCount} cell${splitCount === 1 ? '' : 's'}.</p>
    ${rows ? `<table><thead><tr><th>piece</th><th>cell</th><th>cut</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p>No half-cubes in this file.</p>'}
  `;

  const focusKey = `${mode}:${isolate}:${pull}:${halves.map((h) => h.cell.join('x')).join('|')}`;
  if (opts.forceFrame || framedFor !== focusKey) {
    if (mode === 'cuts' || isolate) {
      framePoints(splitFocusPoints(halves, N, mode === 'B' ? 'B' : mode, isolate, pull));
    } else if (mode === 'explode') {
      const pts = [];
      for (const piece of doc.pieces) {
        const off = explodeOffset(piece.atoms, N, 0);
        for (const a of piece.atoms) {
          pts.push([a.cell[0] + 0.5 + off.x, a.cell[1] + 0.5 + off.y, a.cell[2] + 0.5 + off.z]);
        }
      }
      framePoints(pts);
    } else {
      const x0 = mode === 'B' ? N + 1.5 : 0;
      framePoints([[x0, 0, 0], [x0 + N, N, N]]);
    }
    framedFor = focusKey;
  }
}

function asPolyhedral(raw) {
  if (raw?.pieces) return raw;
  return occ.voxelToPolyhedral(raw);
}

const PHASE1 = '/solvers/dual_cube/results/polyhedral_N8_P8.phase1.json';
const NATIVE = '/solvers/dual_cube/results/polyhedral_N8_P8.native.json';
const IMPROVED = '/solvers/dual_cube/results/polyhedral_N8_P8.improved.json';
const VOXEL = '/solvers/dual_cube/results/candidate_N8_P8_connected.json';

async function loadUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  framedFor = '';
  doc = asPolyhedral(await res.json());
  renderDoc({ forceFrame: true });
}

async function loadDefault() {
  try {
    await loadUrl(PHASE1);
  } catch {
    try {
      await loadUrl(IMPROVED);
    } catch {
      await loadUrl(VOXEL);
      summary.innerHTML += '<p class="bad">Loaded voxel seed; Phase 1 JSON not found.</p>';
    }
  }
}

document.getElementById('loadDefault').onclick = () => loadDefault();
document.getElementById('loadNative').onclick = async () => {
  try {
    await loadUrl(NATIVE);
  } catch {
    summary.innerHTML += '<p class="bad">Native search JSON not found. Run npm run search:n8-native.</p>';
  }
};
document.getElementById('file').onchange = async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  framedFor = '';
  doc = asPolyhedral(JSON.parse(await f.text()));
  renderDoc({ forceFrame: true });
};
document.getElementById('frameCuts').onclick = () => renderDoc({ forceFrame: true });
for (const el of document.querySelectorAll('input[name="asm"], #highlight, #isolate, #pull')) {
  el.onchange = () => renderDoc();
}

function loop() {
  resize();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
loop();
loadDefault();
