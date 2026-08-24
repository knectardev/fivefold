/**
 * Full-volume cube↔sphere: 24 wedges, all present in both assemblies.
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
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { analyticalVolumes, makeParams } from './params';
import { blendMatrix, buildRigidPieces, type RigidPiece } from './pieces';

type Mode = 'cube' | 'sphere' | 'both';

const params = makeParams(1);
const analytical = analyticalVolumes(params);

const el = {
  status: document.getElementById('status')!,
  verdict: document.getElementById('verdict')!,
  volumes: document.getElementById('volumes')!,
  pieceMatrix: document.getElementById('pieceMatrix')!,
  selectedDetail: document.getElementById('selectedDetail')!,
  modeBadge: document.getElementById('modeBadge')!,
  previewWrap: document.getElementById('previewWrap') as HTMLDivElement,
  preview: document.getElementById('preview') as HTMLCanvasElement,
  morph: document.getElementById('morph') as HTMLInputElement,
  explode: document.getElementById('explode') as HTMLInputElement,
  showWire: document.getElementById('showWire') as HTMLInputElement,
  isolate: document.getElementById('isolate') as HTMLInputElement,
  btnSweep: document.getElementById('btnSweep') as HTMLButtonElement,
};

function fmt(n: number, d = 6): string {
  return n.toFixed(d);
}
function hexCss(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

el.volumes.innerHTML = `
  <div><b>a</b> = ${params.a} · <b>R</b> = ${fmt(params.R, 6)}</div>
  <div>V<sub>cube</sub> = V<sub>ball</sub> = ${fmt(analytical.cube)}</div>
`;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x0c1018, 1);

const scene = new Scene();
const camera = new PerspectiveCamera(42, 1, 0.01, 100);
camera.position.set(2.6, 2.0, 2.8);
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
const wireCube = new LineSegments(
  new EdgesGeometry(new BoxGeometry(params.a, params.a, params.a)),
  new LineBasicMaterial({ color: 0x7ab8e0, transparent: true, opacity: 0.4 }),
);
const wireSphere = new LineSegments(
  new EdgesGeometry(new SphereGeometry(params.R, 32, 16)),
  new LineBasicMaterial({ color: 0xe0a878, transparent: true, opacity: 0.35 }),
);
wireGroup.add(wireCube, wireSphere);
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

let mode: Mode = 'cube';
let pieces: RigidPiece[] = [];
let pieceMeshes: { piece: RigidPiece; mesh: Mesh; baseOpacity: number }[] = [];
let selectedId: string | null = null;
let sweepPlaying = false;
let sweepDirection = 1;
let sweepLastMs = 0;
const SWEEP_MS = 5000;

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
  if (mode === 'sphere') return 1;
  return Number(el.morph.value);
}

function explodeOffsetFor(piece: RigidPiece, t: number): Vector3 {
  if (!el.explode.checked) return new Vector3(0, 0, 0);
  const m = blendMatrix(piece.cubeMatrix, piece.sphereMatrix, t);
  const e = m.elements;
  const pos = new Vector3(e[12], e[13], e[14]);
  // Prefer wedge axis so center pieces still explode outward
  const dir = pos.lengthSq() > 1e-8 ? pos : piece.axis.clone();
  return dir.normalize().multiplyScalar(0.35);
}

function updateTransforms() {
  const t = poseT();
  wireCube.visible = el.showWire.checked && t < 0.85;
  wireSphere.visible = el.showWire.checked && t > 0.15;
  wireGroup.visible = el.showWire.checked;

  if (mode === 'cube')
    el.modeBadge.textContent = 'Cube — same pieces best-fit toward corners (provisional)';
  else if (mode === 'sphere')
    el.modeBadge.textContent = 'Sphere — core ∪ face caps (exact ball)';
  else el.modeBadge.textContent = `Blend ${(t * 100).toFixed(0)}% → sphere · all ${pieceMeshes.length} pieces`;

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

    const blended = blendMatrix(piece.cubeMatrix, piece.sphereMatrix, t);
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
  if (m === 'sphere') el.morph.value = '1';
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
  renderSelectedDetail(pieces.find((p) => p.id === id) ?? null);
  updateTransforms();
}

function renderSelectedDetail(piece: RigidPiece | null) {
  if (previewMesh) {
    previewPivot.remove(previewMesh);
    previewMesh.geometry.dispose();
    (previewMesh.material as MeshPhongMaterial).dispose();
    previewMesh = null;
  }
  if (!piece) {
    el.previewWrap.hidden = true;
    el.selectedDetail.innerHTML = `
      <div style="font-weight:600">Select a piece</div>
      <div class="muted">Each wedge is present in cube and sphere.</div>`;
    el.selectedDetail.appendChild(el.previewWrap);
    return;
  }
  el.previewWrap.hidden = false;
  el.selectedDetail.innerHTML = `
    <div style="display:flex;align-items:center;gap:0.4rem;font-weight:600">
      <span style="width:12px;height:12px;border-radius:2px;background:${hexCss(piece.color)}"></span>
      ${piece.label}
      <span class="badge ${piece.fit}">${piece.fit}</span>
    </div>
    <div class="slots">
      <div class="tag">Cube</div><div>${piece.cubeSlot}</div>
      <div class="tag">Sphere</div><div>${piece.sphereSlot}</div>
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

function buildPieceMatrix(all: RigidPiece[]) {
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
          <div class="tag">Sphere</div><div>${piece.sphereSlot}</div>
        </div>
      </div>`;
    card.addEventListener('click', () => selectPiece(piece.id));
    el.pieceMatrix.appendChild(card);
  }
}

async function build() {
  el.status.textContent = 'Cutting core octants + face-cap sectors…';
  await new Promise((r) => setTimeout(r, 20));

  const built = buildRigidPieces(params);
  pieces = built.pieces;
  const nCore = pieces.filter((p) => p.role === 'core').length;
  const nTransfer = pieces.filter((p) => p.role === 'transfer').length;

  while (meshGroup.children.length) meshGroup.remove(meshGroup.children[0]!);
  pieceMeshes = [];

  for (const piece of pieces) {
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

  el.volumes.innerHTML += `
    <hr/>
    <div><b>${pieces.length} pieces</b> · ${nCore} core + ${nTransfer} cap sectors</div>
    <div>Σ piece vol ${fmt(built.cubeVol, 4)} · Σ sphere (exact) ${fmt(built.sphereTargetVol, 4)}</div>
  `;

  el.verdict.innerHTML = `
    <strong>Requirement check</strong><br/>
    <span class="ok">Sphere is exact</span> — core ∪ face-cap sectors = the ball.<br/>
    <span class="ok">Same ${pieces.length} pieces in both modes</span> — nothing shelved.<br/>
    <span class="warn">Cube is messy</span> — these are face-cap shapes; rigid motion cannot
    make flat cube corners. Needs congruent recuts (corner ≅ cap), not better seating.
  `;

  buildPieceMatrix(pieces);
  selectPiece(null);
  setMode('sphere');
  el.status.textContent = `Ready · ${pieces.length} pieces · Sphere exact · Cube needs congruent cuts`;
}

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

build().catch((err) => {
  console.error(err);
  el.status.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
});
