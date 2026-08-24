#!/usr/bin/env python3
"""
CP-SAT packer for Collection 2 cubic joints into a 3×3×3.

Six volume-4 cubic joints plus a rigid L-tromino *part* (three full cells).
The cube must be completely filled: leftover empty cells are infeasible.

  python solvers/cubic_joint_search.py --census
  python solvers/cubic_joint_search.py --prove-max
  python solvers/cubic_joint_search.py --enumerate6 --l-tromino
"""

from __future__ import annotations

import argparse
import json
import time
from collections import Counter, defaultdict
from itertools import product
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from ortools.sat.python import cp_model

from analyze_packings import describe_solution
from cube_pack import HalfId, rot_cell, rotate_half_id
from cubic_joint import (
    L_TROMINO,
    CubicJointPose,
    census as geometry_census,
    clocks_for_family,
    family_specs,
    make_L_pose,
    occupancy_key,
    placements_for,
)
from perp_no_rect_search import add_cell_cover_constraints
from same_inventory_search import OH_FULL, all_L_shapes, map_cell_about_center

LibEntry = Tuple[str, int, CubicJointPose]


def joint_index(pose: CubicJointPose) -> int:
    ja, jb = pose.clocks
    return ja * 4 + jb


def build_lib(family_ids: Optional[Sequence[str]] = None) -> List[LibEntry]:
    wanted = set(family_ids) if family_ids is not None else None
    lib: List[LibEntry] = []
    seen = set()
    for fam, topology, fa, fb in family_specs():
        if wanted is not None and fam not in wanted:
            continue
        for pose in clocks_for_family(topology, fa, fb):
            ji = joint_index(pose)
            for pl in placements_for(pose, 3):
                key = (fam, occupancy_key(pl))
                if key in seen:
                    continue
                seen.add(key)
                lib.append((fam, ji, pl))
    return lib


_CENSUS_ROWS: Optional[List[Tuple[str, int, int]]] = None


def census_rows() -> List[Tuple[str, int, int]]:
    global _CENSUS_ROWS
    if _CENSUS_ROWS is None:
        _CENSUS_ROWS = geometry_census()
    return _CENSUS_ROWS


def fitting_families() -> List[str]:
    return [fam for fam, _nclk, npl in census_rows() if npl > 0]


def print_census() -> List[str]:
    rows = census_rows()
    fitting = []
    for fam, nclk, npl in rows:
        flag = "" if npl else "  (no in-box placement)"
        print(f"  {fam:10} clocks={nclk:2} placements={npl}{flag}")
        if npl:
            fitting.append(fam)
    print(f"fitting families={len(fitting)}/{len(rows)}")
    return fitting


def prove_max(time_limit: float) -> int:
    pool = fitting_families()
    lib = build_lib(pool)
    print(f"pool={pool}")
    print(f"unique placements={len(lib)}")
    poses = [pl for _, _, pl in lib]

    model = cp_model.CpModel()
    xs = [model.NewBoolVar(f"x{i}") for i in range(len(lib))]
    model.Maximize(sum(xs))
    add_cell_cover_constraints(model, xs, poses, allow_empty=True)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.num_search_workers = 8
    t0 = time.time()
    status = solver.Solve(model)
    print(f"status={solver.StatusName(status)} time={time.time() - t0:.2f}s")
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        val = int(solver.ObjectiveValue())
        print(f"max cubic-joint pieces: {val}")
        return val
    return -1


def canonicalize(chosen: List[LibEntry]):
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
        fp = tuple(sorted(pieces))
        if best is None or fp < best:
            best = fp
    return best


def dump_solutions(
    sols: List[List[LibEntry]],
    path: Path,
    note: str,
    extra: Optional[dict] = None,
) -> None:
    reps = []
    skipped_empty = 0
    for sol in sols:
        desc = describe_solution(sol)
        if desc["empty_cells"]:
            skipped_empty += 1
            continue
        pieces = []
        l_cells = []
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
            entry = {
                "family": fi,
                "topology": pl.topology,
                "faces": list(pl.faces),
                "clocks": list(pl.clocks),
                "joint": ji,
                "cubes": [list(c) for c in pl.fulls],
                "wedges": wedges,
            }
            if fi == L_TROMINO:
                entry["role"] = L_TROMINO
                l_cells = [list(c) for c in pl.fulls]
            pieces.append(entry)
        if not l_cells:
            skipped_empty += 1
            continue
        reps.append(
            {
                "family_counts": dict(Counter(fi for fi, _, _ in sol)),
                "l_tromino": l_cells,
                "pieces": pieces,
            }
        )
    if skipped_empty:
        print(f"dropped {skipped_empty} packings with empty cells (not a 7-piece fill)")
    payload = {
        "pool": fitting_families() + [L_TROMINO],
        "note": note,
        "inequivalent_orbits": len(reps),
        "representatives": reps,
    }
    if extra:
        payload.update(extra)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"wrote {path} ({len(reps)} reps)")


def parse_inventory(spec: str) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        fam, n_s = part.split(":")
        out[fam.strip()] = int(n_s)
    if sum(out.values()) != 6:
        raise SystemExit(f"inventory must total 6 joints, got {out}")
    return out


def enumerate_six(
    time_limit: float,
    limit: int,
    out_path: Path,
    with_L: bool,
    inventory: Optional[Dict[str, int]] = None,
    distinct_families: bool = False,
) -> None:
    pool = list(inventory.keys()) if inventory else fitting_families()
    lib = build_lib(pool)
    inv_note = f" inventory={inventory}" if inventory else ""
    if distinct_families:
        inv_note += " distinct_families"
    print(f"lib={len(lib)} enumerating 6 cubic joints{inv_note} (limit={limit or 'all'})…")
    poses = [pl for _, _, pl in lib]
    fam_of = [fi for fi, _, _ in lib]
    ji_of = [ji for _, ji, _ in lib]

    model = cp_model.CpModel()
    xs = [model.NewBoolVar(f"x{i}") for i in range(len(lib))]
    model.Add(sum(xs) == 6)
    if inventory:
        for fam, cnt in inventory.items():
            terms = [xs[i] for i, f in enumerate(fam_of) if f == fam]
            model.Add(sum(terms) == cnt)
    elif distinct_families:
        for fam in pool:
            terms = [xs[i] for i, f in enumerate(fam_of) if f == fam]
            if terms:
                model.Add(sum(terms) <= 1)

    Ls = list(sorted(all_L_shapes())) if with_L else []
    l_vars = [model.NewBoolVar(f"L{i}") for i in range(len(Ls))]
    if with_L:
        print(f"L_tromino_placements={len(Ls)}", flush=True)
        model.Add(sum(l_vars) == 1)
    else:
        raise SystemExit("empty leftover cells are infeasible; pass --l-tromino")

    full_terms: Dict = defaultdict(list)
    half_terms: Dict = defaultdict(lambda: defaultdict(list))
    for i, pl in enumerate(poses):
        for c in pl.fulls:
            full_terms[c].append(xs[i])
        for c, h in pl.wedges:
            half_terms[c][h].append(xs[i])
    for li, L in enumerate(Ls):
        for c in L:
            full_terms[c].append(l_vars[li])

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
        # Complete fill: every cell is a full cube (joint or L) or a half-pair.
        model.Add(use_full + sum(pair_vars) == 1)
        for h, terms in halves.items():
            pln = h[0]
            if pln not in seen_pl or not halves.get((pln, 0)) or not halves.get(
                (pln, 1)
            ):
                model.Add(sum(terms) == 0)

    solver = cp_model.CpSolver()
    solver.parameters.enumerate_all_solutions = True
    solver.parameters.num_search_workers = 1
    solver.parameters.max_time_in_seconds = time_limit

    orbits: Dict[Tuple, List[LibEntry]] = {}

    class CB(cp_model.CpSolverSolutionCallback):
        def __init__(self):
            super().__init__()
            self.raw = 0
            self.rejected_empty = 0

        def on_solution_callback(self):
            self.raw += 1
            chosen = [
                (fam_of[i], ji_of[i], poses[i])
                for i, v in enumerate(xs)
                if self.Value(v)
            ]
            l_cells = None
            for li, L in enumerate(Ls):
                if self.Value(l_vars[li]):
                    l_cells = L
                    chosen.append((L_TROMINO, 0, make_L_pose(L)))
                    break
            desc = describe_solution(chosen)
            if desc["empty_cells"] or l_cells is None:
                self.rejected_empty += 1
                return
            key = canonicalize(chosen)
            if key not in orbits:
                orbits[key] = chosen
                print(
                    f"  orbit {len(orbits)} raw={self.raw} "
                    f"L={list(l_cells)} "
                    f"types={dict(Counter(fi for fi, _, _ in chosen))}",
                    flush=True,
                )
            if limit and len(orbits) >= limit:
                self.StopSearch()

    cb = CB()
    t0 = time.time()
    status = solver.Solve(model, cb)
    exhaustive = solver.StatusName(status) == "OPTIMAL"
    print(
        f"status={solver.StatusName(status)} raw={cb.raw} "
        f"orbits={len(orbits)} rejected_empty={cb.rejected_empty} "
        f"time={time.time() - t0:.2f}s exhaustive={exhaustive}",
        flush=True,
    )
    dump_solutions(
        [orbits[k] for k in sorted(orbits)],
        out_path,
        note=(
            "Oh-inequivalent complete 7-piece fills of a fixed cubic-joint kit "
            "(analog of the five-solution digonal mix). 6 joints + L-tromino."
            if inventory
            else "Oh-inequivalent complete 7-piece fills: 6 cubic joints + "
            "one rigid L-tromino part. No empty cells."
        ),
        extra={
            "raw_solutions": cb.raw,
            "exhaustive": exhaustive,
            "symmetry": "Oh (24 rotations × reflections = 48)",
            "l_tromino_part": True,
            **({"inventory": dict(inventory)} if inventory else {}),
            **({"distinct_families": True} if distinct_families else {}),
        },
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--census", action="store_true")
    ap.add_argument("--prove-max", action="store_true")
    ap.add_argument("--enumerate6", action="store_true")
    ap.add_argument(
        "--l-tromino",
        "--l-void",
        dest="l_tromino",
        action="store_true",
        help="Require a rigid L-tromino part (complete fill; no empty cells)",
    )
    ap.add_argument("--time", type=float, default=300.0)
    ap.add_argument("--limit", type=int, default=0, help="Stop after this many Oh orbits (0 = no cap)")
    ap.add_argument(
        "--inventory",
        type=str,
        default="",
        help="Fixed kit, e.g. O-F1F1:1,O-F1F2:1,L-F0F2:1,L-F1F2:1,L-F3F3:1,L-F3F4:1",
    )
    ap.add_argument("--out", type=str, default="", help="JSON output path")
    ap.add_argument(
        "--distinct-families",
        action="store_true",
        help="Require the 6 joints to be 6 different families (no duplicate parts)",
    )
    args = ap.parse_args()

    ran = False
    if args.census:
        print_census()
        ran = True
    if args.prove_max:
        prove_max(args.time)
        ran = True
    if args.enumerate6:
        inventory = parse_inventory(args.inventory) if args.inventory else None
        if args.out:
            out = Path(args.out)
        elif inventory:
            out = Path(__file__).with_name("cubic_joint_unique6_orbits.json")
        else:
            out = Path(__file__).with_name("cubic_joint_orbits.json")
        enumerate_six(
            args.time,
            args.limit,
            out,
            with_L=True,
            inventory=inventory,
            distinct_families=args.distinct_families,
        )
        ran = True
    if not ran:
        print("=== census ===")
        print_census()
        print("=== prove max ===")
        mx = prove_max(min(args.time, 60.0))
        if mx == 6:
            print("=== enumerate 6 cubic joints + L-tromino part ===")
            out = Path(__file__).with_name("cubic_joint_orbits.json")
            enumerate_six(args.time, args.limit, out, with_L=True)


if __name__ == "__main__":
    main()
