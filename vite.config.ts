import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));

/** Runtime-fetched orbit dumps live next to the HTML; Vite does not copy them unless emitted. */
function emitSolverOrbitJson(): Plugin {
  const solversDir = resolve(rootDir, 'solvers');
  return {
    name: 'emit-solver-orbit-json',
    generateBundle() {
      for (const name of readdirSync(solversDir)) {
        if (!name.endsWith('.json')) continue;
        this.emitFile({
          type: 'asset',
          fileName: `solvers/${name}`,
          source: readFileSync(resolve(solversDir, name)),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [emitSolverOrbitJson()],
  build: {
    rollupOptions: {
      input: {
        home: resolve(rootDir, 'index.html'),
        chain: resolve(rootDir, 'chain.html'),
        uniqueness: resolve(rootDir, 'uniqueness.html'),
        cubeSphereDissection: resolve(rootDir, 'demos/cube-sphere-dissection.html'),
        cubeRhombicDissection: resolve(rootDir, 'demos/cube-rhombic-dissection.html'),
        cubeTruncatedOctahedron: resolve(rootDir, 'demos/cube-truncated-octahedron-dissection-standalone.html'),
        cubeTruncatedOctahedronStl: resolve(rootDir, 'demos/cube-truncated-octahedron-dissection-standalone-STL.html'),
        weairePhelan: resolve(rootDir, 'demos/test.html'),
        sixPartPuzzle: resolve(rootDir, 'demos/6-PartPuzzle.html'),
        unitPartCatalog: resolve(rootDir, 'demos/unit_part_catalog.html'),
        demosIndex: resolve(rootDir, 'demos/index.html'),
        viewLSolution: resolve(rootDir, 'solvers/view_L_solution.html'),
        viewPerpNoRect: resolve(rootDir, 'solvers/view_perp_no_rect.html'),
        viewCubicJoint: resolve(rootDir, 'solvers/view_cubic_joint.html'),
        dualCubeClosureViewer: resolve(rootDir, 'demos/dual_cube_closure_viewer.html'),
        dualCubePolyhedralViewer: resolve(rootDir, 'demos/dual_cube_polyhedral_viewer.html'),
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
