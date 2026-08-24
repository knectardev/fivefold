#!/usr/bin/env python3
"""Find all 8+L packings with a fixed piece inventory, up to cube Oh symmetry."""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from itertools import product
from pathlib import Path

from ortools.sat.python import cp_model

from analyze_packings import describe_solution
from cube_pack import (
    OH,
    enumerate_families,
    placements_for,
    rot_cell,
    rotate_half_id,
)

TARGET_COUNTS = {0: 2, 1: 1, 3: 1, 5: 1, 7: 1, 10: 1, 12: 1}


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


def digonal_axis(pose):
    a, b = pose.fulls
    d = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    for i in range(3):
        if abs(d[i]) == 1 and d[(i + 1) % 3] == 0 and d[(i + 2) % 3] == 0:
            return i
    return None


def wedge_axis(cube, wcell):
    d = (wcell[0] - cube[0], wcell[1] - cube[1], wcell[2] - cube[2])
    axes = [i for i in range(3) if d[i] != 0]
    return axes[0] if len(axes) == 1 and abs(d[axes[0]]) == 1 else None


def is_allowed(pose):
    ax = digonal_axis(pose)
    if ax is None:
        return False
    (wa, _), (wb, _) = pose.wedges
    fa, fb = pose.fulls
    xa, xb = wedge_axis(fa, wa), wedge_axis(fb, wb)
    if xa is None or xb is None:
        return False
    if xa == ax or xb == ax:
        return False
    if xa != xb:
        return False
    return True


def map_cell_about_center(c, perm, signs):
    cen = (c[0] - 1, c[1] - 1, c[2] - 1)
    r = rot_cell(cen, perm, signs)
    return (r[0] + 1, r[1] + 1, r[2] + 1)


def all_L_shapes():
    base = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    shapes = set()
    for perm, signs in OH_FULL:
        cells = [rot_cell(c, perm, signs) for c in base]
        for ox, oy, oz in product(range(-2, 3), repeat=3):
            shifted = tuple(
                sorted((c[0] + ox, c[1] + oy, c[2] + oz) for c in cells)
            )
            if all(0 <= p[i] < 3 for p in shifted for i in range(3)):
                shapes.add(shifted)
    return shapes


def canonicalize(chosen):
    desc = describe_solution(chosen)
    void0 = [tuple(c) for c in desc["empty_cells"]]
    best = None
    for perm, signs in OH_FULL:
        pieces = []
        for fi, _ji, pl in chosen:
            fulls = tuple(sorted(map_cell_about_center(c, perm, signs) for c in pl.fulls))
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


def main():
    families = enumerate_families()
    lib = []
    seen = set()
    for fi, fam in enumerate(families):
        if fi not in TARGET_COUNTS:
            continue
        for ji, pose in enumerate(fam):
            if not is_allowed(pose):
                continue
            for pl in placements_for(pose, 3):
                if not is_allowed(pl):
                    continue
                key = (
                    tuple(sorted(pl.fulls)),
                    tuple(sorted((c, h) for c, h in pl.wedges)),
                )
                if key in seen:
                    continue
                seen.add(key)
                lib.append((fi, ji, pl))

    print("lib", len(lib), dict(Counter(fi for fi, _, _ in lib)))
    poses = [pl for _, _, pl in lib]
    fam_of = [fi for fi, _, _ in lib]
    Ls = all_L_shapes()
    print("L shapes", len(Ls))

    model = cp_model.CpModel()
    xs = [model.NewBoolVar(f"x{i}") for i in range(len(lib))]
    model.Add(sum(xs) == 8)
    for fi, cnt in TARGET_COUNTS.items():
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

    class CB(cp_model.CpSolverSolutionCallback):
        def __init__(self):
            super().__init__()
            self.sols = []

        def on_solution_callback(self):
            ch = []
            for i, v in enumerate(xs):
                if self.Value(v):
                    ch.append(lib[i])
            self.sols.append(ch)

    cb = CB()
    solver = cp_model.CpSolver()
    solver.parameters.enumerate_all_solutions = True
    solver.parameters.max_time_in_seconds = 600
    solver.parameters.num_search_workers = 1
    status = solver.Solve(model, cb)
    print("status", solver.StatusName(status), "raw solutions", len(cb.sols))

    orbits = {}
    for sol in cb.sols:
        assert Counter(fi for fi, _, _ in sol) == Counter(TARGET_COUNTS)
        key = canonicalize(sol)
        if key not in orbits:
            orbits[key] = sol

    print("inequivalent under Oh (rot+mirror):", len(orbits))

    reps = []
    for i, (_key, sol) in enumerate(orbits.items()):
        d = describe_solution(sol)
        reps.append(
            {
                "id": i,
                "void_L": d["empty_cells"],
                "family_counts": dict(Counter(fi for fi, _, _ in sol)),
                "pieces": [
                    {
                        "family": fi,
                        "joint": ji,
                        "cubes": [list(c) for c in pl.fulls],
                        "wedges": [
                            {
                                "cell": list(c),
                                "plane": {
                                    "kind": h[0][0],
                                    "a": h[0][1],
                                    "b": h[0][2],
                                },
                                "side": h[1],
                            }
                            for c, h in pl.wedges
                        ],
                    }
                    for fi, ji, pl in sol
                ],
            }
        )
        print(f"  orbit {i}: void {d['empty_cells']}")

    out = {
        "inventory": TARGET_COUNTS,
        "raw_solutions": len(cb.sols),
        "inequivalent_orbits": len(orbits),
        "representatives": reps,
    }
    path = Path("same_inventory_orbits.json")
    path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print("wrote", path.resolve())


if __name__ == "__main__":
    main()
