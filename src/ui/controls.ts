import GUI from 'lil-gui';
import type { DesignParams, LayoutMode, SymmetryN } from '../model/types';
import {
  ensurePartCount,
  fitMacroToChain,
  syncChainLayout,
  syncVoronoiSeeds,
  scaleVoronoiSeeds,
  rescatterParts,
  growPartPlane,
  setAllPartsSymmetry,
  randomizeAllPartsSymmetry,
  nucleatePart,
} from '../model/types';
import { applyStrutGuideAlignment } from '../model/strutGuide';
import { partColorCss } from '../model/partColors';

export interface ControlHandlers {
  onGeometryChange: () => void;
  /** Pose-only update; free mode may also rebuild geometry for snap trim. */
  onPoseChange: () => void;
  onExportPart: (index: number) => void;
  onExportAll: () => void;
  onPreset: (name: 'squareStack' | 'triSquare' | 'space3d' | 'voronoiBox') => void;
  onParamsMutated?: () => void;
  /** Plane-first Voronoi solver (async). */
  onSolveVoronoi?: (opts: {
    partCount: 4 | 5 | 6 | 7 | 8;
    maxAttempts: number;
    symmetryMode: 'random' | 3 | 4 | 6;
  }) => void;
}


function colorizePartFolder(folder: GUI, index: number): void {
  const css = partColorCss(index);
  const root = folder.domElement as HTMLElement;
  root.classList.add('lil-part-folder');
  root.style.setProperty('--part-color', css);

  // lil-gui uses .lil-title (not .title)
  const title = root.querySelector('.lil-title') as HTMLElement | null;
  if (!title) return;

  title.style.borderLeft = `5px solid ${css}`;
  title.style.boxShadow = `inset 3px 0 0 ${css}`;
  title.style.paddingLeft = '10px';

  if (!title.querySelector('.lil-part-swatch')) {
    const swatch = document.createElement('span');
    swatch.className = 'lil-part-swatch';
    swatch.style.background = css;
    // Insert after the expand caret text node / at start of label content
    title.appendChild(swatch);
    // Prefer before the name text: move swatch after :before caret
    title.insertBefore(swatch, title.firstChild);
  } else {
    (title.querySelector('.lil-part-swatch') as HTMLElement).style.background =
      css;
  }
}

function isPartSoloed(params: DesignParams, index: number): boolean {
  const visibleCount = params.parts.filter((p) => p.visible !== false).length;
  return (
    visibleCount === 1 && params.parts[index]?.visible !== false
  );
}

function soloPart(params: DesignParams, index: number): void {
  params.parts.forEach((p, j) => {
    p.visible = j === index;
  });
  params.soloActivePart = false;
  params.activePart = index;
}

function showAllParts(params: DesignParams): void {
  for (const p of params.parts) p.visible = true;
  params.soloActivePart = false;
}

export function buildControls(
  params: DesignParams,
  handlers: ControlHandlers,
): GUI {
  const gui = new GUI({ title: 'Kinetic Cells' });

  gui
    .add(params, 'showPartIntersections')
    .name('Internal intersections')
    .onChange(handlers.onPoseChange);
  gui
    .add(params, 'showBoundIntersections')
    .name('Bound intersections')
    .onChange(handlers.onPoseChange);
  gui
    .add(params, 'showArrows')
    .name('Axis arrows')
    .onChange(handlers.onPoseChange);
  const solidsCtrl = gui
    .add(params, 'showSolids')
    .name('Solid bodies')
    .onChange(() => {
      // Planes-only hides bodies even when this box is checked; clear it so
      // one click can restore solids.
      if (params.planesOnly) {
        params.planesOnly = false;
        params.showSolids = true;
        planesOnlyCtrl.updateDisplay();
        solidsCtrl.updateDisplay();
      }
      handlers.onPoseChange();
    });
  const planesOnlyCtrl = gui
    .add(params, 'planesOnly')
    .name('Planes only')
    .onChange(() => {
      handlers.onPoseChange();
    });

  const chain = gui.addFolder('Assembly');
  const partCountCtrl = chain
    .add(params, 'partCount', {
      '1': 1,
      '2': 2,
      '3': 3,
      '4': 4,
      '5': 5,
      '6': 6,
      '7': 7,
      '8': 8,
    })
    .name('Parts')
    .onChange(() => {
      ensurePartCount(params);
      if (params.layoutMode === 'voronoi' || params.layoutMode === 'free') {
        rescatterParts(params);
      }
      fitMacroToChain(params);
      activePartCtrl.max(Math.max(0, params.partCount - 1));
      params.activePart = Math.min(params.activePart, params.partCount - 1);
      activePartCtrl.updateDisplay();
      rebuildPartFolders();
      handlers.onParamsMutated?.();
      handlers.onGeometryChange();
    });
  chain
    .add(params, 'layoutMode', {
      free: 'free',
      chain: 'chain',
      'voronoi (exp.)': 'voronoi',
    })
    .name('Layout')
    .onChange((v: string) => {
      params.layoutMode = v as LayoutMode;
      if (params.layoutMode === 'chain') {
        syncChainLayout(params);
      } else if (params.layoutMode === 'voronoi') {
        syncVoronoiSeeds(params);
        params.macroShape = 'box';
      }
      rebuildPartFolders();
      fitMacroToChain(params);
      handlers.onParamsMutated?.();
      handlers.onGeometryChange();
    });

  const globalN = { mode: '4' as string };
  chain
    .add(globalN, 'mode', {
      random: 'random',
      '3': '3',
      '4': '4',
      '6': '6',
    })
    .name('Set all N-fold')
    .onChange((v: string) => {
      if (v === 'random') {
        randomizeAllPartsSymmetry(params);
      } else {
        setAllPartsSymmetry(params, Number(v) as SymmetryN);
      }
      rebuildPartFolders();
      handlers.onParamsMutated?.();
      handlers.onGeometryChange();
    });
  // Apply the UI default so the viewport matches the control on first load.
  setAllPartsSymmetry(params, 4);

  chain
    .add(
      {
        nucleate: () => {
          const mode =
            globalN.mode === 'random'
              ? ('random' as const)
              : (Number(globalN.mode) as SymmetryN);
          if (!nucleatePart(params, mode)) return;
          partCountCtrl.updateDisplay();
          activePartCtrl.max(Math.max(0, params.partCount - 1));
          activePartCtrl.updateDisplay();
          rebuildPartFolders();
          handlers.onParamsMutated?.();
          handlers.onGeometryChange();
        },
      },
      'nucleate',
    )
    .name('Nucleate part outside');

  const prism = gui.addFolder('Prism defaults');
  prism
    .add(params, 'linkLength', 0.6, 4, 0.05)
    .name('Default half extent')
    .onChange(() => {
      // Global default drives every part's A/B half extents (half of linkLength).
      const half = Math.max(0.15, params.linkLength * 0.5);
      for (const p of params.parts) {
        p.halfExtentA = half;
        p.halfExtentB = half;
      }
      if (params.layoutMode === 'chain') syncChainLayout(params);
      rebuildPartFolders();
      fitMacroToChain(params);
      handlers.onParamsMutated?.();
      handlers.onGeometryChange();
    });
  prism
    .add(params, 'contactRadius', 0.2, 2.5, 0.05)
    .name('Default plane radius')
    .onChange(() => {
      for (const p of params.parts) {
        p.planeRadius = params.contactRadius;
      }
      rebuildPartFolders();
      fitMacroToChain(params);
      handlers.onParamsMutated?.();
      handlers.onGeometryChange();
    });
  prism
    .add(params, 'protrusionTilt', -30, 30, 1)
    .name('Default tilt°')
    .onChange(() => {
      for (const p of params.parts) {
        p.protrusionTilt = params.protrusionTilt;
      }
      rebuildPartFolders();
      handlers.onGeometryChange();
    });
  prism
    .add(
      {
        applyExtents: () => {
          const half = Math.max(0.15, params.linkLength * 0.5);
          for (const p of params.parts) {
            p.halfExtentA = half;
            p.halfExtentB = half;
          }
          rebuildPartFolders();
          handlers.onGeometryChange();
        },
      },
      'applyExtents',
    )
    .name('Apply default extents to all');
  prism
    .add(
      {
        applyRadii: () => {
          for (const p of params.parts) {
            p.planeRadius = params.contactRadius;
          }
          rebuildPartFolders();
          handlers.onGeometryChange();
        },
      },
      'applyRadii',
    )
    .name('Apply default radius to all');
  prism.open();

  chain
    .add(
      {
        resetChain: () => {
          params.layoutMode = 'chain';
          syncChainLayout(params);
          fitMacroToChain(params);
          rebuildPartFolders();
          handlers.onParamsMutated?.();
          handlers.onGeometryChange();
        },
      },
      'resetChain',
    )
    .name('Reset to linear chain');
  chain
    .add(
      {
        rescatter: () => {
          if (params.layoutMode === 'chain') params.layoutMode = 'free';
          rescatterParts(params);
          rebuildPartFolders();
          handlers.onParamsMutated?.();
          handlers.onGeometryChange();
        },
      },
      'rescatter',
    )
    .name('Rescatter parts');

  const solver = gui.addFolder('Voronoi solver');
  const solverState = {
    partCount: Math.max(4, Math.min(8, params.partCount)) as 4 | 5 | 6 | 7 | 8,
    maxAttempts: 80,
    symmetryMode: 'random' as string,
  };
  solver
    .add(solverState, 'partCount', {
      '4': 4,
      '5': 5,
      '6': 6,
      '7': 7,
      '8': 8,
    })
    .name('Solve parts');
  solver
    .add(solverState, 'symmetryMode', {
      random: 'random',
      '3': '3',
      '4': '4',
      '6': '6',
    })
    .name('Solve N-fold');
  solver
    .add(solverState, 'maxAttempts', 10, 200, 10)
    .name('Max attempts');
  solver
    .add(
      {
        solve: () => {
          const n = Number(solverState.partCount) as 4 | 5 | 6 | 7 | 8;
          const mode =
            solverState.symmetryMode === 'random'
              ? ('random' as const)
              : (Number(solverState.symmetryMode) as 3 | 4 | 6);
          handlers.onSolveVoronoi?.({
            partCount: n,
            maxAttempts: Math.round(solverState.maxAttempts),
            symmetryMode: mode,
          });
        },
      },
      'solve',
    )
    .name('Solve Voronoi');
  solver.open();

  const macro = gui.addFolder('Macro');
  macro
    .add(params, 'macroShape', ['sphere', 'box', 'tetrahedron'])
    .name('Shape')
    .onChange(handlers.onGeometryChange);
  let lastMacroSize = params.macroSize;
  const macroSizeCtrl = macro
    .add(params, 'macroSize', 2, 24, 0.1)
    .name('Bounding size')
    .onChange(() => {
      if (params.layoutMode === 'voronoi') {
        scaleVoronoiSeeds(params, lastMacroSize);
      }
      lastMacroSize = params.macroSize;
      handlers.onParamsMutated?.();
      handlers.onGeometryChange();
    });
  macro.add(params, 'showBounds').name('Show bounds').onChange(handlers.onPoseChange);

  const strut = gui.addFolder('Strut guide');
  const refreshAfterStrut = (): void => {
    partCountCtrl.updateDisplay();
    activePartCtrl.max(Math.max(0, params.partCount - 1));
    activePartCtrl.updateDisplay();
    rebuildPartFolders();
    handlers.onParamsMutated?.();
    handlers.onGeometryChange();
  };
  const applyStruts = (): void => {
    if (!applyStrutGuideAlignment(params)) return;
    refreshAfterStrut();
  };
  strut
    .add(params, 'strutGuide', ['none', 'tetrahedron'])
    .name('Geometry')
    .onChange((v: string) => {
      if (v === 'tetrahedron') {
        params.showStrutGuide = true;
        applyStruts();
      } else {
        handlers.onPoseChange();
      }
    });
  strut
    .add(params, 'showStrutGuide')
    .name('Show guide')
    .onChange(handlers.onPoseChange);
  strut
    .add(params, 'strutGuideSize', 1, 24, 0.1)
    .name('Guide size')
    .onChange(() => {
      if (params.strutGuide === 'tetrahedron') applyStruts();
      else handlers.onPoseChange();
    });
  strut
    .add(params, 'strutGuideRotX', -180, 180, 1)
    .name('Guide rot X°')
    .onChange(() => {
      if (params.strutGuide === 'tetrahedron') applyStruts();
      else handlers.onPoseChange();
    });
  strut
    .add(params, 'strutGuideRotY', -180, 180, 1)
    .name('Guide rot Y°')
    .onChange(() => {
      if (params.strutGuide === 'tetrahedron') applyStruts();
      else handlers.onPoseChange();
    });
  strut
    .add(params, 'strutGuideRotZ', -180, 180, 1)
    .name('Guide rot Z°')
    .onChange(() => {
      if (params.strutGuide === 'tetrahedron') applyStruts();
      else handlers.onPoseChange();
    });
  strut
    .add({ apply: applyStruts }, 'apply')
    .name('Align parts to struts');

  const clearance = gui.addFolder('Clearance / Soften');
  clearance
    .add(params, 'clearanceGap', 0, 0.35, 0.005)
    .name('clearanceGap (parts)')
    .onChange(handlers.onGeometryChange);
  clearance.add(params, 'soften', 0, 0.15, 0.005).onChange(handlers.onGeometryChange);

  const preview = gui.addFolder('Preview');
  preview.add(params, 'showAxes').name('Show interiors').onChange(handlers.onPoseChange);
  preview
    .add(params, 'showSolids')
    .name('Show solid bodies')
    .onChange(() => {
      if (params.planesOnly) {
        params.planesOnly = false;
        params.showSolids = true;
        planesOnlyCtrl.updateDisplay();
      }
      solidsCtrl.updateDisplay();
      handlers.onPoseChange();
    });
  preview
    .add(params, 'solidOpacity', 0.05, 1, 0.01)
    .name('Solid opacity')
    .onChange(handlers.onPoseChange);
  preview.add(params, 'showEnvelopes').onChange(handlers.onGeometryChange);
  preview
    .add(params, 'snapPreview')
    .name('Snap angles')
    .onChange(() => {
      handlers.onPoseChange();
      if (params.layoutMode === 'free') handlers.onGeometryChange();
    });

  const review = gui.addFolder('Part visibility / review');
  const activePartCtrl = review
    .add(params, 'activePart', 0, Math.max(0, params.partCount - 1), 1)
    .name('Active part')
    .onChange(() => {
      params.activePart = Math.max(
        0,
        Math.min(Math.round(params.activePart), params.partCount - 1),
      );
      syncReviewAngleFromPart();
      handlers.onPoseChange();
    });
  const reviewState = {
    angleA: params.parts[params.activePart]?.angleA ?? 0,
    angle: params.parts[params.activePart]?.angle ?? 0,
  };
  function syncReviewAngleFromPart(): void {
    const p = params.parts[params.activePart];
    reviewState.angleA = p?.angleA ?? 0;
    reviewState.angle = p?.angle ?? 0;
    // updateDisplay can spuriously fire onChange on some lil-gui versions;
    // temporarily detach writers so sync cannot overwrite part angles.
    const a = p?.angleA;
    const b = p?.angle;
    reviewAngleACtrl.updateDisplay();
    reviewAngleCtrl.updateDisplay();
    if (p && typeof a === 'number') p.angleA = a;
    if (p && typeof b === 'number') p.angle = b;
  }
  const onAngleAChange = (): void => {
    const p = params.parts[params.activePart];
    if (p) p.angleA = reviewState.angleA;
    handlers.onPoseChange();
    if (params.layoutMode === 'free') handlers.onGeometryChange();
  };
  const onAngleChange = (): void => {
    const p = params.parts[params.activePart];
    if (p) p.angle = reviewState.angle;
    handlers.onPoseChange();
    if (params.layoutMode === 'free') handlers.onGeometryChange();
  };
  const reviewAngleACtrl = review
    .add(reviewState, 'angleA', -180, 180, 1)
    .name('Half A angle°')
    .onChange(onAngleAChange);
  const reviewAngleCtrl = review
    .add(reviewState, 'angle', -180, 180, 1)
    .name('Half B angle°')
    .onChange(onAngleChange);
  review
    .add(
      {
        showAll: () => {
          showAllParts(params);
          rebuildPartFolders();
          handlers.onPoseChange();
        },
      },
      'showAll',
    )
    .name('Show all parts');
  review.open();

  (gui as GUI & { __syncIsolateAngle?: () => void }).__syncIsolateAngle =
    syncReviewAngleFromPart;

  const partsFolder = gui.addFolder('Parts (interior planes)');
  const partFolders: GUI[] = [];

  function rebuildPartFolders(): void {
    ensurePartCount(params);
    for (const f of partFolders) f.destroy();
    partFolders.length = 0;

    params.parts.forEach((part, i) => {
      if (typeof part.visible !== 'boolean') part.visible = true;
      if (typeof part.planeRadius !== 'number') {
        part.planeRadius = params.contactRadius;
      }
      if (typeof part.halfExtentA !== 'number') {
        part.halfExtentA = Math.max(0.15, params.linkLength * 0.5);
      }
      if (typeof part.halfExtentB !== 'number') {
        part.halfExtentB = Math.max(0.15, params.linkLength * 0.5);
      }
      if (typeof part.protrusionTilt !== 'number') {
        part.protrusionTilt = params.protrusionTilt;
      }
      if (typeof part.angle !== 'number') part.angle = 0;
      if (typeof part.angleA !== 'number') part.angleA = 0;
      const f = partsFolder.addFolder(`Part ${i}`);
      partFolders.push(f);
      colorizePartFolder(f, i);

      const soloState = { solo: isPartSoloed(params, i) };
      f.add(soloState, 'solo')
        .name('Solo this part')
        .onChange((on: boolean) => {
          if (on) soloPart(params, i);
          else showAllParts(params);
          syncReviewAngleFromPart();
          rebuildPartFolders();
          handlers.onPoseChange();
        });

      f.add(part, 'symmetryN', { '3': 3, '4': 4, '6': 6 })
        .name('Interior N-fold')
        .onChange((v: string | number) => {
          part.symmetryN = Number(v) as SymmetryN;
          handlers.onGeometryChange();
        });
      f.add(part, 'planeRadius', 0.15, 2.5, 0.05)
        .name('Plane radius')
        .onChange(handlers.onGeometryChange);
      f.add(part, 'halfExtentA', 0.15, 3, 0.05)
        .name('Half A extent')
        .onChange(handlers.onGeometryChange);
      f.add(part, 'halfExtentB', 0.15, 3, 0.05)
        .name('Half B extent')
        .onChange(handlers.onGeometryChange);
      f.add(
        {
          grow: () => {
            growPartPlane(part);
            rebuildPartFolders();
            handlers.onGeometryChange();
          },
        },
        'grow',
      ).name('Grow plane area');
      f.add(part, 'protrusionTilt', -30, 30, 1)
        .name('Protrusion tilt°')
        .onChange(handlers.onGeometryChange);
      f.add(part, 'angleA', -180, 180, 1)
        .name('Half A angle°')
        .onChange(() => {
          (
            gui as GUI & { __syncIsolateAngle?: () => void }
          ).__syncIsolateAngle?.();
          handlers.onPoseChange();
          if (params.layoutMode === 'free') handlers.onGeometryChange();
        });
      f.add(part, 'angle', -180, 180, 1)
        .name('Half B angle°')
        .onChange(() => {
          (
            gui as GUI & { __syncIsolateAngle?: () => void }
          ).__syncIsolateAngle?.();
          handlers.onPoseChange();
          if (params.layoutMode === 'free') handlers.onGeometryChange();
        });

      const pose = f.addFolder('Plane pose (3D)');
      const onPoseGeom = () => {
        if (params.layoutMode === 'chain') params.layoutMode = 'free';
        handlers.onGeometryChange();
      };
      pose.add(part, 'posX', -6, 6, 0.05).name('pos X').onChange(onPoseGeom);
      pose.add(part, 'posY', -6, 6, 0.05).name('pos Y').onChange(onPoseGeom);
      pose.add(part, 'posZ', -6, 6, 0.05).name('pos Z').onChange(onPoseGeom);
      pose.add(part, 'rotX', -180, 180, 1).name('rot X°').onChange(onPoseGeom);
      pose.add(part, 'rotY', -180, 180, 1).name('rot Y°').onChange(onPoseGeom);
      pose.add(part, 'rotZ', -180, 180, 1).name('rot Z°').onChange(onPoseGeom);
      if (params.layoutMode === 'free' || params.layoutMode === 'voronoi') {
        pose.open();
      }
      f.open();
    });
  }

  rebuildPartFolders();

  const io = gui.addFolder('Export / Presets');
  io.add({ export0: () => handlers.onExportPart(0) }, 'export0').name('STL part 1');
  io.add({ export1: () => handlers.onExportPart(1) }, 'export1').name('STL part 2');
  io.add({ export2: () => handlers.onExportPart(2) }, 'export2').name('STL part 3');
  io.add({ exportAll: () => handlers.onExportAll() }, 'exportAll').name('STL all parts');
  io.add({ p1: () => handlers.onPreset('squareStack') }, 'p1').name(
    'Preset: 1× square prism',
  );
  io.add({ p2: () => handlers.onPreset('triSquare') }, 'p2').name(
    'Preset: triangle + square',
  );
  io.add({ p3: () => handlers.onPreset('space3d') }, 'p3').name(
    'Preset: free 3D prisms',
  );
  io.add({ p4: () => handlers.onPreset('voronoiBox') }, 'p4').name(
    'Preset: Voronoi (exp.)',
  );

  (gui as GUI & {
    __refreshMacroSize?: () => void;
    __syncIsolateAngle?: () => void;
    __rebuildPartFolders?: () => void;
  }).__refreshMacroSize = () => {
    macroSizeCtrl.updateDisplay();
  };
  (gui as GUI & { __rebuildPartFolders?: () => void }).__rebuildPartFolders =
    rebuildPartFolders;

  return gui;
}
