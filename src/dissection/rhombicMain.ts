/**
 * Interactive viewer for cube dissections (truncated octahedron + rhombic dodecahedron).
 */
import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshPhongMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { finalizeHull } from '../geom/convexHull';
import { blendMatrix } from './pieces';
import { SIGMA, buildRhombicPieces } from './rhombic';
import {
  buildLattice22,
  buildTheobald11,
  type DissectionPiece,
} from './truncatedOct';

type Mode = 'cube' | 'target' | 'both';
export type ConstructionKind = 'to11' | 'to22' | 'rd32';

type Kit = {
  kind: ConstructionKind;
  title: string;
  targetShort: string;
  pieces: DissectionPiece[];
  totalVolume: number;
  cubeWireQuaternion: Quaternion;
  targetVertices: Vector3[];
  translational: boolean;
  volumesHtml: string;
  howHtml: string;
  verdictHtml: string;
};

const el = {
  title: document.getElementById('pageTitle')!,
  lead: document.getElementById('lead')!,
  status: document.getElementById('status')!,
  verdict: document.getElementById('verdict')!,
  how: document.getElementById('how')!,
  volumes: document.getElementById('volumes')!,
  pieceMatrix: document.getElementById('pieceMatrix')!,
  pieceHeading: document.getElementById('pieceHeading')!,
  selectedDetail: document.getElementById('selectedDetail')!,
  modeBadge: document.getElementById('modeBadge')!,
  previewWrap: document.getElementById('previewWrap') as HTMLDivElement,
  preview: document.getElementById('preview') as HTMLCanvasElement,
  morph: document.getElementById('morph') as HTMLInputElement,
  morphLabel: document.getElementById('morphLabel')!,
  explode: document.getElementById('explode') as HTMLInputElement,
  showWire: document.getElementById('showWire') as HTMLInputElement,
  wireLabel: document.getElementById('wireLabel')!,
  isolate: document.getElementById('isolate') as HTMLInputElement,
  btnSweep: document.getElementById('btnSweep') as HTMLButtonElement,
  targetMode: document.getElementById('targetMode')!,
};

function fmt(n: number, d = 6): string {
  return n.toFixed(d);
}
function hexCss(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function requestedConstruction(): ConstructionKind {
  const cut = new URLSearchParams(window.location.search).get('cut');
  if (cut === '22' || cut === 'to22') return 'to22';
  if (cut === 'rd' || cut === 'rd32' || cut === '32') return 'rd32';
  return 'to11';
}

function kitTheobald(): Kit {
  const build = buildTheobald11();
  return {
    kind: 'to11',
    title: 'Cube ↔ Truncated Octahedron',
    targetShort: 'Trunc. oct.',
    pieces: build.pieces,
    totalVolume: build.totalVolume,
    cubeWireQuaternion: build.cubeWireQuaternion,
    targetVertices: build.targetVertices,
    translational: true,
    volumesHtml: `
      <div>V<sub>cube</sub> = V<sub>TO</sub> = 1</div>
      <hr/>
      <div><b>${build.pieces.length} pieces</b> · translational only</div>
      <div>Σ digitized vol = ${fmt(build.totalVolume, 6)}</div>
      <div>Min piece vol = ${fmt(Math.min(...build.pieces.map((p) => p.volume)), 6)}</div>
    `,
    howHtml: `
      Gavin Theobald’s 11-piece cube ↔ truncated octahedron cut.
      Each piece is a convex solid; cube and target poses differ by
      <b style="color:var(--text)">translation only</b> (no piece rotation).
    `,
    verdictHtml: `
      <strong>11-piece translational cut</strong><br/>
      <span class="ok">Same rigid pieces</span> assemble the cube and the truncated octahedron.<br/>
      <span class="ok">Translations only</span> between assemblies · closure ≈ 2×10<sup>−4</sup>.
    `,
  };
}

function kitLattice(): Kit {
  const build = buildLattice22();
  return {
    kind: 'to22',
    title: 'Cube ↔ Truncated Octahedron',
    targetShort: 'Trunc. oct.',
    pieces: build.pieces,
    totalVolume: build.totalVolume,
    cubeWireQuaternion: build.cubeWireQuaternion,
    targetVertices: build.targetVertices,
    translational: false,
    volumesHtml: `
      <div>V<sub>cube</sub> = V<sub>TO</sub> = 1</div>
      <hr/>
      <div><b>${build.pieces.length} pieces</b> · lattice cut</div>
      <div>Σ piece vol = ${fmt(build.totalVolume, 6)}</div>
      <div>Min piece vol = ${fmt(Math.min(...build.pieces.map((p) => p.volume)), 6)}</div>
    `,
    howHtml: `
      Exact 22-piece lattice dissection of a unit cube and a volume-1 truncated
      octahedron. Motions are rigid (rotations and translations).
    `,
    verdictHtml: `
      <strong>22-piece lattice cut</strong><br/>
      <span class="ok">Cube is exact</span> — pieces tile the unit cube.<br/>
      <span class="ok">Truncated octahedron is exact</span> — same pieces, rigid motions.
    `,
  };
}

function kitRhombic(): Kit {
  const build = buildRhombicPieces();
  const nCore = build.pieces.filter((p) => p.role === 'core').length;
  const nPyr = build.pieces.filter((p) => p.role === 'pyramid').length;
  return {
    kind: 'rd32',
    title: 'Cube ↔ Rhombic Dodecahedron',
    targetShort: 'Rhombic dodeca',
    pieces: build.pieces.map((p) => ({
      id: p.id,
      label: p.label,
      role: p.role,
      geometry: p.geometry,
      volume: p.volume,
      color: p.color,
      cubeSlot: p.cubeSlot,
      targetSlot: p.rdSlot,
      cubeMatrix: p.cubeMatrix,
      targetMatrix: p.rdMatrix,
      axis: p.axis,
    })),
    totalVolume: build.totalVolume,
    cubeWireQuaternion: new Quaternion(),
    targetVertices: build.rdVertices,
    translational: false,
    volumesHtml: `
      <div><b>σ</b> = 2<sup>−1/3</sup> = ${fmt(SIGMA)}</div>
      <div>V<sub>cube</sub> = V<sub>RD</sub> = 1</div>
      <hr/>
      <div><b>${build.pieces.length} pieces</b> · ${nCore} core + ${nPyr} pyramid fragments</div>
      <div>Σ piece vol = ${fmt(build.totalVolume, 6)}</div>
      <div>Min piece vol = ${fmt(Math.min(...build.pieces.map((p) => p.volume)), 6)}</div>
    `,
    howHtml: `
      Exact 32-piece strip-slide construction. RD (volume 1) = core cube of side
      σ = 2<sup>−1/3</sup> + 6 pyramids on its faces, and those pyramids tile a
      second σ-cube. Unit cube → box σ×σ×2σ by two strip-slide dissections,
      bottom σ-cube = RD core, top σ-cube = the 6 pyramids.
    `,
    verdictHtml: `
      <strong>Requirement check</strong><br/>
      <span class="ok">Cube is exact</span> — pieces tile the unit cube.<br/>
      <span class="ok">RD is exact</span> — same pieces tile the rhombic dodecahedron.<br/>
      <span class="ok">All cuts planar, all motions rigid</span> — 3D-printable, no morphing.
    `,
  };
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x0c1018, 1);

const scene = new Scene();
const camera = new PerspectiveCamera(42, 1, 0.01, 100);
camera.position.set(2.4, 1.9, 2.6);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

scene.add(new AmbientLight(0x405060, 1.15));
const sun = new DirectionalLight(0xffffff, 1.35);
sun.position.set(4, 6, 3);
scene.add(sun);
const fill = new DirectionalLight(0x88aacc, 0.45);
fill.position.set(-3, -2, -4);
scene.add(fill);

const root = new Group();
scene.add(root);
const wireGroup = new Group();
root.add(wireGroup);
const meshGroup = new Group();
root.add(meshGroup);

const previewRenderer = new WebGLRenderer({ canvas: el.preview, antialias: true, alpha: true });
previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
previewRenderer.setClearColor(0x0a0e14, 1);
const previewScene = new Scene();
const previewCamera = new PerspectiveCamera(35, 1, 0.01, 50);
previewCamera.position.set(1.4, 1.1, 1.4);
previewScene.add(new AmbientLight(0x506070, 1.2));
const pSun = new DirectionalLight(0xffffff, 1.3);
pSun.position.set(2, 3, 2);
previewScene.add(pSun);
const previewPivot = new Group();
previewScene.add(previewPivot);
let previewMesh: Mesh | null = null;

let kit: Kit | null = null;
let mode: Mode = 'cube';
let pieceMeshes: { piece: DissectionPiece; mesh: Mesh; baseOpacity: number }[] = [];
let selectedId: string | null = null;
let sweepPlaying = false;
let sweepDirection = 1;
let sweepLastMs = 0;
const SWEEP_MS = 5000;
let wireCube: LineSegments | null = null;
let wireTarget: LineSegments | null = null;
const kits: Partial<Record<ConstructionKind, Kit>> = {};

function mat(color: number, opacity = 1): MeshPhongMaterial {
  return new MeshPhongMaterial({
    color,
    transparent: opacity < 0.99,
    opacity,
    side: DoubleSide,
    shininess: 70,
    specular: new Color(0x223344),
    depthWrite: opacity > 0.8,
  });
}

function poseT(): number {
  if (mode === 'cube') return 0;
  if (mode === 'target') return 1;
  return Number(el.morph.value);
}

function explodeOffsetFor(piece: DissectionPiece, t: number): Vector3 {
  if (!el.explode.checked) return new Vector3(0, 0, 0);
  const m = blendMatrix(piece.cubeMatrix, piece.targetMatrix, t);
  const e = m.elements;
  const pos = new Vector3(e[12], e[13], e[14]);
  const dir = pos.lengthSq() > 1e-8 ? pos : piece.axis.clone();
  return dir.normalize().multiplyScalar(0.35);
}

function updateTransforms() {
  if (!kit) return;
  const t = poseT();
  if (wireCube) wireCube.visible = el.showWire.checked && t < 0.85;
  if (wireTarget) wireTarget.visible = el.showWire.checked && t > 0.15;
  wireGroup.visible = el.showWire.checked;

  if (mode === 'cube') el.modeBadge.textContent = 'Cube — exact assembly';
  else if (mode === 'target')
    el.modeBadge.textContent = `${kit.targetShort} — exact assembly`;
  else
    el.modeBadge.textContent = `Blend ${(t * 100).toFixed(0)}% → ${kit.targetShort} · ${pieceMeshes.length} pieces`;

  const isolate = el.isolate.checked && selectedId != null;

  for (const { piece, mesh, baseOpacity } of pieceMeshes) {
    const isSel = piece.id === selectedId;
    mesh.visible = !isolate || isSel;
    const material = mesh.material as MeshPhongMaterial;
    if (selectedId && !isSel && !isolate) {
      material.opacity = 0.12;
      material.transparent = true;
      material.depthWrite = false;
    } else {
      material.opacity = isSel ? 1 : baseOpacity;
      material.transparent = material.opacity < 0.99;
      material.depthWrite = material.opacity > 0.8;
    }

    const blended = blendMatrix(piece.cubeMatrix, piece.targetMatrix, t);
    const explode = explodeOffsetFor(piece, t);
    mesh.matrixAutoUpdate = false;
    mesh.matrix
      .makeTranslation(explode.x, explode.y, explode.z)
      .multiply(blended);
  }

  document.querySelectorAll('.piece-card').forEach((card) => {
    card.classList.toggle('selected', card.getAttribute('data-id') === selectedId);
  });
}

function setMode(m: Mode) {
  mode = m;
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === m);
  });
  if (m === 'cube') el.morph.value = '0';
  if (m === 'target') el.morph.value = '1';
  updateTransforms();
}

function setSweepPlaying(on: boolean) {
  sweepPlaying = on;
  el.btnSweep.textContent = on ? '■ Stop' : '▶ Sweep';
  el.btnSweep.classList.toggle('active', on);
  if (on) {
    el.explode.checked = false;
    el.isolate.checked = false;
    selectedId = null;
    mode = 'both';
    document.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === 'both');
    });
    sweepDirection = Number(el.morph.value) >= 0.99 ? -1 : 1;
    sweepLastMs = performance.now();
    renderSelectedDetail(null);
    updateTransforms();
  }
}

function tickSweep(now: number) {
  if (!sweepPlaying) return;
  const dt = Math.min(64, now - sweepLastMs);
  sweepLastMs = now;
  let t = Number(el.morph.value);
  t += sweepDirection * (dt / SWEEP_MS);
  if (t >= 1) {
    t = 1;
    sweepDirection = -1;
  } else if (t <= 0) {
    t = 0;
    sweepDirection = 1;
  }
  el.morph.value = String(t);
  mode = 'both';
  updateTransforms();
}

function selectPiece(id: string | null) {
  selectedId = id;
  renderSelectedDetail(kit?.pieces.find((p) => p.id === id) ?? null);
  updateTransforms();
}

function renderSelectedDetail(piece: DissectionPiece | null) {
  if (previewMesh) {
    previewPivot.remove(previewMesh);
    previewMesh.geometry.dispose();
    (previewMesh.material as MeshPhongMaterial).dispose();
    previewMesh = null;
  }
  if (!piece || !kit) {
    el.previewWrap.hidden = true;
    el.selectedDetail.innerHTML = `
      <div style="font-weight:600">Select a piece</div>
      <div class="muted">Each piece is present in cube and ${kit?.targetShort ?? 'target'}.</div>`;
    el.selectedDetail.appendChild(el.previewWrap);
    return;
  }
  el.previewWrap.hidden = false;
  el.selectedDetail.innerHTML = `
    <div style="display:flex;align-items:center;gap:0.4rem;font-weight:600">
      <span style="width:12px;height:12px;border-radius:2px;background:${hexCss(piece.color)}"></span>
      ${piece.label}
      <span class="badge exact">exact</span>
    </div>
    <div class="slots">
      <div class="tag">Cube</div><div>${piece.cubeSlot}</div>
      <div class="tag">Target</div><div>${piece.targetSlot}</div>
      <div class="tag">Vol</div><div>${fmt(piece.volume, 5)}</div>
    </div>`;
  el.selectedDetail.appendChild(el.previewWrap);

  const geo = piece.geometry.clone();
  previewMesh = new Mesh(geo, mat(piece.color, 0.95));
  previewMesh.add(
    new LineSegments(
      new EdgesGeometry(geo, 20),
      new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2 }),
    ),
  );
  geo.computeBoundingSphere();
  const c = geo.boundingSphere?.center.clone() ?? new Vector3();
  const r = geo.boundingSphere?.radius ?? 1;
  previewMesh.position.sub(c);
  previewPivot.clear();
  previewPivot.add(previewMesh);
  previewCamera.position.set(r * 2.4, r * 1.8, r * 2.4);
  previewCamera.lookAt(0, 0, 0);
}

function buildPieceMatrix(all: DissectionPiece[]) {
  el.pieceMatrix.innerHTML = '';
  for (const piece of all) {
    const card = document.createElement('div');
    card.className = 'piece-card';
    card.setAttribute('data-id', piece.id);
    card.innerHTML = `
      <div class="swatch" style="background:${hexCss(piece.color)}"></div>
      <div>
        <div class="name">${piece.label}</div>
        <div class="slots">
          <div class="tag">Cube</div><div>${piece.cubeSlot}</div>
          <div class="tag">Target</div><div>${piece.targetSlot}</div>
        </div>
      </div>`;
    card.addEventListener('click', () => selectPiece(piece.id));
    el.pieceMatrix.appendChild(card);
  }
}

function clearMeshes() {
  for (const { mesh } of pieceMeshes) {
    meshGroup.remove(mesh);
    for (const child of [...mesh.children]) {
      mesh.remove(child);
      if (child instanceof LineSegments) {
        child.geometry.dispose();
        (child.material as LineBasicMaterial).dispose();
      }
    }
    (mesh.material as MeshPhongMaterial).dispose();
  }
  pieceMeshes = [];
  if (wireCube) {
    wireGroup.remove(wireCube);
    wireCube.geometry.dispose();
    (wireCube.material as LineBasicMaterial).dispose();
    wireCube = null;
  }
  if (wireTarget) {
    wireGroup.remove(wireTarget);
    wireTarget.geometry.dispose();
    (wireTarget.material as LineBasicMaterial).dispose();
    wireTarget = null;
  }
}

function getKit(kind: ConstructionKind): Kit {
  const cached = kits[kind];
  if (cached) return cached;
  el.status.textContent = kind === 'to22' ? 'Building 22-piece lattice…' : 'Building dissection…';
  const next =
    kind === 'to11' ? kitTheobald() : kind === 'to22' ? kitLattice() : kitRhombic();
  kits[kind] = next;
  return next;
}

function applyKit(kind: ConstructionKind) {
  setSweepPlaying(false);
  selectedId = null;
  kit = getKit(kind);
  document.title = kit.title;
  el.title.textContent = kit.title;
  el.lead.innerHTML = kit.translational
    ? `The same rigid pieces assemble a unit cube <i>and</i> an equal-volume truncated octahedron. Piece motions between assemblies are translations only.`
    : `An <b style="color:var(--text)">exact</b> dissection: the same rigid pieces assemble a unit cube <i>and</i> an equal-volume ${kit.kind === 'rd32' ? 'rhombic dodecahedron' : 'truncated octahedron'}. All motions are rigid (translations + rotations).`;
  el.targetMode.textContent = kit.targetShort;
  el.morphLabel.textContent = `Pose: cube → ${kit.targetShort.toLowerCase()} (same meshes)`;
  el.wireLabel.textContent = `Cube / ${kit.kind === 'rd32' ? 'RD' : 'TO'} wire`;
  el.how.innerHTML = kit.howHtml;
  el.verdict.innerHTML = kit.verdictHtml;
  el.volumes.innerHTML = kit.volumesHtml;

  document.querySelectorAll('[data-cut]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-cut') === kind);
  });

  clearMeshes();
  wireCube = new LineSegments(
    new EdgesGeometry(new BoxGeometry(1, 1, 1)),
    new LineBasicMaterial({ color: 0x7ab8e0, transparent: true, opacity: 0.4 }),
  );
  wireCube.quaternion.copy(kit.cubeWireQuaternion);
  const hull = finalizeHull(kit.targetVertices);
  wireTarget = new LineSegments(
    new EdgesGeometry(hull, 5),
    new LineBasicMaterial({ color: 0xe0a878, transparent: true, opacity: 0.4 }),
  );
  wireGroup.add(wireCube, wireTarget);

  for (const piece of kit.pieces) {
    const mesh = new Mesh(piece.geometry, mat(piece.color, 0.92));
    mesh.add(
      new LineSegments(
        new EdgesGeometry(piece.geometry, 22),
        new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1 }),
      ),
    );
    meshGroup.add(mesh);
    pieceMeshes.push({ piece, mesh, baseOpacity: 0.92 });
  }

  el.pieceHeading.textContent = `All ${kit.pieces.length} pieces`;
  buildPieceMatrix(kit.pieces);
  selectPiece(null);
  setMode('cube');
  el.status.textContent = `Ready · ${kit.pieces.length} pieces · cube ↔ ${kit.targetShort}`;
}

document.querySelectorAll('[data-cut]').forEach((btn) => {
  btn.addEventListener('click', () => {
    applyKit(btn.getAttribute('data-cut') as ConstructionKind);
  });
});
document.querySelectorAll('[data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    setSweepPlaying(false);
    setMode(btn.getAttribute('data-mode') as Mode);
  });
});
el.morph.addEventListener('input', () => {
  setSweepPlaying(false);
  mode = 'both';
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === 'both');
  });
  updateTransforms();
});
el.btnSweep.addEventListener('click', () => setSweepPlaying(!sweepPlaying));
for (const id of ['explode', 'showWire', 'isolate'] as const) {
  el[id].addEventListener('change', updateTransforms);
}

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
  const pw = el.preview.clientWidth;
  const ph = el.preview.clientHeight;
  if (pw > 0 && ph > 0) {
    previewRenderer.setSize(pw, ph, false);
    previewCamera.aspect = pw / ph;
    previewCamera.updateProjectionMatrix();
  }
}
window.addEventListener('resize', resize);
resize();

function frame(now: number) {
  tickSweep(now);
  controls.update();
  if (previewMesh) previewPivot.rotation.y += 0.008;
  renderer.render(scene, camera);
  previewRenderer.render(previewScene, previewCamera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

try {
  applyKit(requestedConstruction());
} catch (err) {
  console.error(err);
  el.status.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
}
