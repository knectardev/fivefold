#!/usr/bin/env python3
"""
Analyze digonal packings:
  - Find 8-piece solutions and describe the leftover void (volume 3)
  - Test whether copies of k piece types can fill the full 3×3×3

  python solvers/analyze_packings.py
  python solvers/analyze_packings.py --enumerate-8 20
  python solvers/analyze_packings.py --fill-with-copies
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from itertools import combinations, product
from typing import Dict, List, Optional, Set, Tuple

from ortools.sat.python import cp_model

from cube_pack import (
    Cell,
    HalfId,
    PiecePose,
    enumerate_families,
    normalize_pose,
    placements_for,
)


def unique_placements(families) -> List[Tuple[int, int, PiecePose]]:
    """(family_id, joint_id, pose) unique by occupancy."""
    out = []
    seen = set()
    for fi, fam in enumerate(families):
        for ji, pose in enumerate(fam):
            for pl in placements_for(pose, 3):
                key = (
                    tuple(sorted(pl.fulls)),
                    tuple(sorted((c, h) for c, h in pl.wedges)),
                )
                if key in seen:
                    continue
                seen.add(key)
                out.append((fi, ji, pl))
    return out


def build_cell_constraints(model, xs, lib_poses, allow_empty: bool):
    full_terms: Dict[Cell, List] = defaultdict(list)
    half_terms: Dict[Cell, Dict[HalfId, List]] = defaultdict(lambda: defaultdict(list))
    for i, pl in enumerate(lib_poses):
        for c in pl.fulls:
            full_terms[c].append(xs[i])
        for c, h in pl.wedges:
            half_terms[c][h].append(xs[i])

    for c in product(range(3), repeat=3):
        fulls = full_terms.get(c, [])
        halves = half_terms.get(c, {})
        use_full = model.NewBoolVar(f"full_{c}")
        if fulls:
            model.Add(sum(fulls) == 1).OnlyEnforceIf(use_full)
            model.Add(sum(fulls) == 0).OnlyEnforceIf(use_full.Not())
        else:
            model.Add(use_full == 0)

        pair_vars = []
        seen_planes = set()
        for h in halves:
            pln = h[0]
            if pln in seen_planes:
                continue
            seen_planes.add(pln)
            t0 = halves.get((pln, 0), [])
            t1 = halves.get((pln, 1), [])
            if not t0 or not t1:
                continue
            pair = model.NewBoolVar(f"pair_{c}_{pln}")
            model.Add(sum(t0) == 1).OnlyEnforceIf(pair)
            model.Add(sum(t1) == 1).OnlyEnforceIf(pair)
            model.Add(sum(t0) == 0).OnlyEnforceIf(pair.Not())
            model.Add(sum(t1) == 0).OnlyEnforceIf(pair.Not())
            pair_vars.append(pair)

        if allow_empty:
            empty = model.NewBoolVar(f"empty_{c}")
            model.Add(use_full + sum(pair_vars) + empty == 1)
        else:
            model.Add(use_full + sum(pair_vars) == 1)

        for h, terms in halves.items():
            pln = h[0]
            if pln not in seen_planes or not halves.get((pln, 0)) or not halves.get(
                (pln, 1)
            ):
                model.Add(sum(terms) == 0)


def neighbors(c: Cell) -> List[Cell]:
    x, y, z = c
    out = []
    for d in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
        n = (x + d[0], y + d[1], z + d[2])
        if all(0 <= n[i] < 3 for i in range(3)):
            out.append(n)
    return out


def void_components(empty: Set[Cell]) -> List[List[Cell]]:
    seen = set()
    comps = []
    for c in sorted(empty):
        if c in seen:
            continue
        stack = [c]
        seen.add(c)
        comp = []
        while stack:
            u = stack.pop()
            comp.append(u)
            for v in neighbors(u):
                if v in empty and v not in seen:
                    seen.add(v)
                    stack.append(v)
        comps.append(sorted(comp))
    return comps


def describe_solution(chosen: List[Tuple[int, int, PiecePose]]) -> dict:
    occupied_full = set()
    half_cells = set()
    for _, _, pl in chosen:
        occupied_full.update(pl.fulls)
        for c, _ in pl.wedges:
            half_cells.add(c)

    # Cells that ended as paired halves (wedge targets not also full)
    paired = {c for c in half_cells if c not in occupied_full}
    filled = occupied_full | paired
    empty = {c for c in product(range(3), repeat=3) if c not in filled}
    comps = void_components(empty)

    return {
        "n_pieces": len(chosen),
        "volume_filled": len(chosen) * 3,
        "full_cells": sorted(occupied_full),
        "paired_half_cells": sorted(paired),
        "empty_cells": sorted(empty),
        "void_volume": len(empty),
        "void_components": comps,
        "void_is_connected": len(comps) <= 1,
        "pieces": [
            {
                "family": fi,
                "joint": ji,
                "cubes": list(pl.fulls),
                "wedges": [list(c) for c, _ in pl.wedges],
            }
            for fi, ji, pl in chosen
        ],
    }


class SolutionCollector(cp_model.CpSolverSolutionCallback):
    def __init__(self, xs, lib, limit: int):
        super().__init__()
        self.xs = xs
        self.lib = lib
        self.limit = limit
        self.solutions: List[List[Tuple[int, int, PiecePose]]] = []

    def on_solution_callback(self):
        chosen = []
        for i, v in enumerate(self.xs):
            if self.Value(v):
                chosen.append(self.lib[i])
        self.solutions.append(chosen)
        if len(self.solutions) >= self.limit:
            self.StopSearch()


def find_eight_piece_solutions(lib, limit: int, time_limit: float):
    poses = [pl for _, _, pl in lib]
    model = cp_model.CpModel()
    xs = [model.NewBoolVar(f"x{i}") for i in range(len(lib))]
    model.Add(sum(xs) == 8)
    build_cell_constraints(model, xs, poses, allow_empty=True)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.num_search_workers = 8
    solver.parameters.enumerate_all_solutions = True
    cb = SolutionCollector(xs, lib, limit)
    status = solver.Solve(model, cb)
    return solver.StatusName(status), cb.solutions


def try_fill_with_type_subset(
    families, type_ids: Tuple[int, ...], time_limit: float
) -> str:
    """Allow unlimited copies of the given family ids; require full fill (9 pieces)."""
    lib = []
    seen = set()
    for fi in type_ids:
        fam = families[fi]
        for ji, pose in enumerate(fam):
            for pl in placements_for(pose, 3):
                key = (
                    tuple(sorted(pl.fulls)),
                    tuple(sorted((c, h) for c, h in pl.wedges)),
                )
                if key in seen:
                    continue
                seen.add(key)
                lib.append(pl)

    if not lib:
        return "NO_PLACEMENTS"

    model = cp_model.CpModel()
    xs = [model.NewBoolVar(f"x{i}") for i in range(len(lib))]
    model.Add(sum(xs) == 9)
    build_cell_constraints(model, xs, lib, allow_empty=False)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.num_search_workers = 8
    status = solver.Solve(model)
    return solver.StatusName(status)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--enumerate-8", type=int, default=5, help="Max 8-piece solutions to collect")
    ap.add_argument("--time", type=float, default=120.0)
    ap.add_argument("--fill-with-copies", action="store_true")
    ap.add_argument("--skip-8", action="store_true")
    args = ap.parse_args()

    print("enumerating families…")
    families = enumerate_families()
    rich = [
        f
        for f in families
        if len({normalize_pose(p) for p in f}) == 4
        and sum(len(placements_for(p, 3)) for p in f) > 0
    ]
    print(f"fitting 4-joint families: {len(rich)}")

    lib = unique_placements(rich)
    print(f"unique labeled placements: {len(lib)}")

    if not args.skip_8:
        print(f"\n=== Finding up to {args.enumerate_8} solutions with exactly 8 pieces ===")
        status, sols = find_eight_piece_solutions(lib, args.enumerate_8, args.time)
        print(f"solver status: {status}; collected: {len(sols)}")
        print(
            "Note: this is enumeration up to the limit / time, not a proof that "
            "all 8-piece solutions were found unless status=OPTIMAL and search finished."
        )

        void_patterns = defaultdict(int)
        for i, sol in enumerate(sols):
            desc = describe_solution(sol)
            key = (
                tuple(desc["empty_cells"]),
                tuple(tuple(map(tuple, c)) for c in desc["void_components"]),
            )
            void_patterns[key] += 1
            print(f"\n--- 8-piece solution {i} ---")
            print(f"  empty cells (void vol={desc['void_volume']}): {desc['empty_cells']}")
            print(f"  void connected: {desc['void_is_connected']}")
            print(f"  components ({len(desc['void_components'])}): {desc['void_components']}")
            print(f"  families used: {sorted(p['family'] for p in desc['pieces'])}")
            # write one detailed JSON
            if i == 0:
                from pathlib import Path

                path = Path(__file__).resolve().parent / "eight_piece_example.json"
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(desc, f, indent=2)
                print(f"  wrote {path}")

        print(f"\nDistinct void patterns among collected solutions: {len(void_patterns)}")
        for (empty, comps), n in void_patterns.items():
            print(f"  count={n} empty={list(empty)} comps={len(comps)}")

    if args.fill_with_copies:
        print("\n=== Full cube with copies of k types ===")
        # Strong result already: max pieces overall is 8, so full fill with any
        # multiset of digonal pieces is impossible. Still report per subset size
        # for clarity, and confirm INFEASIBLE quickly on small subsets.
        print(
            "Background: global max placeable digonal pieces with half-completion is 8,\n"
            "so any multiset aiming for 9 pieces / full cube is impossible under this model.\n"
            "Verifying a few type-subsets explicitly…"
        )
        # Test singletons and a few pairs
        for k in (1, 2):
            for ids in combinations(range(len(rich)), k):
                st = try_fill_with_type_subset(rich, ids, time_limit=min(30.0, args.time))
                print(f"  types {ids} -> {st}")
                # After a handful, stop; the rest follow from max=8
                if k == 1 and ids[0] >= 2:
                    break
            if k == 2:
                # just first few pairs
                break


if __name__ == "__main__":
    main()
