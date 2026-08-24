#!/usr/bin/env python3
"""
Search digonal packings with perpendicular joints allowed, excluding the
easy 2×3×1 rectangle-forming piece types, and without an L-tromino filler.

Inventory (12 families)
-----------------------
All 15 digonal families except the three that self-pair into a 2×3×1
rectangle with two identical copies: {0, 2, 6}.

  POOL = {1, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14}

All 4 joint snaps are allowed (parallel + perpendicular + axial-on-end).
No parallel-only filter. No L-tromino. Solutions use any 9 of these 12
(or, if the cube is unfillable, we fall back to max / 8-piece packings).

  python solvers/perp_no_rect_search.py
  python solvers/perp_no_rect_search.py --prove-max
  python solvers/perp_no_rect_search.py --scan9
  python solvers/perp_no_rect_search.py --enumerate8 --limit 50
"""

from __future__ import annotations

import argparse
import json
import time
from collections import Counter, defaultdict
from itertools import combinations, product
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Set, Tuple

from ortools.sat.python import cp_model

from analyze_packings import describe_solution
from cube_pack import (
    OH,
    HalfId,
    PiecePose,
    Cell,
    enumerate_families,
    placements_for,
    rot_cell,
    rotate_half_id,
)

# Self-pairing 2×3×1 rectangle families excluded from the pool.
EXCLUDE_SELF_RECT = {0, 2, 6}
POOL = sorted(set(range(15)) - EXCLUDE_SELF_RECT)
assert len(POOL) == 12, POOL

# Family pairs that can jointly fill a 2×3×1 (from exhaustive box scan).
RECTANGLE_PAIRS: Set[Tuple[int, int]] = {
    (0, 0),
    (1, 3),
    (2, 2),
    (5, 10),
    (6, 6),
    (7, 12),
    (8, 8),
    (9, 9),
}


def build_oh_full():
    out = []
    for perm in product([0, 1, 2], repeat=3):
        if len(set(perm)) < 3:
            continue
        for signs in product([-1, 1], repeat=3):
            out.append((perm, signs))
    assert len(out) == 48
    return out


OH_FULL = build_oh_full()


def pose_key(pl: PiecePose) -> Tuple:
    return (
        tuple(sorted(pl.fulls)),
        tuple(sorted((c, h) for c, h in pl.wedges)),
    )


def build_lib(
    families: Sequence[Sequence[PiecePose]],
    family_ids: Sequence[int],
) -> List[Tuple[int, int, PiecePose]]:
    lib: List[Tuple[int, int, PiecePose]] = []
    seen = set()
    for fi in family_ids:
        for ji, pose in enumerate(families[fi]):
            for pl in placements_for(pose, 3):
                key = pose_key(pl)
                if key in seen:
                    continue
                seen.add(key)
                lib.append((fi, ji, pl))
    return lib


def add_cell_cover_constraints(
    model: cp_model.CpModel,
    xs: Sequence[cp_model.IntVar],
    poses: Sequence[PiecePose],
    *,
    allow_empty: bool,
) -> None:
    full_terms: Dict[Cell, List] = defaultdict(list)
    half_terms: Dict[Cell, Dict[HalfId, List]] = defaultdict(lambda: defaultdict(list))
    for i, pl in enumerate(poses):
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


def forbid_rectangle_pair_counts(
    model: cp_model.CpModel,
    xs: Sequence[cp_model.IntVar],
    fam_of: Sequence[int],
) -> None:
    """Ban inventories that include a known 2×3×1-capable family pair."""
    for a, b in RECTANGLE_PAIRS:
        if a not in POOL and b not in POOL:
            continue
        if a == b:
            terms = [xs[i] for i, f in enumerate(fam_of) if f == a]
            if len(terms) >= 2:
                # at most one copy of a self-rectangle family
                model.Add(sum(terms) <= 1)
        else:
            ta = [xs[i] for i, f in enumerate(fam_of) if f == a]
            tb = [xs[i] for i, f in enumerate(fam_of) if f == b]
            if ta and tb:
                # cannot use both families in the same packing
                ua = model.NewBoolVar(f"use_{a}_{b}_a")
                ub = model.NewBoolVar(f"use_{a}_{b}_b")
                model.Add(sum(ta) >= 1).OnlyEnforceIf(ua)
                model.Add(sum(ta) == 0).OnlyEnforceIf(ua.Not())
                model.Add(sum(tb) >= 1).OnlyEnforceIf(ub)
                model.Add(sum(tb) == 0).OnlyEnforceIf(ub.Not())
                model.AddBoolOr([ua.Not(), ub.Not()])


def prove_max(time_limit: float, ban_rect_combos: bool) -> int:
    families = enumerate_families()
    lib = build_lib(families, POOL)
    print(f"pool={POOL}")
    print(f"unique placements={len(lib)}")
    poses = [pl for _, _, pl in lib]
    fam_of = [fi for fi, _, _ in lib]

    model = cp_model.CpModel()
    xs = [model.NewBoolVar(f"x{i}") for i in range(len(lib))]
    model.Maximize(sum(xs))
    add_cell_cover_constraints(model, xs, poses, allow_empty=True)
    if ban_rect_combos:
        forbid_rectangle_pair_counts(model, xs, fam_of)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.num_search_workers = 8
    t0 = time.time()
    status = solver.Solve(model)
    print(f"status={solver.StatusName(status)} time={time.time() - t0:.2f}s")
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        val = int(solver.ObjectiveValue())
        print(f"max digonal pieces in pool: {val}")
        return val
    return -1


def try_nine_subset(
    families: Sequence[Sequence[PiecePose]],
    subset: Sequence[int],
    time_limit: float,
    ban_rect_combos: bool,
) -> Optional[List[Tuple[int, int, PiecePose]]]:
    """Pack exactly these 9 distinct families (one each) into the full cube."""
    lib = build_lib(families, subset)
    poses = [pl for _, _, pl in lib]
    fam_of = [fi for fi, _, _ in lib]
    ji_of = [ji for _, ji, _ in lib]

    model = cp_model.CpModel()
    xs = [model.NewBoolVar(f"x{i}") for i in range(len(lib))]
    for fi in subset:
        terms = [xs[i] for i, f in enumerate(fam_of) if f == fi]
        model.Add(sum(terms) == 1)
    add_cell_cover_constraints(model, xs, poses, allow_empty=False)
    if ban_rect_combos:
        forbid_rectangle_pair_counts(model, xs, fam_of)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.num_search_workers = 8
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None
    chosen = []
    for i, v in enumerate(xs):
        if solver.Value(v):
            chosen.append((fam_of[i], ji_of[i], poses[i]))
    return chosen


def scan_nine(time_limit: float, ban_rect_combos: bool, max_subsets: int) -> None:
    families = enumerate_families()
    subsets = list(combinations(POOL, 9))
    print(f"scanning {min(len(subsets), max_subsets)}/{len(subsets)} 9-subsets…")
    found = 0
    for i, sub in enumerate(subsets[:max_subsets]):
        t0 = time.time()
        sol = try_nine_subset(families, sub, time_limit, ban_rect_combos)
        dt = time.time() - t0
        if sol:
            found += 1
            print(f"  YES {sub} ({dt:.2f}s)")
            out = Path(__file__).with_name("perp_no_rect_9_solution.json")
            dump_solutions([sol], out, note=f"9-subset {sub}")
            return
        if i < 5 or i % 20 == 0:
            print(f"  no {sub} ({dt:.2f}s)")
    print(f"found {found} feasible 9-subsets")


def map_cell_about_center(c, perm, signs):
    cen = (c[0] - 1, c[1] - 1, c[2] - 1)
    r = rot_cell(cen, perm, signs)
    return (r[0] + 1, r[1] + 1, r[2] + 1)


def canonicalize(chosen: List[Tuple[int, int, PiecePose]]):
    desc = describe_solution(chosen)
    void0 = [tuple(c) for c in desc["empty_cells"]]
    best = None
    for perm, signs in OH_FULL:
        pieces = []
        for fi, _ji, pl in chosen:
            fulls = tuple(
                sorted(map_cell_about_center(c, perm, signs) for c in pl.fulls)
            )
            wedges = []
            for c, h in pl.wedges:
                nh = rotate_half_id(h, perm, signs)
                wedges.append(
                    (
                        map_cell_about_center(c, perm, signs),
                        nh[0],
                        nh[1],
                    )
                )
            wedges = tuple(sorted(wedges))
            pieces.append((fi, fulls, wedges))
        void = tuple(sorted(map_cell_about_center(c, perm, signs) for c in void0))
        fp = (void, tuple(sorted(pieces)))
        if best is None or fp < best:
            best = fp
    return best


def enumerate_eight(
    time_limit: float,
    ban_rect_combos: bool,
    limit: int,
    out_path: Path,
) -> None:
    """Enumerate Oh-inequivalent 8-piece packings from the 12-family pool."""
    families = enumerate_families()
    lib = build_lib(families, POOL)
    print(f"lib={len(lib)} enumerating 8-piece packings (limit={limit})…")
    poses = [pl for _, _, pl in lib]
    fam_of = [fi for fi, _, _ in lib]
    ji_of = [ji for _, ji, _ in lib]

    model = cp_model.CpModel()
    xs = [model.NewBoolVar(f"x{i}") for i in range(len(lib))]
    model.Add(sum(xs) == 8)
    add_cell_cover_constraints(model, xs, poses, allow_empty=True)
    if ban_rect_combos:
        forbid_rectangle_pair_counts(model, xs, fam_of)

    # Prefer more distinct types
    # (soft: not needed for enumeration)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.enumerate_all_solutions = True
    solver.parameters.num_search_workers = 1

    orbits: Dict[Tuple, List[Tuple[int, int, PiecePose]]] = {}

    class CB(cp_model.CpSolverSolutionCallback):
        def __init__(self):
            super().__init__()
            self.raw = 0

        def on_solution_callback(self):
            self.raw += 1
            chosen = [
                (fam_of[i], ji_of[i], poses[i])
                for i, v in enumerate(xs)
                if self.Value(v)
            ]
            key = canonicalize(chosen)
            if key not in orbits:
                orbits[key] = chosen
                print(
                    f"  orbit {len(orbits)} raw={self.raw} "
                    f"types={dict(Counter(fi for fi, _, _ in chosen))}"
                )
            if len(orbits) >= limit:
                self.StopSearch()

    cb = CB()
    t0 = time.time()
    status = solver.Solve(model, cb)
    print(
        f"status={solver.StatusName(status)} raw~{cb.raw} "
        f"orbits={len(orbits)} time={time.time() - t0:.2f}s"
    )
    dump_solutions(
        list(orbits.values()),
        out_path,
        note="8-piece packings from 12-family perp pool; no L; rectangle combos banned",
    )


def dump_solutions(
    sols: List[List[Tuple[int, int, PiecePose]]],
    path: Path,
    note: str,
) -> None:
    reps = []
    for sol in sols:
        desc = describe_solution(sol)
        pieces = []
        for fi, ji, pl in sol:
            wedges = []
            for c, h in pl.wedges:
                plane, side = h
                wedges.append(
                    {
                        "cell": list(c),
                        "plane": {"kind": plane[0], "a": plane[1], "b": plane[2]},
                        "side": side,
                    }
                )
            pieces.append(
                {
                    "family": fi,
                    "joint": ji,
                    "cubes": [list(c) for c in pl.fulls],
                    "wedges": wedges,
                }
            )
        reps.append(
            {
                "family_counts": dict(Counter(fi for fi, _, _ in sol)),
                "void_L": [list(c) for c in desc["empty_cells"]],
                "pieces": pieces,
            }
        )
    payload = {
        "pool": POOL,
        "exclude_self_rect": sorted(EXCLUDE_SELF_RECT),
        "rectangle_pairs_banned": [list(p) for p in sorted(RECTANGLE_PAIRS)],
        "note": note,
        "inequivalent_orbits": len(reps),
        "representatives": reps,
    }
    path.write_text(json.dumps(payload, indent=2))
    print(f"wrote {path} ({len(reps)} reps)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prove-max", action="store_true")
    ap.add_argument("--scan9", action="store_true")
    ap.add_argument("--enumerate8", action="store_true")
    ap.add_argument("--time", type=float, default=30.0)
    ap.add_argument("--limit", type=int, default=48)
    ap.add_argument("--max-subsets", type=int, default=220)
    ap.add_argument(
        "--allow-rect-combos",
        action="store_true",
        help="Do not ban known 2×3×1 family-pair combinations",
    )
    args = ap.parse_args()
    ban = not args.allow_rect_combos

    if args.prove_max:
        prove_max(args.time, ban)
        return
    if args.scan9:
        scan_nine(args.time, ban, args.max_subsets)
        return
    if args.enumerate8:
        out = Path(__file__).with_name("perp_no_rect_orbits.json")
        enumerate_eight(args.time, ban, args.limit, out)
        return

    # Default: prove max, try a few 9-subsets, then enumerate 8-piece orbits.
    print("=== prove max ===")
    mx = prove_max(min(args.time, 60.0), ban)
    print("=== scan 9-subsets ===")
    scan_nine(min(args.time, 20.0), ban, max_subsets=min(40, args.max_subsets))
    if mx <= 8:
        print("=== enumerate 8-piece orbits for viewer ===")
        out = Path(__file__).with_name("perp_no_rect_orbits.json")
        enumerate_eight(args.time, ban, args.limit, out)


if __name__ == "__main__":
    main()
