#!/usr/bin/env python3
"""Bounded CP-SAT for dual-interface half-cube splits.

Same-owner splits are forbidden. Cube B occupancy is millivolume cover
using destinations precomputed in JS (so rotation indices match).

Product mode adds:
  - split cap
  - coplanar-adjacent split pairs (sheet proxy)
  - lazy connectivity cuts
  - nogoods on prior disconnected assignments
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict

try:
    from ortools.sat.python import cp_model
except ImportError:
    json.dump({"ok": False, "error": "ortools-not-installed"}, sys.stdout)
    sys.exit(0)


def _first(d, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and k in d and d[k] is not None:
            return d[k]
    return default


def _bool_or(inst, *keys):
    return _first(inst, *keys)


def main() -> None:
    inst = json.loads(open(sys.argv[1], encoding="utf-8").read())
    out_path = sys.argv[2]
    N = inst["N"]
    P = inst["P"]
    n = N * N * N
    labels = inst["labels"]
    dest = _bool_or(inst, "dest", "dest")
    rot_table = _bool_or(inst, "rotationTable", "rotationTable")
    placements = inst["placements"]
    eligible_list = _bool_or(inst, "eligibleCells", "eligibleCells") or []
    eligible = {int(_first(c, "index", "index")): c for c in eligible_list}
    mode = inst.get("mode", "max-splits")
    max_splits = inst.get("maxSplits")
    cuts = inst.get("cuts") or []
    nogoods = inst.get("nogoods") or []
    require_seed = inst.get("requireSeedOwner", True)
    exact_volume = bool(inst.get("exactVolume"))
    min_milli = int(inst.get("minPieceMilli") or 0)
    min_pairs = int(inst.get("minPairs") or 0)
    sheet_mode = mode in ("product", "native")
    time_limit = float(inst.get("timeLimit", 45 if mode == "max-splits" else 60 if mode == "native" else 30))

    model = cp_model.CpModel()
    split = {}
    plane_of = {}
    owner0 = {}
    owner1 = {}
    choice = {}
    full_src: dict[tuple[int, int], list] = defaultdict(list)
    half_src: dict[tuple[int, int, int, int], list] = defaultdict(list)

    for i in range(n):
        if i not in eligible:
            k = labels[i]
            y = dest[k][i]
            if y >= 0:
                full_src[(y, k)].append(None)
            continue

        spec = eligible[i]
        k0 = _first(spec, "owner", "owner")
        allowed = _first(spec, "allowed", "allowed")
        split[i] = model.NewBoolVar(f"s{i}")
        plane_of[i] = model.NewIntVar(0, 5, f"p{i}")
        owner0[i] = model.NewIntVar(0, P - 1, f"o0_{i}")
        owner1[i] = model.NewIntVar(0, P - 1, f"o1_{i}")
        model.Add(owner0[i] != owner1[i]).OnlyEnforceIf(split[i])
        model.AddAllowedAssignments([owner0[i]], [(a,) for a in allowed])
        model.AddAllowedAssignments([owner1[i]], [(a,) for a in allowed])
        model.Add(owner0[i] == k0).OnlyEnforceIf(split[i].Not())
        model.Add(owner1[i] == k0).OnlyEnforceIf(split[i].Not())

        keep = split[i].Not()
        yk = dest[k0][i]
        if yk >= 0:
            full_src[(yk, k0)].append(keep)

        chs = []
        for plane in range(6):
            for a in allowed:
                for b in allowed:
                    if a == b:
                        continue
                    if require_seed and a != k0 and b != k0:
                        continue
                    d0 = dest[a][i]
                    d1 = dest[b][i]
                    if d0 < 0 or d1 < 0:
                        continue
                    ch = model.NewBoolVar(f"ch_{i}_{plane}_{a}_{b}")
                    choice[(i, plane, a, b)] = ch
                    model.Add(plane_of[i] == plane).OnlyEnforceIf(ch)
                    model.Add(owner0[i] == a).OnlyEnforceIf(ch)
                    model.Add(owner1[i] == b).OnlyEnforceIf(ch)
                    model.Add(split[i] == 1).OnlyEnforceIf(ch)
                    h0 = rot_table[placements[a]["r"]][plane * 2]
                    h1 = rot_table[placements[b]["r"]][plane * 2 + 1]
                    p0, s0 = divmod(h0, 2)
                    p1, s1 = divmod(h1, 2)
                    half_src[(d0, p0, s0, a)].append(ch)
                    half_src[(d1, p1, s1, b)].append(ch)
                    chs.append(ch)
        if chs:
            model.Add(sum(chs) == split[i])
        else:
            model.Add(split[i] == 0)

    for y in range(n):
        full_terms = []
        for k in range(P):
            srcs = full_src.get((y, k), [])
            const = sum(1 for s in srcs if s is None)
            bools = [s for s in srcs if s is not None]
            if const == 0 and not bools:
                continue
            ck = model.NewIntVar(0, const + len(bools), f"F_{y}_{k}")
            model.Add(ck == const + (sum(bools) if bools else 0))
            model.Add(ck <= 1)
            full_terms.append(ck)
        F = model.NewIntVar(0, 1, f"Fsum_{y}")
        model.Add(F == (sum(full_terms) if full_terms else 0))

        plane_used = []
        half_terms = []
        for p in range(6):
            side_sum = []
            for side in (0, 1):
                parts = []
                for k in range(P):
                    srcs = half_src.get((y, p, side, k), [])
                    if not srcs:
                        continue
                    hk = model.NewIntVar(0, len(srcs), f"H_{y}_{p}_{side}_{k}")
                    model.Add(hk == sum(srcs))
                    model.Add(hk <= 1)
                    parts.append(hk)
                    half_terms.append(hk)
                ss = model.NewIntVar(0, 1, f"side_{y}_{p}_{side}")
                model.Add(ss == (sum(parts) if parts else 0))
                side_sum.append(ss)
            u = model.NewBoolVar(f"plane_{y}_{p}")
            model.Add(side_sum[0] == u)
            model.Add(side_sum[1] == u)
            plane_used.append(u)

        U = model.NewIntVar(0, 1, f"U_{y}")
        model.Add(U == sum(plane_used))
        model.Add(F + U == 1)
        model.Add(2 * F + (sum(half_terms) if half_terms else 0) == 2)

    if max_splits is not None and split:
        model.Add(sum(split.values()) <= int(max_splits))

    owns = {}
    if sheet_mode or cuts:
        for i, spec in eligible.items():
            k0 = _first(spec, "owner", "owner")
            allowed = _first(spec, "allowed", "allowed")
            for k in allowed:
                owns[(i, k)] = model.NewBoolVar(f"own_{i}_{k}")
                is0 = model.NewBoolVar(f"is0_{i}_{k}")
                is1 = model.NewBoolVar(f"is1_{i}_{k}")
                model.Add(owner0[i] == k).OnlyEnforceIf(is0)
                model.Add(owner0[i] != k).OnlyEnforceIf(is0.Not())
                model.Add(owner1[i] == k).OnlyEnforceIf(is1)
                model.Add(owner1[i] != k).OnlyEnforceIf(is1.Not())
                if k == k0:
                    model.Add(owns[(i, k)] == 1).OnlyEnforceIf(split[i].Not())
                else:
                    model.Add(owns[(i, k)] == 0).OnlyEnforceIf(split[i].Not())
                model.Add(owns[(i, k)] >= is0).OnlyEnforceIf(split[i])
                model.Add(owns[(i, k)] >= is1).OnlyEnforceIf(split[i])
                model.Add(owns[(i, k)] <= is0 + is1).OnlyEnforceIf(split[i])

        def owned(cell, piece):
            if (cell, piece) in owns:
                return owns[(cell, piece)]
            return 1 if labels[cell] == piece else 0

        for cut in cuts:
            k = cut["piece"]
            comp = cut["component"]
            nbrs = cut["neighbors"]
            terms = []
            taut = False
            for i in comp:
                v = owned(i, k)
                if isinstance(v, int):
                    if v == 1:
                        continue
                    taut = True
                    break
                terms.append(v.Not())
            if taut:
                continue
            for j in nbrs:
                v = owned(j, k)
                if isinstance(v, int):
                    if v == 1:
                        taut = True
                        break
                    continue
                terms.append(v)
            if taut or not terms:
                continue
            model.Add(sum(terms) >= 1)

        for ng in nogoods:
            diffs = []
            for i in ng.get("keep", []):
                if i in split:
                    diffs.append(split[i])
            for sp in ng.get("splits", []):
                i = int(_first(sp, "index", "index"))
                if i not in split:
                    continue
                same = model.NewBoolVar(f"ng_{i}_{sp['plane']}_{sp['owners'][0]}_{sp['owners'][1]}")
                model.Add(split[i] == 1).OnlyEnforceIf(same)
                model.Add(plane_of[i] == sp["plane"]).OnlyEnforceIf(same)
                model.Add(owner0[i] == sp["owners"][0]).OnlyEnforceIf(same)
                model.Add(owner1[i] == sp["owners"][1]).OnlyEnforceIf(same)
                diffs.append(same.Not())
            if diffs:
                model.AddBoolOr(diffs)

    pair_count = None
    if sheet_mode and split:
        pairs = []
        cells = sorted(split)
        adj = ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))

        def cell_of(i):
            return (i % N, (i // N) % N, i // (N * N))

        index_of = {i: i for i in cells}
        for i in cells:
            x, y, z = cell_of(i)
            for dx, dy, dz in adj:
                xx, yy, zz = x + dx, y + dy, z + dz
                if not (0 <= xx < N and 0 <= yy < N and 0 <= zz < N):
                    continue
                j = xx + N * (yy + N * zz)
                if j not in index_of or j <= i:
                    continue
                both = model.NewBoolVar(f"both_{i}_{j}")
                model.AddBoolAnd([split[i], split[j]]).OnlyEnforceIf(both)
                model.AddBoolOr([split[i].Not(), split[j].Not(), both])
                same_p = model.NewBoolVar(f"sp_{i}_{j}")
                model.Add(plane_of[i] == plane_of[j]).OnlyEnforceIf(same_p)
                model.Add(plane_of[i] != plane_of[j]).OnlyEnforceIf(same_p.Not())
                pair = model.NewBoolVar(f"pair_{i}_{j}")
                model.AddBoolAnd([both, same_p]).OnlyEnforceIf(pair)
                model.AddBoolOr([both.Not(), same_p.Not(), pair])
                pairs.append(pair)
        split_count = model.NewIntVar(0, len(split), "ns")
        model.Add(split_count == sum(split.values()))
        pair_count = model.NewIntVar(0, max(1, len(pairs)), "np")
        model.Add(pair_count == (sum(pairs) if pairs else 0))
        model.Maximize(1000 * pair_count - split_count)
        if min_pairs:
            model.Add(pair_count >= min_pairs)
    elif split:
        model.Maximize(sum(split.values()))

    if owns and (exact_volume or min_milli):
        target = 2 * (n // P)
        for k in range(P):
            contribs = []
            frozen = 0
            for i in range(n):
                if i not in eligible:
                    if labels[i] == k:
                        frozen += 2
                    continue
                k0 = _first(eligible[i], "owner", "owner")
                c = model.NewIntVar(0, 2, f"vol_{i}_{k}")
                if (i, k) not in owns:
                    model.Add(c == 0)
                    contribs.append(c)
                    continue
                if k == k0:
                    model.Add(c == 2).OnlyEnforceIf(split[i].Not())
                else:
                    model.Add(c == 0).OnlyEnforceIf(split[i].Not())
                model.Add(c == owns[(i, k)]).OnlyEnforceIf(split[i])
                contribs.append(c)
            milli = model.NewIntVar(0, 2 * n, f"milli_{k}")
            model.Add(milli == frozen + (sum(contribs) if contribs else 0))
            if exact_volume:
                model.Add(milli == target)
            if min_milli:
                model.Add(milli >= min_milli)

    for var in split.values():
        model.AddHint(var, 0)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.num_search_workers = 4
    status = solver.Solve(model)
    ok = status in (cp_model.OPTIMAL, cp_model.FEASIBLE)

    states = [None] * n
    splits = []
    if ok:
        for i in range(n):
            if i not in eligible or solver.Value(split[i]) == 0:
                states[i] = {"kind": "full", "owner": labels[i]}
            else:
                p = int(solver.Value(plane_of[i]))
                a = int(solver.Value(owner0[i]))
                b = int(solver.Value(owner1[i]))
                states[i] = {"kind": "split", "plane": p, "owners": [a, b]}
                splits.append({"cellIndex": i, "plane": p, "owners": [a, b]})

    result = {
        "ok": bool(ok),
        "status": int(status),
        "states": states if ok else None,
        "splits": splits,
        "objective": solver.ObjectiveValue() if ok else 0,
        "mode": mode,
    }
    open(out_path, "w", encoding="utf-8").write(json.dumps(result))


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: diagonal_refine_sat.py instance.json out.json", file=sys.stderr)
        sys.exit(2)
    main()
