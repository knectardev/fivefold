import './style.css';
import {
  defaultParams,
  defaultPart,
  ensurePartCount,
  fitMacroToChain,
  syncChainLayout,
  syncVoronoiSeeds,
  type DesignParams,
  type Skeleton,
} from './model/types';
import { buildSkeleton } from './model/skeleton';
import { REBUILD_DEBOUNCE_MS } from './geom/pipeline';
import { runGeometryPipelineAsync } from './geom/pipelineClient';
import { Viewer } from './scene/viewer';
import { buildControls } from './ui/controls';
import {
  createDebouncedRunner,
  onRebuildState,
  setRebuildPhase,
} from './ui/rebuildState';
import { exportAllPartsStl, exportPartStl } from './export/stl';
import {
  createParamsUndoStack,
  restoreParamsInto,
} from './ui/undoStack';
import { solveVoronoiAsync } from './solvers/solverClient';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('#app missing');
}

const homeLink = document.createElement('a');
homeLink.id = 'home-link';
homeLink.href = '/';
homeLink.textContent = '← All projects';
app.appendChild(homeLink);

const statusEl = document.createElement('div');
statusEl.id = 'status';
statusEl.textContent = 'Ready';
app.appendChild(statusEl);

const params: DesignParams = defaultParams();
ensurePartCount(params);
fitMacroToChain(params);

const undo = createParamsUndoStack(params);

const viewer = new Viewer(app);
let skeleton: Skeleton = buildSkeleton(params);
let rebuildGeneration = 0;

viewer.setSkeletonProxies(skeleton, params);

function updateStatus(): void {
  onRebuildState((s) => {
    if (s.phase === 'rebuilding') {
      statusEl.textContent = 'Rebuilding geometry…';
      statusEl.classList.add('rebuilding');
      viewer.setRebuilding(true, params.showSolids, params.planesOnly);
    } else if (s.phase === 'pending') {
      statusEl.textContent = 'Rebuild scheduled…';
      statusEl.classList.add('rebuilding');
      viewer.setRebuilding(true, params.showSolids, params.planesOnly);
    } else if (s.lastError) {
      statusEl.textContent = `Error: ${s.lastError}`;
      statusEl.classList.add('rebuilding');
      viewer.setRebuilding(false, params.showSolids, params.planesOnly);
    } else {
      const conflict = viewer.getPlaneComplianceSummary();
      statusEl.textContent = conflict || 'Ready';
      statusEl.classList.remove('rebuilding');
      if (conflict) statusEl.classList.add('plane-conflict');
      else statusEl.classList.remove('plane-conflict');
      viewer.setRebuilding(false, params.showSolids, params.planesOnly);
      viewer.setSolidsVisible(params.showSolids, params.planesOnly);
    }
  });
}
updateStatus();

function applyPose(): void {
  skeleton = buildSkeleton(params);
  params.activePart = Math.max(
    0,
    Math.min(params.activePart, params.partCount - 1),
  );
  viewer.applyPoses(skeleton, params);
  viewer.setSolidsVisible(params.showSolids, params.planesOnly);
  viewer.applySolidOpacity(params.solidOpacity);
  viewer.applyPartVisibility(params);
  viewer.setBoundsWireframe(params);

  const conflict = viewer.getPlaneComplianceSummary();
  if (conflict && !statusEl.classList.contains('rebuilding')) {
    statusEl.textContent = conflict;
    statusEl.classList.add('plane-conflict');
  } else if (!statusEl.classList.contains('rebuilding')) {
    statusEl.textContent = 'Ready';
    statusEl.classList.remove('plane-conflict');
  }
}

async function rebuildGeometry(): Promise<void> {
  const gen = ++rebuildGeneration;
  try {
    const { result } = await runGeometryPipelineAsync(params);
    if (gen !== rebuildGeneration) {
      for (const p of result.parts) p.dispose();
      for (const e of result.envelopes) e.dispose();
      return;
    }
    skeleton = result.skeleton;

    if (result.halves?.length) {
      viewer.setPartHalves(result.halves, skeleton, params);
    } else {
      viewer.setPartGeometries(result.parts, skeleton, params);
    }
    viewer.setEnvelopes(
      params.showEnvelopes ? result.envelopes : [],
      params.showEnvelopes,
    );
    viewer.setSolidsVisible(params.showSolids, params.planesOnly);
    viewer.applySolidOpacity(params.solidOpacity);
    viewer.applyPartVisibility(params);
    viewer.setBoundsWireframe(params);

    for (const p of result.parts) p.dispose();
    for (const e of result.envelopes) e.dispose();
  } catch (err) {
    if (err instanceof Error && err.message === 'superseded') return;
    throw err;
  }
}

const debouncedRebuild = createDebouncedRunner(REBUILD_DEBOUNCE_MS, () =>
  rebuildGeometry(),
);

function onGeometryChange(): void {
  undo.note(params);
  // Mark rebuilding first so deferred collision overlays don't paint stale meshes.
  viewer.setRebuilding(true, params.showSolids, params.planesOnly);
  skeleton = buildSkeleton(params);
  viewer.setSkeletonProxies(skeleton, params);
  debouncedRebuild.schedule();
}

function onPoseChange(): void {
  applyPose();
}

function performUndo(): void {
  const snap = undo.undo();
  if (!snap) {
    statusEl.textContent = 'Nothing to undo';
    return;
  }
  undo.runSuspended(() => {
    restoreParamsInto(params, snap);
    ensurePartCount(params);
    gui.destroy();
    gui = buildControls(params, handlers);
    onGeometryChange();
  });
  statusEl.textContent = `Undo (${undo.depth()} left)`;
  statusEl.classList.remove('plane-conflict');
}

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) {
    return;
  }
  // Ignore when typing into a non-gui field; lil-gui number inputs still undo design.
  e.preventDefault();
  performUndo();
});

function applyPreset(
  name: 'squareStack' | 'triSquare' | 'space3d' | 'voronoiBox',
): void {
  params.clearanceGap = 0;
  params.soften = 0;
  params.facetComplexity = 0;
  params.showSolids = true;
  params.protrusionTilt = 0;
  params.strutGuide = 'none';

  if (name === 'squareStack') {
    params.partCount = 1;
    params.layoutMode = 'free';
    params.linkLength = 2.2;
    params.contactRadius = 0.85;
    params.macroSize = 8;
    params.parts = [
      {
        ...defaultPart(0, 2.2, 0.85, 0),
        symmetryN: 4,
        angle: 0,
        posX: 0,
        posY: 0,
        posZ: 0,
      },
    ];
  } else if (name === 'triSquare') {
    params.partCount = 2;
    params.layoutMode = 'free';
    params.linkLength = 1.8;
    params.contactRadius = 0.7;
    params.macroSize = 8;
    params.protrusionTilt = 8;
    params.parts = [
      {
        ...defaultPart(0, 1.8, 0.7, 8),
        symmetryN: 3,
        posX: -1.4,
        posY: 0.2,
        posZ: 0.1,
        rotZ: 12,
        angle: 0,
      },
      {
        ...defaultPart(1, 1.8, 0.7, 8),
        symmetryN: 4,
        posX: 1.4,
        posY: -0.15,
        posZ: -0.1,
        rotY: -14,
        angle: 90,
      },
    ];
  } else if (name === 'voronoiBox') {
    params.partCount = 4;
    params.layoutMode = 'voronoi';
    params.macroShape = 'box';
    params.macroSize = 6.5;
    params.linkLength = 2.2;
    params.contactRadius = 0.7;
    params.clearanceGap = 0.1;
    params.parts = [
      { ...defaultPart(0, 2.2, 0.7, 0), symmetryN: 4, rotX: 20, rotY: -15 },
      { ...defaultPart(1, 2.2, 0.7, 0), symmetryN: 3, rotY: 35, rotZ: 10 },
      { ...defaultPart(2, 2.2, 0.7, 0), symmetryN: 6, rotX: -25, rotZ: 40 },
      { ...defaultPart(3, 2.2, 0.7, 0), symmetryN: 4, rotX: 50, rotY: 20 },
    ];
    ensurePartCount(params);
    syncVoronoiSeeds(params);
  } else {
    params.partCount = 2;
    params.layoutMode = 'free';
    params.linkLength = 1.6;
    params.contactRadius = 0.75;
    params.macroSize = 8;
    params.protrusionTilt = 12;
    params.parts = [
      {
        ...defaultPart(0, 1.6, 0.75, 12),
        symmetryN: 4,
        posX: -1.2,
        posY: 0.3,
        posZ: 0.4,
        rotX: 18,
        rotY: -25,
        rotZ: 10,
        angle: 0,
      },
      {
        ...defaultPart(1, 1.6, 0.8, 5),
        symmetryN: 3,
        posX: 1.3,
        posY: -0.25,
        posZ: -0.2,
        rotX: -30,
        rotY: 40,
        rotZ: 15,
        angle: 120,
      },
    ];
  }

  ensurePartCount(params);
  if ((params.layoutMode as string) === 'chain') {
    syncChainLayout(params);
  }
  fitMacroToChain(params);

  gui.destroy();
  gui = buildControls(params, handlers);
  onGeometryChange();
}

const handlers = {
  onGeometryChange,
  onPoseChange,
  onParamsMutated: () => {
    const g = gui as typeof gui & { __refreshMacroSize?: () => void };
    g.__refreshMacroSize?.();
  },
  onExportPart: (index: number) => {
    const geos = viewer.getPartGeometries();
    if (!geos[index]) {
      statusEl.textContent = `No geometry for part ${index + 1}`;
      return;
    }
    exportPartStl(geos[index], `kinetic-part-${index + 1}.stl`);
  },
  onExportAll: () => {
    const geos = viewer.getPartGeometries();
    if (!geos.length) {
      statusEl.textContent = 'No geometry to export';
      return;
    }
    exportAllPartsStl(geos);
  },
  onPreset: applyPreset,
  onSolveVoronoi: (opts: {
    partCount: 4 | 5 | 6 | 7 | 8;
    maxAttempts: number;
    symmetryMode: 'random' | 3 | 4 | 6;
  }) => {
    statusEl.textContent = `Solving Voronoi (${opts.partCount} parts)…`;
    statusEl.classList.add('rebuilding');
    statusEl.classList.remove('plane-conflict');
    void solveVoronoiAsync({
      partCount: opts.partCount,
      maxAttempts: opts.maxAttempts,
      symmetryMode: opts.symmetryMode,
      // Solver uses its own conservative sizing; don't inherit oversized UI radii.
      macroSize: Math.max(6, params.macroSize),
      contactRadius: Math.min(0.45, Math.max(0.28, params.contactRadius * 0.7)),
      clearanceGap: Math.max(0.05, params.clearanceGap || 0.08),
      halfExtent: Math.min(
        0.7,
        Math.max(0.35, params.linkLength * 0.35),
      ),
    })
      .then(async (result) => {
        undo.note(params);
        undo.runSuspended(() => {
          restoreParamsInto(params, result.params);
          ensurePartCount(params);
          gui.destroy();
          gui = buildControls(params, handlers);
        });
        setRebuildPhase('rebuilding');
        viewer.setRebuilding(true, params.showSolids, params.planesOnly);
        skeleton = buildSkeleton(params);
        viewer.setSkeletonProxies(skeleton, params);
        try {
          await rebuildGeometry();
          setRebuildPhase('idle');
        } catch (err: unknown) {
          if (!(err instanceof Error && err.message === 'superseded')) {
            setRebuildPhase(
              'idle',
              err instanceof Error ? err.message : String(err),
            );
          }
        }
        statusEl.textContent = result.message;
        statusEl.classList.remove('rebuilding');
        if (result.solved) statusEl.classList.remove('plane-conflict');
        else statusEl.classList.add('plane-conflict');
      })
      .catch((err: unknown) => {
        statusEl.textContent = `Solve failed: ${
          err instanceof Error ? err.message : String(err)
        }`;
        statusEl.classList.remove('rebuilding');
        statusEl.classList.add('plane-conflict');
      });
  },
};
let gui = buildControls(params, handlers);

viewer.enablePartDragging(
  () => params,
  () => skeleton,
  {
    onPartMoved: () => {
      if (params.layoutMode === 'chain') params.layoutMode = 'free';
      const g = gui as typeof gui & { __rebuildPartFolders?: () => void };
      g.__rebuildPartFolders?.();
      onGeometryChange();
    },
    onPartRotated: () => {
      undo.note(params);
      const g = gui as typeof gui & { __syncIsolateAngle?: () => void };
      // Sync UI from committed part angles (do not write back).
      g.__syncIsolateAngle?.();
      applyPose();
      // Angle is FK-only; skip geometry rebuild so nothing can clobber poses.
    },
    onPartSelected: (index) => {
      params.activePart = index;
      const g = gui as typeof gui & { __syncIsolateAngle?: () => void };
      g.__syncIsolateAngle?.();
      applyPose();
    },
  },
);

setRebuildPhase('rebuilding');
viewer.setRebuilding(true, params.showSolids, params.planesOnly);
void rebuildGeometry()
  .then(() => setRebuildPhase('idle'))
  .catch((err: unknown) => {
    setRebuildPhase(
      'idle',
      err instanceof Error ? err.message : String(err),
    );
  });

(window as unknown as { __kineticDebug: unknown }).__kineticDebug = {
  params,
  applyPose,
  onGeometryChange,
  getPartCounts: () =>
    viewer.getPartGeometries().map((g) => g.getAttribute('position')?.count ?? 0),
  exportPart: (i: number) => {
    const geos = viewer.getPartGeometries();
    if (geos[i]) exportPartStl(geos[i], `kinetic-part-${i + 1}.stl`);
  },
};
