#!/usr/bin/env python3
"""
CP-SAT packer for nine digonal module-pair pieces into a 3×3×3.

Uses the same geometry as cube_pack.py (cube + half-cube wedges).

  python solvers/cube_pack_sat.py
  python solvers/cube_pack_sat.py --offset 0 --time 60
"""

from __future__ import annotations

import argparse
import time
from collections import defaultdict
from itertools import product
from typing import Dict, List, Optional, Tuple

from ortools.sat.python import cp_model

from cube_pack import (
    Cell,
    HalfId,
    PiecePose,
    complement,
    enumerate_families,
    normalize_pose,
    placements_for,
)


def cell_id(c: Cell) -> int:
    return c[0] + 3 * c[1] + 9 * c[2]


def half_key(c: Cell, h: HalfId) -> Tuple:
    return (c, h[0], h[1])


def pick_nine(families, offset: int = 0):
    rich = [f for f in families if len({normalize_pose(p) for p in f}) == 4]
    fit = []
    for f in rich:
        pls = sum(len(placements_for(p, 3)) for p in f)
        if pls > 0:
            fit.append(f)
    if len(fit) < 9:
        raise SystemExit(f"only {len(fit)} fitting families")
    return fit[offset : offset + 9]


def build_and_solve(nine: List[List[PiecePose]], time_limit: float) -> Optional[List]:
    # placements[pi] = list of PiecePose (all joints × orients × translations)
    placements: List[List[PiecePose]] = []
    for fam in nine:
        opts: List[PiecePose] = []
        seen = set()
        for pose in fam:
            for pl in placements_for(pose, 3):
                key = (
                    tuple(sorted(pl.fulls)),
                    tuple(sorted((c, h) for c, h in pl.wedges)),
                )
                if key not in seen:
                    seen.add(key)
                    opts.append(pl)
        placements.append(opts)
        print(f"  piece options: {len(opts)}")

    model = cp_model.CpModel()

    # x[pi][k] = piece pi uses placement k
    x: List[List[cp_model.IntVar]] = []
    for pi, opts in enumerate(placements):
        vars_pi = [model.NewBoolVar(f"p{pi}_{k}") for k in range(len(opts))]
        model.Add(sum(vars_pi) == 1)
        x.append(vars_pi)

    # For each cell, classify contributions
    # full_cov[c] = sum of placements that put a full cube on c
    # half_cov[c][(plane,side)] = sum of placements that put that half on c
    full_terms: Dict[Cell, List[cp_model.IntVar]] = defaultdict(list)
    half_terms: Dict[Cell, Dict[HalfId, List[cp_model.IntVar]]] = defaultdict(
        lambda: defaultdict(list)
    )

    for pi, opts in enumerate(placements):
        for k, pl in enumerate(opts):
            v = x[pi][k]
            for c in pl.fulls:
                full_terms[c].append(v)
            for c, h in pl.wedges:
                half_terms[c][h].append(v)

    cells = list(product(range(3), repeat=3))
    for c in cells:
        fulls = full_terms.get(c, [])
        halves = half_terms.get(c, {})

        # Exactly one of: one full, OR a complementary half-pair.
        use_full = model.NewBoolVar(f"full_{c}")
        if fulls:
            model.Add(sum(fulls) == 1).OnlyEnforceIf(use_full)
            model.Add(sum(fulls) == 0).OnlyEnforceIf(use_full.Not())
        else:
            model.Add(use_full == 0)

        # Possible complementary pair modes for this cell
        pair_vars = []
        seen_planes = set()
        for h in halves:
            pln = h[0]
            if pln in seen_planes:
                continue
            seen_planes.add(pln)
            h0: HalfId = (pln, 0)
            h1: HalfId = (pln, 1)
            t0 = halves.get(h0, [])
            t1 = halves.get(h1, [])
            if not t0 or not t1:
                continue
            pair = model.NewBoolVar(f"pair_{c}_{pln}")
            # When pair active: exactly one side0 and one side1 contribution
            model.Add(sum(t0) == 1).OnlyEnforceIf(pair)
            model.Add(sum(t1) == 1).OnlyEnforceIf(pair)
            model.Add(sum(t0) == 0).OnlyEnforceIf(pair.Not())
            model.Add(sum(t1) == 0).OnlyEnforceIf(pair.Not())
            pair_vars.append(pair)

        # No stray halves when using full or inactive pairs:
        # every half contribution must be part of the chosen pair or none
        # Enforced by: use_full + sum(pairs) == 1, and when not pair, that plane's halves=0
        model.Add(use_full + sum(pair_vars) == 1)

        # Halves on planes without a pair var must be zero
        for h, terms in halves.items():
            pln, side = h
            if pln not in seen_planes or not halves.get((pln, 0)) or not halves.get(
                (pln, 1)
            ):
                model.Add(sum(terms) == 0)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.num_search_workers = 8
    print("solving…")
    t0 = time.time()
    status = solver.Solve(model)
    print(f"status={solver.StatusName(status)} time={time.time()-t0:.2f}s")

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None

    result = []
    for pi, opts in enumerate(placements):
        for k, pl in enumerate(opts):
            if solver.Value(x[pi][k]):
                result.append((pi, pl))
                break
    return result


def prove_max_pieces(time_limit: float) -> None:
    """Show the maximum number of digonal pieces that can be placed at once."""
    families = enumerate_families()
    lib: List[PiecePose] = []
    seen = set()
    for fam in families:
        for pose in fam:
            for pl in placements_for(pose, 3):
                key = (
                    tuple(sorted(pl.fulls)),
                    tuple(sorted((c, h) for c, h in pl.wedges)),
                )
                if key not in seen:
                    seen.add(key)
                    lib.append(pl)
    print(f"unique placements={len(lib)}")

    model = cp_model.CpModel()
    xs = [model.NewBoolVar(f"x{i}") for i in range(len(lib))]
    model.Maximize(sum(xs))

    full_terms: Dict[Cell, List] = defaultdict(list)
    half_terms: Dict[Cell, Dict[HalfId, List]] = defaultdict(lambda: defaultdict(list))
    for i, pl in enumerate(lib):
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
        empty = model.NewBoolVar(f"empty_{c}")
        model.Add(use_full + sum(pair_vars) + empty == 1)
        for h, terms in halves.items():
            pln = h[0]
            if pln not in seen_planes or not halves.get((pln, 0)) or not halves.get(
                (pln, 1)
            ):
                model.Add(sum(terms) == 0)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.num_search_workers = 8
    status = solver.Solve(model)
    print(f"status={solver.StatusName(status)}")
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        print(f"max digonal pieces with valid half-completion: {int(solver.ObjectiveValue())}")
        print("=> 9 pieces cannot fill a 3×3×3 under the digonal model.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--time", type=float, default=120.0)
    ap.add_argument("--scan", action="store_true", help="Try many 9-subsets")
    ap.add_argument(
        "--prove-max",
        action="store_true",
        help="Prove max placeable digonal pieces (expect 8)",
    )
    args = ap.parse_args()

    if args.prove_max:
        prove_max_pieces(args.time)
        return

    print("enumerating families…")
    families = enumerate_families()
    print(f"families={len(families)}")

    if args.scan:
        rich = [
            f
            for f in families
            if len({normalize_pose(p) for p in f}) == 4
            and sum(len(placements_for(p, 3)) for p in f) > 0
        ]
        print(f"fitting rich families={len(rich)}")
        from itertools import combinations

        for idxs in combinations(range(len(rich)), 9):
            nine = [rich[i] for i in idxs]
            print(f"\n=== subset {idxs} ===")
            sol = build_and_solve(nine, args.time)
            if sol:
                print("SOLUTION FOUND")
                for pi, pl in sol:
                    print(
                        f"  piece {pi}: cubes={pl.fulls} wedges={[c for c,_ in pl.wedges]}"
                    )
                return
        print("No subset found a solution within time limits.")
        return

    nine = pick_nine(families, args.offset)
    print(f"packing 9 families (offset={args.offset})")
    sol = build_and_solve(nine, args.time)
    if sol is None:
        print("NO SOLUTION / UNKNOWN")
    else:
        print("SOLUTION FOUND")
        for pi, pl in sol:
            print(f"  piece {pi}: cubes={pl.fulls} wedges={[c for c,_ in pl.wedges]}")


if __name__ == "__main__":
    main()
