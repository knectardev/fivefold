#!/usr/bin/env python3
"""Export one orbit from perp_no_rect_orbits.json as a multi-object OBJ."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import List, Sequence, Tuple

import numpy as np
from scipy.spatial import ConvexHull

Point = Tuple[float, float, float]
Tri = Tuple[Point, Point, Point]


def half_corners(plane: dict, side: int) -> List[List[int]]:
    kind, a, b = plane["kind"], plane["a"], plane["b"]
    corners: List[List[int]] = []
    for x in (0, 1):
        for y in (0, 1):
            for z in (0, 1):
                local = [x, y, z]
                u = [2 * v - 1 for v in local]
                val = (u[a] - u[b]) if kind == "eq" else (u[a] + u[b])
                s = 0 if val <= 0 else 1
                if s == side or abs(val) < 1e-9:
                    corners.append(local)
    seen = set()
    out: List[List[int]] = []
    for c in corners:
        k = tuple(c)
        if k not in seen:
            seen.add(k)
            out.append(c)
    return out


def cube_tris(cell: Sequence[int]) -> List[Tri]:
    x, y, z = cell

    def v(i: int, j: int, k: int) -> Point:
        return (x + i, y + j, z + k)

    quads = [
        [v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0)],
        [v(0, 0, 1), v(0, 1, 1), v(1, 1, 1), v(1, 0, 1)],
        [v(0, 0, 0), v(0, 0, 1), v(1, 0, 1), v(1, 0, 0)],
        [v(0, 1, 0), v(1, 1, 0), v(1, 1, 1), v(0, 1, 1)],
        [v(0, 0, 0), v(0, 1, 0), v(0, 1, 1), v(0, 0, 1)],
        [v(1, 0, 0), v(1, 0, 1), v(1, 1, 1), v(1, 1, 0)],
    ]
    tris: List[Tri] = []
    for q in quads:
        tris.append((q[0], q[1], q[2]))
        tris.append((q[0], q[2], q[3]))
    return tris


def wedge_tris(cell: Sequence[int], plane: dict, side: int) -> List[Tri]:
    corners = half_corners(plane, side)
    pts = np.array(
        [(cell[0] + c[0], cell[1] + c[1], cell[2] + c[2]) for c in corners],
        dtype=float,
    )
    hull = ConvexHull(pts)
    return [tuple(map(tuple, pts[s])) for s in hull.simplices]  # type: ignore[return-value]


def is_l_tromino(cells: Sequence[Sequence[int]]) -> bool:
    cells_t = [tuple(c) for c in cells]
    if len(cells_t) != 3:
        return False

    def adj(a, b):
        return sum(abs(a[i] - b[i]) for i in range(3)) == 1

    seen = {0}
    stack = [0]
    while stack:
        i = stack.pop()
        for j, c in enumerate(cells_t):
            if j not in seen and adj(cells_t[i], c):
                seen.add(j)
                stack.append(j)
    if len(seen) != 3:
        return False
    varying = sum(1 for ax in range(3) if len({c[ax] for c in cells_t}) > 1)
    return varying != 1


def write_obj(path: Path, named_tri_sets: List[Tuple[str, List[Tri]]]) -> None:
    lines = ["# cell-puzzle multi-object OBJ", f"# {len(named_tri_sets)} objects"]
    v_off = 0
    for name, tris in named_tri_sets:
        lines.append(f"o {name}")
        verts: List[Point] = []
        index: dict = {}

        def vid(p: Point) -> int:
            key = tuple(round(x, 6) for x in p)
            if key not in index:
                index[key] = len(verts)
                verts.append(key)  # type: ignore[arg-type]
            return index[key]

        faces = []
        for t in tris:
            faces.append([vid(t[0]), vid(t[1]), vid(t[2])])
        for p in verts:
            lines.append(f"v {p[0]} {p[1]} {p[2]}")
        for f in faces:
            a, b, c = [i + v_off + 1 for i in f]
            lines.append(f"f {a} {b} {c}")
        v_off += len(verts)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {path} ({len(named_tri_sets)} objects, {path.stat().st_size} bytes)")


def sol_to_named(sol: dict) -> List[Tuple[str, List[Tri]]]:
    named: List[Tuple[str, List[Tri]]] = []
    for pi, piece in enumerate(sol["pieces"]):
        tris: List[Tri] = []
        for c in piece["cubes"]:
            tris += cube_tris(c)
        for w in piece["wedges"]:
            tris += wedge_tris(w["cell"], w["plane"], w["side"])
        named.append((f"part_{pi}_fam{piece['family']}_j{piece['joint']}", tris))
    if sol.get("void_L"):
        vtris: List[Tri] = []
        for c in sol["void_L"]:
            vtris += cube_tris(c)
        named.append(("void_tromino", vtris))
    return named


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--orbit", type=int, default=None, help="Orbit index")
    ap.add_argument("--l-best", action="store_true", help="Pick L-void with most unique types")
    ap.add_argument(
        "--json",
        type=Path,
        default=Path(__file__).with_name("perp_no_rect_orbits.json"),
    )
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    data = json.loads(args.json.read_text(encoding="utf-8"))
    reps = data["representatives"]

    if args.l_best:
        cands = [(i, r) for i, r in enumerate(reps) if is_l_tromino(r["void_L"])]
        cands.sort(key=lambda ir: -len(ir[1]["family_counts"]))
        if not cands:
            raise SystemExit("no L-tromino voids found")
        idx, sol = cands[0]
    elif args.orbit is not None:
        idx = args.orbit
        sol = reps[idx]
    else:
        idx, sol = 0, reps[0]

    out = args.out or Path(__file__).with_name(f"orbit-{idx}_parts.obj")
    print(
        f"orbit {idx} · unique={len(sol['family_counts'])} · "
        f"void={sol['void_L']} · L={is_l_tromino(sol['void_L'])}"
    )
    write_obj(out, sol_to_named(sol))


if __name__ == "__main__":
    main()
