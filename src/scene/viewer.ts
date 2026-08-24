import {
  AmbientLight,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  BoxGeometry,
  SphereGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  ArrowHelper,
  Vector3,
  Shape,
  ShapeGeometry,
  MeshBasicMaterial,
  Raycaster,
  Plane,
  Vector2,
  Float32BufferAttribute,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { DesignParams, Skeleton } from '../model/types';
import { partPlaneRadius, snapAngle } from '../model/types';
import { computeHalfPoses, isPartVisible, partWorldFrame } from '../model/fk';
import {
  buildAllPartHalves,
  type PartHalvesGeometry,
} from '../geom/hull';
import { partColorHex } from '../model/partColors';
import {
  evaluatePlaneCompliance,
  complianceSummary,
  type PlaneComplianceResult,
} from '../geom/planeCompliance';
import { clippedRotationalPlanePolygon } from '../geom/planeFootprint';
import { computePartIntersectionPlanes } from '../geom/partIntersections';
import { tetrahedronVertices, tetrahedronStruts } from '../geom/convexClip';
import { strutGuideRadius } from '../model/strutGuide';

export class Viewer {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;

  private readonly partsGroup = new Group();
  private readonly proxyGroup = new Group();
  private readonly axesGroup = new Group();
  private readonly planeGroup = new Group();
  private readonly envelopeGroup = new Group();
  private readonly boundsGroup = new Group();
  private readonly strutGuideGroup = new Group();
  private readonly intersectionGroup = new Group();

  private halfMeshes: { a: Mesh; b: Mesh }[] = [];
  private proxyMeshes: LineSegments[] = [];
  /** Merged rest-pose part solids for STL export. */
  private partGeometries: BufferGeometry[] = [];
  private boundsLines: LineSegments | null = null;
  private boundsShell: Mesh | null = null;
  private strutGuideLines: LineSegments | null = null;
  private intersectionMeshes: Mesh[] = [];
  private intersectionEdges: LineSegments[] = [];
  private intersectionDirty = false;
  /** Set when an intersection refresh was skipped during rebuild. */
  private intersectionRefreshPending = false;
  private rebuilding = false;
  private lastPoseSkeleton: Skeleton | null = null;
  private lastPoseParams: DesignParams | null = null;

  private dragParams: DesignParams | null = null;
  private dragSkeleton: Skeleton | null = null;
  private onPartMoved: ((index: number) => void) | null = null;
  private onPartRotated: ((index: number) => void) | null = null;
  private onPartSelected: ((index: number) => void) | null = null;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly dragPlane = new Plane();
  private readonly dragHit = new Vector3();
  private readonly dragOffset = new Vector3();
  private draggingPart: number | null = null;
  private dragMoved = false;
  private dragMode: 'translate' | 'rotate' | null = null;
  private dragHalf: 'A' | 'B' = 'B';
  private readonly dragStart = new Vector3();
  private dragAngleStart = 0;
  private readonly dragRotAxis = new Vector3();
  private readonly dragRotOrigin = new Vector3();
  private readonly dragRotStartDir = new Vector3();
  private readonly dragRotTmp = new Vector3();
  private readonly dragRotCross = new Vector3();
  private lastCompliance: PlaneComplianceResult[] = [];

  constructor(container: HTMLElement) {
    this.scene = new Scene();
    this.scene.background = new Color(0x1a1d23);

    this.camera = new PerspectiveCamera(
      50,
      container.clientWidth / Math.max(container.clientHeight, 1),
      0.1,
      200,
    );
    this.camera.position.set(6, 4, 8);

    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new AmbientLight(0xffffff, 0.45));
    const key = new DirectionalLight(0xffffff, 1.1);
    key.position.set(5, 8, 4);
    this.scene.add(key);
    const fill = new DirectionalLight(0xa8c0ff, 0.35);
    fill.position.set(-4, 2, -3);
    this.scene.add(fill);

    const grid = new GridHelper(20, 20, 0x3a4050, 0x2a2e38);
    grid.position.y = -3;
    this.scene.add(grid);

    this.scene.add(this.partsGroup);
    this.scene.add(this.proxyGroup);
    this.scene.add(this.axesGroup);
    this.scene.add(this.planeGroup);
    this.scene.add(this.envelopeGroup);
    this.scene.add(this.boundsGroup);
    this.scene.add(this.strutGuideGroup);
    this.scene.add(this.intersectionGroup);

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('resize', this.onResize);
    this.animate();
  }

  /**
   * Enable click-drag repositioning of parts in the viewport.
   * Plain drag: translate. Ctrl+drag: rotate about the part's symmetry axis.
   * Updates params while dragging; fires callbacks for UI sync.
   */
  enablePartDragging(
    getParams: () => DesignParams,
    getSkeleton: () => Skeleton,
    handlers: {
      onPartMoved: (index: number) => void;
      onPartRotated?: (index: number) => void;
      onPartSelected?: (index: number) => void;
    },
  ): void {
    this.dragParams = null;
    this._getDragParams = getParams;
    this._getDragSkeleton = getSkeleton;
    this.onPartMoved = handlers.onPartMoved;
    this.onPartRotated = handlers.onPartRotated ?? null;
    this.onPartSelected = handlers.onPartSelected ?? null;
  }

  private _getDragParams: (() => DesignParams) | null = null;
  private _getDragSkeleton: (() => Skeleton) | null = null;

  private pickPartHit(
    params: DesignParams,
  ): { partIndex: number; half: 'A' | 'B' } | null {
    const meshes = params.showSolids
      ? this.halfMeshes.flatMap((p, i) => {
          p.a.userData.partIndex = i;
          p.a.userData.half = 'A';
          p.b.userData.partIndex = i;
          p.b.userData.half = 'B';
          return [p.a, p.b];
        })
      : this.proxyMeshes.map((m, i) => {
          m.userData.partIndex = Math.floor(i / 2);
          m.userData.half = i % 2 === 0 ? 'A' : 'B';
          return m;
        });
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const partIndex = hits[0].object.userData.partIndex as number;
    const half = hits[0].object.userData.half === 'A' ? 'A' : 'B';
    if (!Number.isFinite(partIndex)) return null;
    return { partIndex, half };
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const params = this._getDragParams?.();
    const skeleton = this._getDragSkeleton?.();
    if (!params || !skeleton) return;
    if (params.layoutMode === 'chain') return;

    this.updatePointer(event);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.pickPartHit(params);
    if (!hit) return;

    const { partIndex, half } = hit;
    const part = params.parts[partIndex];
    if (!part) return;
    if (typeof part.angleA !== 'number') part.angleA = 0;

    this.draggingPart = partIndex;
    this.dragHalf = half;
    this.dragMoved = false;
    this.dragParams = params;
    this.dragSkeleton = skeleton;
    this.dragStart.set(part.posX, part.posY, part.posZ);
    params.activePart = partIndex;
    this.onPartSelected?.(partIndex);

    const rotate = event.ctrlKey;
    this.dragMode = rotate ? 'rotate' : 'translate';

    if (rotate) {
      const frame = partWorldFrame(skeleton, params, partIndex);
      this.dragRotOrigin.copy(frame.origin);
      this.dragRotAxis.copy(frame.axis).normalize();
      this.dragAngleStart = half === 'A' ? part.angleA : part.angle;
      this.dragPlane.setFromNormalAndCoplanarPoint(
        this.dragRotAxis,
        this.dragRotOrigin,
      );
      if (
        !this.raycaster.ray.intersectPlane(this.dragPlane, this.dragHit)
      ) {
        this.draggingPart = null;
        this.dragMode = null;
        return;
      }
      this.dragRotStartDir
        .copy(this.dragHit)
        .sub(this.dragRotOrigin);
      if (this.dragRotStartDir.lengthSq() < 1e-8) {
        const fallback =
          Math.abs(this.dragRotAxis.y) < 0.9
            ? new Vector3(0, 1, 0)
            : new Vector3(1, 0, 0);
        this.dragRotStartDir
          .crossVectors(this.dragRotAxis, fallback)
          .normalize();
      } else {
        this.dragRotStartDir.normalize();
      }
    } else {
      const origin = this.dragStart.clone();
      const normal = new Vector3()
        .subVectors(this.camera.position, origin)
        .normalize();
      this.dragPlane.setFromNormalAndCoplanarPoint(normal, origin);
      if (!this.raycaster.ray.intersectPlane(this.dragPlane, this.dragHit)) {
        this.draggingPart = null;
        this.dragMode = null;
        return;
      }
      this.dragOffset.copy(origin).sub(this.dragHit);
    }

    this.controls.enabled = false;
    this.renderer.domElement.style.cursor = rotate ? 'ew-resize' : 'grabbing';
    event.preventDefault();
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.draggingPart === null || !this.dragParams || !this.dragMode) {
      return;
    }
    this.updatePointer(event);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, this.dragHit)) {
      return;
    }

    const part = this.dragParams.parts[this.draggingPart];
    if (!part) return;

    if (this.dragMode === 'rotate') {
      this.dragRotTmp.copy(this.dragHit).sub(this.dragRotOrigin);
      if (this.dragRotTmp.lengthSq() < 1e-10) return;
      this.dragRotTmp.normalize();
      this.dragRotCross.crossVectors(this.dragRotStartDir, this.dragRotTmp);
      const sin = this.dragRotAxis.dot(this.dragRotCross);
      const cos = this.dragRotStartDir.dot(this.dragRotTmp);
      const deltaDeg = (Math.atan2(sin, cos) * 180) / Math.PI;
      const next = this.dragAngleStart + deltaDeg;
      if (this.dragHalf === 'A') part.angleA = next;
      else part.angle = next;
      this.dragMoved = true;
      const skeleton =
        this._getDragSkeleton?.() ?? this.dragSkeleton;
      if (skeleton) {
        const wasSnap = this.dragParams.snapPreview;
        this.dragParams.snapPreview = false;
        this.applyPoses(skeleton, this.dragParams);
        this.dragParams.snapPreview = wasSnap;
      }
      return;
    }

    const next = this.dragHit.clone().add(this.dragOffset);
    part.posX = next.x;
    part.posY = next.y;
    part.posZ = next.z;
    this.dragMoved = true;
    this.previewDragTranslation(this.draggingPart, this.dragParams);
  };

  /** Slide rest-pose meshes by delta while dragging (full rebuild on release). */
  private previewDragTranslation(
    partIndex: number,
    params: DesignParams,
  ): void {
    const skeleton = this._getDragSkeleton?.() ?? this.dragSkeleton;
    if (!skeleton) return;
    const poses = computeHalfPoses(skeleton, params);
    const pose = poses[partIndex];
    if (!pose || !this.halfMeshes[partIndex]) return;

    const part = params.parts[partIndex];
    const delta = new Vector3(
      part.posX - this.dragStart.x,
      part.posY - this.dragStart.y,
      part.posZ - this.dragStart.z,
    );
    const T = new Matrix4().makeTranslation(delta.x, delta.y, delta.z);
    const { a, b } = this.halfMeshes[partIndex];
    a.matrixAutoUpdate = false;
    b.matrixAutoUpdate = false;
    a.matrix.copy(T).multiply(pose.halfA.matrix);
    b.matrix.copy(T).multiply(pose.halfB.matrix);
    a.updateMatrixWorld(true);
    b.updateMatrixWorld(true);

    if (this.proxyMeshes[partIndex * 2]) {
      this.proxyMeshes[partIndex * 2].matrixAutoUpdate = false;
      this.proxyMeshes[partIndex * 2].matrix.copy(a.matrix);
      this.proxyMeshes[partIndex * 2].updateMatrixWorld(true);
    }
    if (this.proxyMeshes[partIndex * 2 + 1]) {
      this.proxyMeshes[partIndex * 2 + 1].matrixAutoUpdate = false;
      this.proxyMeshes[partIndex * 2 + 1].matrix.copy(b.matrix);
      this.proxyMeshes[partIndex * 2 + 1].updateMatrixWorld(true);
    }
  }

  private onPointerUp = (): void => {
    if (this.draggingPart === null) return;
    const index = this.draggingPart;
    const moved = this.dragMoved;
    const mode = this.dragMode;
    const half = this.dragHalf;
    const params = this._getDragParams?.() ?? this.dragParams;
    this.draggingPart = null;
    this.dragParams = null;
    this.dragSkeleton = null;
    this.dragMode = null;
    this.controls.enabled = true;
    this.renderer.domElement.style.cursor = '';
    if (!moved || !params) return;

    // Commit snap into stored angles so rebuild/UI keep the orientation.
    const part = params.parts[index];
    if (part && params.snapPreview) {
      if (half === 'A') {
        part.angleA = snapAngle(part.angleA ?? 0, part.symmetryN);
      } else {
        part.angle = snapAngle(part.angle, part.symmetryN);
      }
    }

    if (mode === 'rotate') this.onPartRotated?.(index);
    else this.onPartMoved?.(index);
  };

  private updatePointer(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private onResize = (): void => {
    const parent = this.renderer.domElement.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  getPlaneCompliance(): PlaneComplianceResult[] {
    return this.lastCompliance;
  }

  getPlaneComplianceSummary(): string {
    return complianceSummary(this.lastCompliance);
  }

  getPartGeometries(): BufferGeometry[] {
    return this.partGeometries;
  }

  setRebuilding(rebuilding: boolean, showSolids = true, planesOnly = false): void {
    const wasRebuilding = this.rebuilding;
    this.rebuilding = rebuilding;
    this.updateSolidWireVisibility(showSolids, planesOnly);
    // Flush collision overlays that were deferred while proxies were up.
    if (wasRebuilding && !rebuilding && this.intersectionRefreshPending) {
      this.scheduleIntersectionHighlight(true);
    }
  }

  setSolidsVisible(visible: boolean, planesOnly = false): void {
    this.updateSolidWireVisibility(visible, planesOnly);
  }

  /** Solids on → filled meshes; solids off → edge wireframes; planesOnly → neither. */
  private updateSolidWireVisibility(showSolids: boolean, planesOnly = false): void {
    if (planesOnly) {
      this.partsGroup.visible = false;
      this.proxyGroup.visible = false;
      return;
    }
    if (this.rebuilding) {
      this.partsGroup.visible = false;
      this.proxyGroup.visible = true;
      return;
    }
    this.partsGroup.visible = showSolids;
    this.proxyGroup.visible = !showSolids;
  }

  /** Show/hide part meshes from per-part visible + solo flags (no rescale). */
  applyPartVisibility(params: DesignParams): void {
    for (let i = 0; i < this.halfMeshes.length; i++) {
      const show = isPartVisible(params, i);
      this.halfMeshes[i].a.visible = show;
      this.halfMeshes[i].b.visible = show;
    }
    for (let i = 0; i < this.proxyMeshes.length; i++) {
      const partIndex = Math.floor(i / 2);
      this.proxyMeshes[i].visible = isPartVisible(params, partIndex);
    }
  }

  applySolidOpacity(opacity: number): void {
    const o = Math.max(0.05, Math.min(1, opacity));
    const transparent = o < 0.999;
    for (const pair of this.halfMeshes) {
      for (const mesh of [pair.a, pair.b]) {
        const mat = mesh.material as MeshStandardMaterial;
        mat.transparent = transparent;
        mat.opacity = o;
        mat.depthWrite = !transparent;
        mat.needsUpdate = true;
      }
    }
  }

  setBoundsWireframe(params: DesignParams): void {
    if (this.boundsLines) {
      this.boundsGroup.remove(this.boundsLines);
      this.boundsLines.geometry.dispose();
      (this.boundsLines.material as LineBasicMaterial).dispose();
      this.boundsLines = null;
    }
    if (this.boundsShell) {
      this.boundsGroup.remove(this.boundsShell);
      this.boundsShell.geometry.dispose();
      (this.boundsShell.material as MeshBasicMaterial).dispose();
      this.boundsShell = null;
    }
    if (!params.showBounds) return;

    const size = Math.max(params.macroSize, 0.5);
    if (params.macroShape === 'sphere') {
      const radius = size * 0.5;
      const sphere = new SphereGeometry(radius, 32, 16);
      const edges = new EdgesGeometry(sphere, 25);
      this.boundsLines = new LineSegments(
        edges,
        new LineBasicMaterial({ color: 0x7aa0c4, transparent: true, opacity: 0.65 }),
      );
      this.boundsShell = new Mesh(
        sphere,
        new MeshBasicMaterial({
          color: 0x6a90b8,
          transparent: true,
          opacity: 0.07,
          depthWrite: false,
          side: DoubleSide,
        }),
      );
    } else if (params.macroShape === 'tetrahedron') {
      const radius = size * 0.5;
      const verts = tetrahedronVertices(radius);
      const faces: [number, number, number][] = [
        [1, 3, 2],
        [0, 1, 2],
        [0, 2, 3],
        [0, 3, 1],
      ];
      const positions: number[] = [];
      for (const [i0, i1, i2] of faces) {
        for (const i of [i0, i1, i2]) {
          const v = verts[i];
          positions.push(v.x, v.y, v.z);
        }
      }
      const tetra = new BufferGeometry();
      tetra.setAttribute('position', new Float32BufferAttribute(positions, 3));
      tetra.computeVertexNormals();
      const edges = new EdgesGeometry(tetra);
      this.boundsLines = new LineSegments(
        edges,
        new LineBasicMaterial({ color: 0x7aa0c4, transparent: true, opacity: 0.65 }),
      );
      this.boundsShell = new Mesh(
        tetra,
        new MeshBasicMaterial({
          color: 0x6a90b8,
          transparent: true,
          opacity: 0.07,
          depthWrite: false,
          side: DoubleSide,
        }),
      );
    } else {
      const box = new BoxGeometry(size, size, size);
      const edges = new EdgesGeometry(box);
      box.dispose();
      this.boundsLines = new LineSegments(
        edges,
        new LineBasicMaterial({ color: 0x7aa0c4, transparent: true, opacity: 0.65 }),
      );
      this.boundsShell = new Mesh(
        new BoxGeometry(size, size, size),
        new MeshBasicMaterial({
          color: 0x6a90b8,
          transparent: true,
          opacity: 0.06,
          depthWrite: false,
          side: DoubleSide,
        }),
      );
    }
    this.boundsGroup.add(this.boundsLines);
    this.boundsGroup.add(this.boundsShell);
  }

  setStrutGuideWireframe(params: DesignParams): void {
    if (this.strutGuideLines) {
      this.strutGuideGroup.remove(this.strutGuideLines);
      this.strutGuideLines.geometry.dispose();
      (this.strutGuideLines.material as LineBasicMaterial).dispose();
      this.strutGuideLines = null;
    }
    if (!params.showStrutGuide || params.strutGuide === 'none') return;

    if (params.strutGuide === 'tetrahedron') {
      const struts = tetrahedronStruts(
        strutGuideRadius(params),
        params.strutGuideRotX,
        params.strutGuideRotY,
        params.strutGuideRotZ,
      );
      const positions: number[] = [];
      for (const s of struts) {
        positions.push(s.a.x, s.a.y, s.a.z, s.b.x, s.b.y, s.b.z);
      }
      const geo = new BufferGeometry();
      geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
      this.strutGuideLines = new LineSegments(
        geo,
        new LineBasicMaterial({
          color: 0xe8a05c,
          transparent: true,
          opacity: 0.95,
        }),
      );
      this.strutGuideGroup.add(this.strutGuideLines);
    }
  }

  applyPoses(skeleton: Skeleton, params: DesignParams): void {
    this.lastPoseSkeleton = skeleton;
    this.lastPoseParams = params;
    const poses = computeHalfPoses(skeleton, params);
    for (let i = 0; i < this.halfMeshes.length; i++) {
      const pose = poses[i];
      if (!pose) continue;
      const { a, b } = this.halfMeshes[i];
      a.matrixAutoUpdate = false;
      b.matrixAutoUpdate = false;
      a.matrix.copy(pose.halfA.matrix);
      b.matrix.copy(pose.halfB.matrix);
      a.updateMatrixWorld(true);
      b.updateMatrixWorld(true);

      if (this.proxyMeshes[i * 2]) {
        this.proxyMeshes[i * 2].matrixAutoUpdate = false;
        this.proxyMeshes[i * 2].matrix.copy(pose.halfA.matrix);
        this.proxyMeshes[i * 2].updateMatrixWorld(true);
      }
      if (this.proxyMeshes[i * 2 + 1]) {
        this.proxyMeshes[i * 2 + 1].matrixAutoUpdate = false;
        this.proxyMeshes[i * 2 + 1].matrix.copy(pose.halfB.matrix);
        this.proxyMeshes[i * 2 + 1].updateMatrixWorld(true);
      }
    }
    this.redrawSymmetryPlanes(skeleton, params);
    this.setStrutGuideWireframe(params);
    this.applyPartVisibility(params);
    this.scheduleIntersectionHighlight();
  }

  setPartHalves(
    halves: PartHalvesGeometry[],
    skeleton: Skeleton,
    params: DesignParams,
  ): void {
    for (const pair of this.halfMeshes) {
      this.partsGroup.remove(pair.a, pair.b);
      pair.a.geometry.dispose();
      pair.b.geometry.dispose();
      (pair.a.material as MeshStandardMaterial).dispose();
      (pair.b.material as MeshStandardMaterial).dispose();
    }
    for (const p of this.proxyMeshes) {
      this.proxyGroup.remove(p);
      p.geometry.dispose();
      (p.material as LineBasicMaterial).dispose();
    }
    for (const g of this.partGeometries) g.dispose();

    this.halfMeshes = [];
    this.proxyMeshes = [];
    this.partGeometries = [];

    halves.forEach((h, i) => {
      const base = partColorHex(i);
      const opacity = Math.max(0.05, Math.min(1, params.solidOpacity));
      const transparent = opacity < 0.999;
      const matA = new MeshStandardMaterial({
        color: base,
        metalness: 0.1,
        roughness: 0.5,
        transparent,
        opacity,
        depthWrite: !transparent,
      });
      const matB = new MeshStandardMaterial({
        color: base,
        metalness: 0.1,
        roughness: 0.42,
        emissive: base,
        emissiveIntensity: 0.04,
        transparent,
        opacity,
        depthWrite: !transparent,
      });
      const meshA = new Mesh(h.halfA.clone(), matA);
      const meshB = new Mesh(h.halfB.clone(), matB);
      meshA.userData.partIndex = i;
      meshB.userData.partIndex = i;
      this.partsGroup.add(meshA, meshB);
      this.halfMeshes.push({ a: meshA, b: meshB });

      const merged = mergeGeometries([h.halfA, h.halfB], false);
      if (merged) this.partGeometries.push(merged);

      // Wireframe follows the real half mesh (tilt, trim, soften) — not AABB.
      for (const geo of [h.halfA, h.halfB]) {
        const edges = new EdgesGeometry(geo, 20);
        const lines = new LineSegments(
          edges,
          new LineBasicMaterial({ color: base }),
        );
        this.proxyGroup.add(lines);
        this.proxyMeshes.push(lines);
      }
    });

    this.applyPoses(skeleton, params);
    this.setBoundsWireframe(params);
    this.setStrutGuideWireframe(params);
    this.rebuilding = false;
    this.updateSolidWireVisibility(params.showSolids, params.planesOnly);
    this.applySolidOpacity(params.solidOpacity);
    this.applyPartVisibility(params);
    // Force a fresh collision overlay from the new meshes (don't rely on
    // a timeout that may have been skipped while rebuilding).
    this.intersectionRefreshPending = false;
    this.refreshIntersectionHighlight();
  }

  /** @deprecated — use setPartHalves */
  setPartGeometries(
    geos: BufferGeometry[],
    skeleton: Skeleton,
    params: DesignParams,
  ): void {
    const halves: PartHalvesGeometry[] = [];
    for (let i = 0; i < geos.length; i += 2) {
      if (geos[i] && geos[i + 1]) {
        halves.push({ halfA: geos[i], halfB: geos[i + 1] });
      }
    }
    this.setPartHalves(halves, skeleton, params);
  }

  setEnvelopes(geos: BufferGeometry[], visible: boolean): void {
    while (this.envelopeGroup.children.length) {
      const child = this.envelopeGroup.children[0] as Mesh;
      this.envelopeGroup.remove(child);
      child.geometry.dispose();
      (child.material as MeshStandardMaterial).dispose();
    }
    if (!visible) return;
    for (const geo of geos) {
      const mesh = new Mesh(
        geo.clone(),
        new MeshStandardMaterial({
          color: 0xffee88,
          transparent: true,
          opacity: 0.12,
          depthWrite: false,
          side: DoubleSide,
        }),
      );
      this.envelopeGroup.add(mesh);
    }
  }

  private redrawSymmetryPlanes(skeleton: Skeleton, params: DesignParams): void {
    while (this.planeGroup.children.length) {
      const child = this.planeGroup.children[0] as Mesh | LineSegments;
      this.planeGroup.remove(child);
      child.geometry.dispose();
      const mat = child.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else (mat as MeshBasicMaterial | LineBasicMaterial).dispose();
    }
    while (this.axesGroup.children.length) {
      this.axesGroup.remove(this.axesGroup.children[0]);
    }
    // Planes-only always shows interiors; wireframe mode does too; else honor showAxes.
    const showPlanes =
      params.planesOnly || params.showAxes || !params.showSolids;
    this.lastCompliance = evaluatePlaneCompliance(
      skeleton,
      params,
      this.halfMeshes,
    );
    const poses = computeHalfPoses(skeleton, params);

    for (let i = 0; i < skeleton.parts.length; i++) {
      const ok = this.lastCompliance[i]?.compliant !== false;
      this.applyPlaneComplianceHighlight(i, ok);

      if (!isPartVisible(params, i)) continue;

      const frame = partWorldFrame(skeleton, params, i);

      if (params.showArrows) {
        const arrow = new ArrowHelper(
          frame.axis,
          frame.origin,
          1.2,
          ok ? partColorHex(i) : 0xff3355,
          0.22,
          0.12,
        );
        this.axesGroup.add(arrow);
      }

      if (!showPlanes || !this.halfMeshes[i]) continue;

      const part = skeleton.parts[i];
      const n = part.symmetryN;
      const r = partPlaneRadius(params, params.parts[i] ?? ({} as never));
      const mA = poses[i]?.halfA.matrix ?? this.halfMeshes[i].a.matrix;
      const mB = poses[i]?.halfB.matrix ?? this.halfMeshes[i].b.matrix;
      // N-gon clipped to this part's solid midplane section — never sticks out.
      const { uv } = clippedRotationalPlanePolygon(
        {
          origin: frame.origin,
          axis: frame.axis,
          xAxis: frame.xAxis,
          yAxis: frame.yAxis,
        },
        r,
        n,
        { geometry: this.halfMeshes[i].a.geometry, matrix: mA },
        { geometry: this.halfMeshes[i].b.geometry, matrix: mB },
      );
      if (uv.length < 3) continue;

      const shape = new Shape();
      shape.moveTo(uv[0].x, uv[0].y);
      for (let s = 1; s < uv.length; s++) shape.lineTo(uv[s].x, uv[s].y);
      shape.closePath();
      for (const p of uv) {
        shape.moveTo(0, 0);
        shape.lineTo(p.x, p.y);
      }

      const geo = new ShapeGeometry(shape);
      const mat = new MeshBasicMaterial({
        color: ok ? partColorHex(i) : 0xff2244,
        transparent: true,
        opacity: ok
          ? params.planesOnly
            ? 0.7
            : params.showSolids
              ? 0.35
              : 0.55
          : 0.85,
        side: DoubleSide,
        depthWrite: false,
      });
      const mesh = new Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.makeBasis(frame.xAxis, frame.yAxis, frame.axis);
      mesh.matrix.setPosition(frame.origin);
      mesh.updateMatrixWorld(true);
      this.planeGroup.add(mesh);

      // Non-compliant: red outline for clarity.
      if (!ok) {
        const ring = new Shape();
        ring.moveTo(uv[0].x * 1.04, uv[0].y * 1.04);
        for (let s = 1; s < uv.length; s++) {
          ring.lineTo(uv[s].x * 1.04, uv[s].y * 1.04);
        }
        ring.closePath();
        const edgeGeo = new EdgesGeometry(new ShapeGeometry(ring));
        const edge = new LineSegments(
          edgeGeo,
          new LineBasicMaterial({ color: 0xff6688 }),
        );
        edge.matrixAutoUpdate = false;
        edge.matrix.copy(mesh.matrix);
        edge.updateMatrixWorld(true);
        this.planeGroup.add(edge);
      }
    }
    this.axesGroup.visible = params.showArrows;
  }

  private applyPlaneComplianceHighlight(i: number, ok: boolean): void {
    if (!this.halfMeshes[i]) return;
    for (const m of [this.halfMeshes[i].a, this.halfMeshes[i].b]) {
      const matS = m.material as MeshStandardMaterial;
      if (!ok) {
        matS.emissive.setHex(0xff2244);
        matS.emissiveIntensity = 0.35;
      } else {
        matS.emissive.setHex(partColorHex(i));
        matS.emissiveIntensity = m === this.halfMeshes[i].b ? 0.04 : 0;
      }
    }
  }

  setSkeletonProxies(skeleton: Skeleton, params: DesignParams): void {
    for (const p of this.proxyMeshes) {
      this.proxyGroup.remove(p);
      p.geometry.dispose();
      (p.material as LineBasicMaterial).dispose();
    }
    this.proxyMeshes = [];

    // Tilt-aware interim wireframes from the same prism/hull builders as solids.
    const halves = buildAllPartHalves(skeleton, params);
    halves.forEach((h, i) => {
      const base = partColorHex(i);
      for (const geo of [h.halfA, h.halfB]) {
        const edges = new EdgesGeometry(geo, 20);
        const lines = new LineSegments(
          edges,
          new LineBasicMaterial({ color: base }),
        );
        this.proxyGroup.add(lines);
        this.proxyMeshes.push(lines);
        geo.dispose();
      }
    });

    this.partsGroup.visible = false;
    this.proxyGroup.visible = true;
    this.clearIntersectionHighlight();
    this.setBoundsWireframe(params);
    this.setStrutGuideWireframe(params);
    this.applyPoses(skeleton, params);
  }

  private scheduleIntersectionHighlight(force = false): void {
    if (this.rebuilding) {
      this.intersectionRefreshPending = true;
      return;
    }
    if (this.intersectionDirty && !force) return;
    this.intersectionDirty = true;
    window.setTimeout(() => {
      this.intersectionDirty = false;
      if (this.rebuilding) {
        this.intersectionRefreshPending = true;
        return;
      }
      this.intersectionRefreshPending = false;
      this.refreshIntersectionHighlight();
    }, force ? 0 : 60);
  }

  private clearIntersectionHighlight(): void {
    for (const m of this.intersectionMeshes) {
      this.intersectionGroup.remove(m);
      m.geometry.dispose();
      (m.material as MeshBasicMaterial).dispose();
    }
    for (const e of this.intersectionEdges) {
      this.intersectionGroup.remove(e);
      e.geometry.dispose();
      (e.material as LineBasicMaterial).dispose();
    }
    this.intersectionMeshes = [];
    this.intersectionEdges = [];
  }

  /** Bright contact overlays: magenta = part–part, yellow = bound. */
  refreshIntersectionHighlight(): void {
    this.clearIntersectionHighlight();
    const skeleton = this.lastPoseSkeleton;
    const params = this.lastPoseParams;
    if (!skeleton || !params || this.halfMeshes.length < 1) return;

    const showPart = params.showPartIntersections;
    const showBound = params.showBoundIntersections;
    if (!showPart && !showBound) {
      this.intersectionGroup.visible = false;
      return;
    }
    this.intersectionGroup.visible = true;

    // Use the displayed (posed) solids — not untrimmed generation hulls —
    // so separated parts never get a false contact plane.
    const pairs = this.halfMeshes.map((h) => {
      h.a.updateMatrixWorld(true);
      h.b.updateMatrixWorld(true);
      return {
        halfA: h.a.geometry as BufferGeometry,
        halfB: h.b.geometry as BufferGeometry,
        matrixA: h.a.matrixWorld.clone(),
        matrixB: h.b.matrixWorld.clone(),
      };
    });

    let planes: {
      part: { fill: BufferGeometry; outline: BufferGeometry }[];
      bound: { fill: BufferGeometry; outline: BufferGeometry }[];
    } = { part: [], bound: [] };
    try {
      planes = computePartIntersectionPlanes(skeleton, params, pairs);
    } catch {
      planes = { part: [], bound: [] };
    }

    const addPlanes = (
      list: { fill: BufferGeometry; outline: BufferGeometry }[],
      fillColor: number,
      edgeColor: number,
    ) => {
      for (const { fill, outline } of list) {
        const mesh = new Mesh(
          fill,
          new MeshBasicMaterial({
            color: fillColor,
            transparent: true,
            opacity: 0.75,
            depthWrite: false,
            depthTest: false,
            side: DoubleSide,
          }),
        );
        mesh.renderOrder = 10;
        this.intersectionGroup.add(mesh);
        this.intersectionMeshes.push(mesh);

        const edge = new LineSegments(
          outline,
          new LineBasicMaterial({
            color: edgeColor,
            depthTest: false,
          }),
        );
        edge.renderOrder = 11;
        this.intersectionGroup.add(edge);
        this.intersectionEdges.push(edge);
      }
    };

    if (showPart) addPlanes(planes.part, 0xff3d9a, 0xff79b8);
    if (showBound) addPlanes(planes.bound, 0xffee00, 0xfff200);
  }
}
