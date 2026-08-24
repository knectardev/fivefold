#!/usr/bin/env python3
"""
Cubic-joint occupancy for Collection 2 (lavender cube + two gray modules).

A cubic joint is three full cells (lavender + two gray cubes) and two
triangular-prism halves. Families are the 30 catalog IDs: 15 unordered
F0–F4 pairs on opposite (O-/I) or adjacent (L-) lavender faces, each with
16 independent quarter-turn clocks.

  python solvers/cubic_joint.py --check
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass
from itertools import product
from typing import Dict, List, Optional, Sequence, Tuple

from cube_pack import (
    OH,
    Cell,
    HalfId,
    complement,
    identify_half,
    in_box,
    rot_cell,
    rotate_half_id,
)

Vec = Tuple[float, float, float]

FACE_IDS: Tuple[str, ...] = ("F0", "F1", "F2", "F3", "F4")

# Intrinsic gray-module frame: S along slope low→high, E toward the wedge, T along prism ends.
GRAY_FACES: Dict[str, Tuple[Vec, Vec]] = {
    # (normal, tangent) matching demos/unit_part_catalog.html
    "F0": ((0.0, -1.0, 0.0), (1.0, 0.0, 0.0)),
    "F1": ((-1.0, 0.0, 0.0), (0.0, 1.0, 0.0)),
    "F2": ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0)),
    "F3": ((0.0, 0.0, -1.0), (1.0, 0.0, 0.0)),
    "F4": ((0.0, 0.0, 1.0), (1.0, 0.0, 0.0)),
}


def vadd(a: Vec, b: Vec) -> Vec:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def vmul(a: Vec, s: float) -> Vec:
    return (a[0] * s, a[1] * s, a[2] * s)


def vdot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def vcross(a: Vec, b: Vec) -> Vec:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def round_cell(v: Vec) -> Cell:
    return (int(round(v[0])), int(round(v[1])), int(round(v[2])))


def rot90_about(v: Vec, axis: Vec) -> Vec:
    """Rodrigues 90°: v' = axis×v + axis (axis·v)."""
    cx = vcross(axis, v)
    udot = vdot(axis, v)
    return (cx[0] + axis[0] * udot, cx[1] + axis[1] * udot, cx[2] + axis[2] * udot)


def rotate_about(v: Vec, axis: Vec, k: int) -> Vec:
    out = v
    for _ in range(k % 4):
        out = rot90_about(out, axis)
    return out


def arm_basis(topology: str, arm: str) -> Tuple[Vec, Vec]:
    """Return (u, r0) for a gray arm. u points from lavender center to gray center."""
    if topology == "I" and arm == "A":
        return (-1.0, 0.0, 0.0), (0.0, 0.0, 1.0)
    if topology == "I":
        return (1.0, 0.0, 0.0), (0.0, 0.0, 1.0)
    if arm == "A":
        return (1.0, 0.0, 0.0), (0.0, 0.0, 1.0)
    return (0.0, 1.0, 0.0), (0.0, 0.0, -1.0)


def oriented_module(topology: str, arm: str, face_id: str, clock: int) -> Tuple[Vec, Vec, Vec, Vec]:
    """Port of orientedModuleCG + quarter-turn about u. Returns (u, s, e, t)."""
    u, r0 = arm_basis(topology, arm)
    n, tan = GRAY_FACES[face_id]
    third = vcross(n, tan)
    target_n = vmul(u, -1.0)
    target_tan = r0
    target_third = vcross(target_n, target_tan)

    def mapped(vec: Vec) -> Vec:
        return vadd(
            vadd(vmul(target_n, vdot(vec, n)), vmul(target_tan, vdot(vec, tan))),
            vmul(target_third, vdot(vec, third)),
        )

    s = rotate_about(mapped((1.0, 0.0, 0.0)), u, clock)
    e = rotate_about(mapped((0.0, 1.0, 0.0)), u, clock)
    t = rotate_about(mapped((0.0, 0.0, 1.0)), u, clock)
    return u, s, e, t


def cell_of_catalog_center(p: Vec) -> Cell:
    """Catalog origin is the lavender cube center; pack cells are [i,i+1)."""
    return (
        int(math.floor(p[0] + 0.5)),
        int(math.floor(p[1] + 0.5)),
        int(math.floor(p[2] + 0.5)),
    )


def wedge_half(u: Vec, s: Vec, e: Vec) -> Tuple[Cell, HalfId]:
    """Wedge cell along +e and HalfId from an interior prism point (off the diagonal toward +s)."""
    gray = cell_of_catalog_center(u)
    wedge_center = vadd(u, e)
    wedge_cell = cell_of_catalog_center(wedge_center)
    # Interior of the kept half-cube: not the wedge-cell center (that sits on the cut).
    probe_cat = vadd(u, vadd(vmul(s, 0.35), vmul(e, 0.75)))
    probe_pack = vadd(probe_cat, (0.5, 0.5, 0.5))
    local = (
        probe_pack[0] - wedge_cell[0],
        probe_pack[1] - wedge_cell[1],
        probe_pack[2] - wedge_cell[2],
    )
    if not all(0.02 < local[i] < 0.98 for i in range(3)):
        raise RuntimeError(
            f"wedge probe not interior to cell {wedge_cell}: local={local} gray={gray} e={e}"
        )
    return wedge_cell, identify_half(local)


@dataclass(frozen=True)
class CubicJointPose:
    fulls: Tuple[Cell, ...]
    wedges: Tuple[Tuple[Cell, HalfId], ...]
    family: str
    topology: str
    faces: Tuple[str, ...]
    clocks: Tuple[int, ...]
    name: str


L_TROMINO = "L-tromino"


def make_L_pose(cells: Sequence[Cell]) -> CubicJointPose:
    """Rigid bent tromino: three full cells, no wedges, no joint."""
    fulls = tuple(sorted(tuple(c) for c in cells))
    return CubicJointPose(fulls, tuple(), L_TROMINO, "tromino", tuple(), tuple(), L_TROMINO)


def family_id(prefix: str, face_a: str, face_b: str) -> str:
    return f"{prefix}-{face_a}{face_b}"


def family_specs() -> List[Tuple[str, str, str, str]]:
    """(family_id, topology I/L, face_a, face_b) for all 30 catalog families."""
    out: List[Tuple[str, str, str, str]] = []
    for topology, prefix in (("I", "O"), ("L", "L")):
        for i, fa in enumerate(FACE_IDS):
            for fb in FACE_IDS[i:]:
                out.append((family_id(prefix, fa, fb), topology, fa, fb))
    assert len(out) == 30, len(out)
    return out


def make_pose(
    topology: str,
    face_a: str,
    face_b: str,
    clock_a: int,
    clock_b: int,
) -> Optional[CubicJointPose]:
    prefix = "O" if topology == "I" else "L"
    fam = family_id(prefix, face_a, face_b)
    ua, sa, ea, _ta = oriented_module(topology, "A", face_a, clock_a)
    ub, sb, eb, _tb = oriented_module(topology, "B", face_b, clock_b)
    lavender: Cell = (0, 0, 0)
    gray_a = cell_of_catalog_center(ua)
    gray_b = cell_of_catalog_center(ub)
    fulls = (lavender, gray_a, gray_b)
    if len(set(fulls)) < 3:
        return None
    wa, ha = wedge_half(ua, sa, ea)
    wb, hb = wedge_half(ub, sb, eb)
    if wa in fulls or wb in fulls:
        return None
    if wa == wb and complement(ha) != hb:
        return None
    name = f"{fam}_c{clock_a}{clock_b}"
    return CubicJointPose(
        fulls,
        ((wa, ha), (wb, hb)),
        fam,
        topology,
        (face_a, face_b),
        (clock_a % 4, clock_b % 4),
        name,
    )


def rotate_pose(pose: CubicJointPose, perm, signs) -> CubicJointPose:
    fulls = tuple(rot_cell(c, perm, signs) for c in pose.fulls)
    wedges = tuple(
        (rot_cell(c, perm, signs), rotate_half_id(h, perm, signs))
        for c, h in pose.wedges
    )
    return CubicJointPose(
        fulls,  # type: ignore[arg-type]
        wedges,  # type: ignore[arg-type]
        pose.family,
        pose.topology,
        pose.faces,
        pose.clocks,
        pose.name,
    )


def shift_pose(pose: CubicJointPose, origin: Cell) -> CubicJointPose:
    ox, oy, oz = origin
    fulls = tuple((c[0] + ox, c[1] + oy, c[2] + oz) for c in pose.fulls)
    wedges = tuple(
        ((c[0] + ox, c[1] + oy, c[2] + oz), h) for c, h in pose.wedges
    )
    return CubicJointPose(
        fulls,  # type: ignore[arg-type]
        wedges,  # type: ignore[arg-type]
        pose.family,
        pose.topology,
        pose.faces,
        pose.clocks,
        pose.name,
    )


def occupancy_key(pose: CubicJointPose) -> Tuple:
    return (
        tuple(sorted(pose.fulls)),
        tuple(sorted((c, h) for c, h in pose.wedges)),
    )


def placements_for(pose: CubicJointPose, n: int = 3) -> List[CubicJointPose]:
    out: List[CubicJointPose] = []
    seen = set()
    for perm, signs in OH:
        rp = rotate_pose(pose, perm, signs)
        touched = list(rp.fulls) + [c for c, _ in rp.wedges]
        ranges = []
        for axis in range(3):
            lo = min(c[axis] for c in touched)
            hi = max(c[axis] for c in touched)
            ranges.append(range(-lo, n - hi))
        for ox in ranges[0]:
            for oy in ranges[1]:
                for oz in ranges[2]:
                    sp = shift_pose(rp, (ox, oy, oz))
                    if any(not in_box(c, n) for c in sp.fulls):
                        continue
                    if any(not in_box(c, n) for c, _ in sp.wedges):
                        continue
                    key = occupancy_key(sp)
                    if key in seen:
                        continue
                    seen.add(key)
                    out.append(sp)
    return out


def clocks_for_family(topology: str, face_a: str, face_b: str) -> List[CubicJointPose]:
    poses: List[CubicJointPose] = []
    for ca, cb in product(range(4), repeat=2):
        p = make_pose(topology, face_a, face_b, ca, cb)
        if p is not None:
            poses.append(p)
    return poses


def enumerate_family_poses() -> Dict[str, List[CubicJointPose]]:
    out: Dict[str, List[CubicJointPose]] = {}
    for fam, topology, fa, fb in family_specs():
        out[fam] = clocks_for_family(topology, fa, fb)
    return out


def census(n: int = 3) -> List[Tuple[str, int, int]]:
    """(family, n_valid_clocks, n_unique_in_box_placements)."""
    rows = []
    for fam, topology, fa, fb in family_specs():
        clocks = clocks_for_family(topology, fa, fb)
        seen = set()
        for pose in clocks:
            for pl in placements_for(pose, n):
                seen.add(occupancy_key(pl))
        rows.append((fam, len(clocks), len(seen)))
    return rows


def _check_face_wedges() -> None:
    """F0 axial-away; F1/F2 slope-side; F3/F4 prism-end. Opposite F0F0 spans 5 cells."""
    def offset(face: str) -> Cell:
        u, s, e, _t = oriented_module("I", "B", face, 0)
        gray = cell_of_catalog_center(u)
        w, _h = wedge_half(u, s, e)
        return (w[0] - gray[0], w[1] - gray[1], w[2] - gray[2])

    assert offset("F0") == (1, 0, 0), offset("F0")
    o1 = offset("F1")
    o2 = offset("F2")
    o3 = offset("F3")
    o4 = offset("F4")
    side = {(0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)}
    assert o1 in side, o1
    assert o2 in side, o2
    assert o3 in side, o3
    assert o4 in side, o4
    # F1/F2 may share a neighbor cell (slope-low vs slope-high) but fill different halves.
    u, s1, e1, _ = oriented_module("I", "B", "F1", 0)
    _, s2, e2, _ = oriented_module("I", "B", "F2", 0)
    _w1, h1 = wedge_half(u, s1, e1)
    _w2, h2 = wedge_half(u, s2, e2)
    assert h1 != h2, (h1, h2)
    assert o3 != o4
    assert {o3, o4}.isdisjoint({(1, 0, 0), (-1, 0, 0)})

    far = make_pose("I", "F0", "F0", 0, 0)
    assert far is not None
    xs = [c[0] for c in far.fulls] + [c[0] for c, _ in far.wedges]
    assert max(xs) - min(xs) == 4, (min(xs), max(xs), far)

    l_f0 = make_pose("L", "F0", "F0", 0, 0)
    assert l_f0 is not None
    assert l_f0.fulls[0] == (0, 0, 0)
    assert set(l_f0.fulls) == {(0, 0, 0), (1, 0, 0), (0, 1, 0)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--census", action="store_true")
    args = ap.parse_args()
    if args.check:
        _check_face_wedges()
        print("geometry checks ok")
        n_fam = len(family_specs())
        n_clocks = sum(len(clocks_for_family(t, a, b)) for _, t, a, b in family_specs())
        print(f"families={n_fam} valid_clock_poses={n_clocks}/480")
        return
    rows = census()
    for fam, nclk, npl in rows:
        print(f"  {fam:10} clocks={nclk:2} placements={npl}")
    fitting = [r for r in rows if r[2] > 0]
    print(f"fitting families={len(fitting)}/{len(rows)}")


if __name__ == "__main__":
    main()
