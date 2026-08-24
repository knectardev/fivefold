#!/usr/bin/env python3
"""Enumerate Oh-inequivalent L-tromino-void packings of a fixed family inventory.

Default inventory is viewer orbit #20:

  {1:1, 4:1, 7:1, 8:1, 9:1, 10:1, 11:2}

  python solvers/enumerate_inventory_L.py
"""

from __future__ import annotations

import json
from collections import defaultdict
from itertools import product
from pathlib import Path
from time import time

from ortools.sat.python import cp_model

from analyze_packings import describe_solution
from cube_pack import PiecePose, enumerate_families
from perp_no_rect_search import (
    POOL,
    RECTANGLE_PAIRS,
    EXCLUDE_SELF_RECT,
    build_lib,
    canonicalize,
    dump_solutions,
)
from same_inventory_search import all_L_shapes

TARGET = {1: 1, 4: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 2}


def pose_from_json(p) -> PiecePose:
    fulls = tuple(tuple(c) for c in p["cubes"])
    wedges = tuple(
        (
            tuple(w["cell"]),
            ((w["plane"]["kind"], w["plane"]["a"], w["plane"]["b"]), w["side"]),
        )
        for w in p["wedges"]
    )
    return PiecePose(fulls, wedges, "")  # type: ignore[arg-type]


def chosen_from_rep(rep):
    return [
        (int(p["family"]), int(p["joint"]), pose_from_json(p))
        for p in rep["pieces"]
    ]


def main() -> None:
    families = enumerate_families()
    lib = build_lib(families, sorted(TARGET))
    poses = [pl for _, _, pl in lib]
    fam_of = [fi for fi, _, _ in lib]
    ji_of = [ji for _, ji, _ in lib]
    Ls = all_L_shapes()
    print(f"lib={len(lib)} L_shapes={len(Ls)} target={TARGET}", flush=True)

    model = cp_model.CpModel()
    xs = [model.NewBoolVar(f"x{i}") for i in range(len(lib))]
    model.Add(sum(xs) == 8)
    for fi, cnt in TARGET.items():
        terms = [xs[i] for i, f in enumerate(fam_of) if f == fi]
        model.Add(sum(terms) == cnt)

    full_terms = defaultdict(list)
    half_terms = defaultdict(lambda: defaultdict(list))
    for i, pl in enumerate(poses):
        for c in pl.fulls:
            full_terms[c].append(xs[i])
        for c, h in pl.wedges:
            half_terms[c][h].append(xs[i])

    empty_vars = {}
    for c in product(range(3), repeat=3):
        fulls = full_terms.get(c, [])
        halves = half_terms.get(c, {})
        use_full = model.NewBoolVar(f"F{c}")
        if fulls:
            model.Add(sum(fulls) == 1).OnlyEnforceIf(use_full)
            model.Add(sum(fulls) == 0).OnlyEnforceIf(use_full.Not())
        else:
            model.Add(use_full == 0)
        pair_vars = []
        seen_pl = set()
        for h in halves:
            pln = h[0]
            if pln in seen_pl:
                continue
            seen_pl.add(pln)
            t0 = halves.get((pln, 0), [])
            t1 = halves.get((pln, 1), [])
            if not t0 or not t1:
                continue
            pair = model.NewBoolVar(f"P{c}{pln}")
            model.Add(sum(t0) == 1).OnlyEnforceIf(pair)
            model.Add(sum(t1) == 1).OnlyEnforceIf(pair)
            model.Add(sum(t0) == 0).OnlyEnforceIf(pair.Not())
            model.Add(sum(t1) == 0).OnlyEnforceIf(pair.Not())
            pair_vars.append(pair)
        empty = model.NewBoolVar(f"E{c}")
        empty_vars[c] = empty
        model.Add(use_full + sum(pair_vars) + empty == 1)
        for h, terms in halves.items():
            pln = h[0]
            if pln not in seen_pl or not halves.get((pln, 0)) or not halves.get(
                (pln, 1)
            ):
                model.Add(sum(terms) == 0)

    l_bools = []
    for li, L in enumerate(sorted(Ls)):
        b = model.NewBoolVar(f"L{li}")
        l_bools.append(b)
        for c in product(range(3), repeat=3):
            model.Add(empty_vars[c] == (1 if c in L else 0)).OnlyEnforceIf(b)
    model.Add(sum(l_bools) == 1)

    solver = cp_model.CpSolver()
    solver.parameters.enumerate_all_solutions = True
    solver.parameters.num_search_workers = 1
    solver.parameters.max_time_in_seconds = 300.0

    orbits = {}

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
                void = describe_solution(chosen)["empty_cells"]
                joints = [(fi, ji) for fi, ji, _ in chosen]
                print(
                    f"  orbit {len(orbits)} raw={self.raw} void={void} joints={joints}",
                    flush=True,
                )

    cb = CB()
    t0 = time()
    status = solver.Solve(model, cb)
    exhaustive = solver.StatusName(status) == "OPTIMAL"
    print(
        f"status={solver.StatusName(status)} raw={cb.raw} "
        f"orbits={len(orbits)} time={time() - t0:.2f}s exhaustive={exhaustive}",
        flush=True,
    )

    ordered = [orbits[k] for k in sorted(orbits)]
    pinned_from_pool = None

    pool_path = Path(__file__).with_name("perp_no_rect_orbits.json")
    if pool_path.exists():
        pool = json.loads(pool_path.read_text(encoding="utf-8"))
        target_s = {str(k): v for k, v in TARGET.items()}
        for i, rep in enumerate(pool.get("representatives", [])):
            fc = {str(k): int(v) for k, v in (rep.get("family_counts") or {}).items()}
            if fc != target_s:
                continue
            key20 = canonicalize(chosen_from_rep(rep))
            if key20 in orbits:
                # Keep the familiar #20 coordinates as the first representative.
                match = orbits[key20]
                ordered = [match] + [s for s in ordered if canonicalize(s) != key20]
                # Prefer the already-viewed geometry over a rotated canonical form.
                ordered[0] = chosen_from_rep(rep)
                pinned_from_pool = i
                print(f"pinned viewer orbit #{i} as representative 0", flush=True)
            break

    out = Path(__file__).with_name("inventory_20_L_orbits.json")
    dump_solutions(
        ordered,
        out,
        note=(
            "Oh-inequivalent L-tromino-void packings of "
            "{1:1, 4:1, 7:1, 8:1, 9:1, 10:1, 11:2}"
        ),
    )
    payload = json.loads(out.read_text(encoding="utf-8"))
    payload["raw_solutions"] = cb.raw
    payload["exhaustive"] = exhaustive
    payload["symmetry"] = "Oh (24 rotations × reflections = 48)"
    payload["family_counts"] = {str(k): v for k, v in TARGET.items()}
    if pinned_from_pool is not None:
        payload["pinned_from_pool"] = pinned_from_pool
    payload["pool"] = POOL
    payload["exclude_self_rect"] = sorted(EXCLUDE_SELF_RECT)
    payload["rectangle_pairs_banned"] = [list(p) for p in sorted(RECTANGLE_PAIRS)]
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"wrote {out} ({len(ordered)} reps, raw={cb.raw})", flush=True)


if __name__ == "__main__":
    main()
