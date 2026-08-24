import {
  AmbientLight,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ShapeConfig, UnitSolid } from './types';

export class UniquenessScene {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;

  private readonly root = new Group();
  private readonly solidMat: MeshStandardMaterial;
  private readonly edgeMat: LineBasicMaterial;
  private animating = false;

  constructor(canvasHost: HTMLElement) {
    this.scene = new Scene();
    this.scene.background = new Color(0xb8b8b8);

    const w = canvasHost.clientWidth || 640;
    const h = canvasHost.clientHeight || 400;
    this.camera = new PerspectiveCamera(45, w / h, 0.1, 500);
    this.camera.position.set(8, -10, 8);
    this.camera.up.set(0, 0, 1);

    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    canvasHost.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(1.5, 1, 1);

    this.scene.add(new AmbientLight(0xffffff, 0.55));
    const key = new DirectionalLight(0xffffff, 0.85);
    key.position.set(5, -8, 12);
    this.scene.add(key);
    const fill = new DirectionalLight(0xffffff, 0.25);
    fill.position.set(-6, 4, 4);
    this.scene.add(fill);

    const grid = new GridHelper(20, 20, 0x888888, 0xa0a0a0);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);

    this.solidMat = new MeshStandardMaterial({
      color: 0xc8c8c8,
      metalness: 0.05,
      roughness: 0.65,
      side: DoubleSide,
    });
    this.edgeMat = new LineBasicMaterial({ color: 0x222222 });

    this.scene.add(this.root);

    const onResize = () => {
      const nw = canvasHost.clientWidth || 640;
      const nh = canvasHost.clientHeight || 400;
      this.camera.aspect = nw / nh;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(nw, nh);
    };
    window.addEventListener('resize', onResize);

    this.animating = true;
    const tick = () => {
      if (!this.animating) return;
      requestAnimationFrame(tick);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  setConfig(config: ShapeConfig, unit: UnitSolid): void {
    while (this.root.children.length > 0) {
      const child = this.root.children[0]!;
      this.root.remove(child);
      child.traverse((obj) => {
        if (obj instanceof Mesh || obj instanceof LineSegments) {
          obj.geometry.dispose();
        }
      });
    }

    for (const inst of config.instances) {
      const geom = buildUnitGeometry(unit);
      geom.applyMatrix4(inst.transform);
      const mesh = new Mesh(geom, this.solidMat);
      const edges = new LineSegments(new EdgesGeometry(geom), this.edgeMat);
      this.root.add(mesh);
      this.root.add(edges);
    }

    this.frameContent();
  }

  private frameContent(): void {
    // Simple framing around the unit-scale assemblies
    this.controls.target.set(1.5, 1, 1);
    this.camera.position.set(9, -11, 7);
    this.controls.update();
  }

  dispose(): void {
    this.animating = false;
    this.renderer.dispose();
  }
}

function buildUnitGeometry(unit: UnitSolid): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const [x, y, z] of unit.vertices) {
    positions.push(x, y, z);
  }
  for (const [a, b, c] of unit.faces) {
    indices.push(a, b, c);
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}
