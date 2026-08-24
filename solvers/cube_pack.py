#!/usr/bin/env python3
"""
3×3×3 packer for nine digonal cell-puzzle pieces.

Module = unit cube + triangular-prism half of an adjacent cube (vol 1.5).
Piece  = two face-joined cubes + one wedge per cube; 4 joint snaps.
Search = all 24 lattice orientations × translations × joint states.

  python solvers/cube_pack.py
  python solvers/cube_pack.py --list-pieces
"""

from __future__ import annotations

import argparse
import time
from collections import defaultdict
from dataclasses import dataclass
from itertools import product
from typing import Dict, List, Optional, Sequence, Tuple

Cell = Tuple[int, int, int]
# Plane: ("eq"|"sum", axis_a, axis_b) — 6 triangular-prism bisections of the cube.
Plane = Tuple[str, int, int]
# Directed half inside a cell: (plane, side) with side in {0,1}.
HalfId = Tuple[Plane, int]


def build_oh() -> List[Tuple[Tuple[int, int, int], Tuple[int, int, int]]]:
    out = []
    for perm in product([0, 1, 2], repeat=3):
        if len(set(perm)) < 3:
            continue
        for signs in product([-1, 1], repeat=3):
            M = [[0, 0, 0] for _ in range(3)]
            for i in range(3):
                M[perm[i]][i] = signs[i]
            det = (
                M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
                - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
                + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])
            )
            if det == 1:
                out.append((perm, signs))  # type: ignore[arg-type]
    assert len(out) == 24
    return out  # type: ignore[return-value]


OH = build_oh()

PLANES: Tuple[Plane, ...] = (
    ("eq", 0, 1),
    ("eq", 0, 2),
    ("eq", 1, 2),
    ("sum", 0, 1),
    ("sum", 0, 2),
    ("sum", 1, 2),
)


def plane_value(plane: Plane, local: Tuple[float, float, float]) -> float:
    kind, a, b = plane
    u = (2 * local[0] - 1, 2 * local[1] - 1, 2 * local[2] - 1)
    return (u[a] - u[b]) if kind == "eq" else (u[a] + u[b])


def side_of(plane: Plane, local: Tuple[float, float, float]) -> int:
    return 0 if plane_value(plane, local) <= 0 else 1


def probe_point(half: HalfId) -> Tuple[float, float, float]:
    """Interior point of a directed half (away from the cut)."""
    plane, side = half
    kind, a, b = plane
    p = [0.5, 0.5, 0.5]
    if kind == "eq":
        # side 0: u_a <= u_b → prefer small a, large b
        p[a], p[b] = (0.25, 0.75) if side == 0 else (0.75, 0.25)
    else:
        # side 0: u_a + u_b <= 0 → both small
        p[a], p[b] = (0.25, 0.25) if side == 0 else (0.75, 0.75)
    assert side_of(plane, tuple(p)) == side  # type: ignore[arg-type]
    return tuple(p)  # type: ignore[return-value]


def identify_half(local: Tuple[float, float, float]) -> HalfId:
    """Map a local point to the unique (plane, side) with maximal |plane value|."""
    best: Optional[HalfId] = None
    best_abs = -1.0
    for pl in PLANES:
        v = plane_value(pl, local)
        if abs(v) > best_abs:
            best_abs = abs(v)
            best = (pl, 0 if v <= 0 else 1)
    assert best is not None
    return best


def rot_vec(v, perm, signs):
    q = [0] * len(v)
    for i, vi in enumerate(v):
        q[perm[i]] = signs[i] * vi
    return tuple(q)


def rot_cell(c: Cell, perm, signs) -> Cell:
    return rot_vec(c, perm, signs)  # type: ignore[return-value]


def rotate_half_id(half: HalfId, perm, signs) -> HalfId:
    """Rotate a cell-local half by an Oh element (about cell center)."""
    px, py, pz = probe_point(half)
    # center → ± coords → rotate → back
    u = (2 * px - 1, 2 * py - 1, 2 * pz - 1)
    ru = rot_vec(u, perm, signs)
    local = ((ru[0] + 1) / 2, (ru[1] + 1) / 2, (ru[2] + 1) / 2)
    return identify_half(local)


def complement(half: HalfId) -> HalfId:
    pl, s = half
    return (pl, 1 - s)


# ---------------------------------------------------------------------------
# Module
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Module:
    full: Cell
    wedge_cell: Cell
    half: HalfId


def base_module() -> Module:
    # Cube (0,0,0); wedge in (-1,0,0); plane eq x==z, side with shared face.
    # Shared face of wedge cell is local x=1. Point (0.75,0.5,0.25) has x>z.
    half: HalfId = (("eq", 0, 2), 1)  # u_x >= u_z
    return Module((0, 0, 0), (-1, 0, 0), half)


def all_modules() -> List[Module]:
    base = base_module()
    seen = set()
    out: List[Module] = []
    for perm, signs in OH:
        full = rot_cell(base.full, perm, signs)
        w = rot_cell(base.wedge_cell, perm, signs)
        h = rotate_half_id(base.half, perm, signs)
        ox, oy, oz = full
        key = ((0, 0, 0), (w[0] - ox, w[1] - oy, w[2] - oz), h)
        if key not in seen:
            seen.add(key)
            out.append(Module(key[0], key[1], key[2]))
    return out


MODULES = all_modules()


# ---------------------------------------------------------------------------
# Digonal pieces
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PiecePose:
    fulls: Tuple[Cell, Cell]
    wedges: Tuple[Tuple[Cell, HalfId], Tuple[Cell, HalfId]]
    name: str


def rotate_pose(pose: PiecePose, perm, signs) -> PiecePose:
    fulls = tuple(rot_cell(c, perm, signs) for c in pose.fulls)
    wedges = tuple(
        (rot_cell(c, perm, signs), rotate_half_id(h, perm, signs))
        for c, h in pose.wedges
    )
    return PiecePose(fulls, wedges, pose.name)  # type: ignore[arg-type]


def shift_pose(pose: PiecePose, o: Cell) -> PiecePose:
    ox, oy, oz = o
    fulls = tuple((c[0] + ox, c[1] + oy, c[2] + oz) for c in pose.fulls)
    wedges = tuple(
        ((c[0] + ox, c[1] + oy, c[2] + oz), h) for c, h in pose.wedges
    )
    return PiecePose(fulls, wedges, pose.name)  # type: ignore[arg-type]


def normalize_pose(pose: PiecePose) -> Tuple:
    best = None
    for perm, signs in OH:
        p = rotate_pose(pose, perm, signs)
        minx = min(c[0] for c in p.fulls)
        miny = min(c[1] for c in p.fulls)
        minz = min(c[2] for c in p.fulls)
        fulls = tuple(
            sorted((c[0] - minx, c[1] - miny, c[2] - minz) for c in p.fulls)
        )
        wedges = tuple(
            sorted(
                ((c[0] - minx, c[1] - miny, c[2] - minz), h)
                for c, h in p.wedges
            )
        )
        fp = (fulls, wedges)
        if best is None or fp < best:
            best = fp
    return best  # type: ignore[return-value]


def rot_yz(cell: Cell, k: int) -> Cell:
    """Rotate cell index about digonal X-axis through y=z=0 centers line."""
    cx, y, z = cell[0], float(cell[1]), float(cell[2])
    for _ in range(k % 4):
        y, z = -z, y
    return (cx, int(round(y)), int(round(z)))


def rot_half_about_x(half: HalfId, k: int) -> HalfId:
    px, py, pz = probe_point(half)
    u = (2 * px - 1, 2 * py - 1, 2 * pz - 1)
    y, z = u[1], u[2]
    for _ in range(k % 4):
        y, z = -z, y
    local = ((u[0] + 1) / 2, (y + 1) / 2, (z + 1) / 2)
    return identify_half(local)


def make_digonal(ma: Module, mb: Module, joint_k: int, name: str) -> Optional[PiecePose]:
    if ma.full != (0, 0, 0) or mb.full != (0, 0, 0):
        return None
    fa, fb = (0, 0, 0), (1, 0, 0)
    wa = ma.wedge_cell
    wb = (mb.wedge_cell[0] + 1, mb.wedge_cell[1], mb.wedge_cell[2])
    ha, hb = ma.half, mb.half

    if wa in (fa, fb) or wb in (fa, fb):
        return None

    if joint_k:
        wb = rot_yz(wb, joint_k)
        hb = rot_half_about_x(hb, joint_k)
        if wb in (fa, fb):
            return None

    if wa == wb and complement(ha) != hb:
        return None

    return PiecePose((fa, fb), ((wa, ha), (wb, hb)), name)


def enumerate_families() -> List[List[PiecePose]]:
    bucket: Dict[Tuple, Tuple[int, int]] = {}
    for ia, ib in product(range(len(MODULES)), repeat=2):
        fps = []
        ok = True
        for k in range(4):
            p = make_digonal(MODULES[ia], MODULES[ib], k, "")
            if p is None:
                ok = False
                break
            fps.append(normalize_pose(p))
        if not ok:
            continue
        key = tuple(sorted(set(fps)))
        bucket.setdefault(key, (ia, ib))

    families: List[List[PiecePose]] = []
    for key, (ia, ib) in sorted(bucket.items(), key=lambda kv: kv[0]):
        fam = [
            make_digonal(MODULES[ia], MODULES[ib], k, f"P{len(families)}_j{k}")
            for k in range(4)
        ]
        if any(p is None for p in fam):
            continue
        families.append(fam)  # type: ignore[arg-type]
    return families


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

def in_box(c: Cell, n: int) -> bool:
    return all(0 <= c[i] < n for i in range(3))


def placements_for(pose: PiecePose, n: int) -> List[PiecePose]:
    out: List[PiecePose] = []
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
                    fp = (
                        tuple(sorted(sp.fulls)),
                        tuple(sorted((c, h) for c, h in sp.wedges)),
                    )
                    if fp in seen:
                        continue
                    seen.add(fp)
                    out.append(sp)
    return out


class Grid:
    def __init__(self, n: int = 3):
        self.n = n
        self.cells: Dict[Cell, Tuple] = {}
        self.undo: List[List[Tuple[Cell, Optional[Tuple]]]] = []

    def can_place(self, pose: PiecePose) -> bool:
        for c in pose.fulls:
            if c in self.cells:
                return False
        by: Dict[Cell, List[HalfId]] = defaultdict(list)
        for c, h in pose.wedges:
            if c in pose.fulls:
                return False
            by[c].append(h)
            cur = self.cells.get(c)
            if cur is None:
                continue
            if cur[0] in ("F", "P"):
                return False
            if cur[0] == "H" and complement(cur[1]) != h:
                return False
        for hs in by.values():
            if len(hs) > 2:
                return False
            if len(hs) == 2 and complement(hs[0]) != hs[1]:
                return False
        return True

    def place(self, pose: PiecePose, pid: int) -> None:
        keys = list(pose.fulls) + [c for c, _ in pose.wedges]
        self.undo.append([(c, self.cells.get(c)) for c in keys])
        for c in pose.fulls:
            self.cells[c] = ("F", pid)
        for c, h in pose.wedges:
            cur = self.cells.get(c)
            if cur is not None and cur[0] == "H":
                self.cells[c] = ("P",)
            else:
                self.cells[c] = ("H", h, pid)

    def unplace(self) -> None:
        frame = self.undo.pop()
        for c, _ in frame:
            self.cells.pop(c, None)
        for c, old in frame:
            if old is not None:
                self.cells[c] = old

    def complete(self) -> bool:
        for c in product(range(self.n), repeat=3):
            cur = self.cells.get(c)  # type: ignore[arg-type]
            if cur is None or cur[0] not in ("F", "P"):
                return False
        return True

    def pending_half(self) -> Optional[Cell]:
        for c in product(range(self.n), repeat=3):
            cur = self.cells.get(c)  # type: ignore[arg-type]
            if cur is not None and cur[0] == "H":
                return c  # type: ignore[return-value]
        return None


def solve(
    families: Sequence[Sequence[PiecePose]],
    n: int = 3,
    max_nodes: int = 5_000_000,
) -> Optional[List[Tuple[int, int, PiecePose]]]:
    place_lists = [[placements_for(p, n) for p in fam] for fam in families]
    counts = [sum(len(x) for x in pl) for pl in place_lists]
    print(f"placements/piece: {counts} sum={sum(counts)}")

    # Index placements that can complete a given half-cell.
    cover_half: List[Dict[Cell, List[Tuple[int, PiecePose]]]] = [
        defaultdict(list) for _ in families
    ]
    cover_cell: List[Dict[Cell, List[Tuple[int, PiecePose]]]] = [
        defaultdict(list) for _ in families
    ]
    for pi, joints in enumerate(place_lists):
        for ji, opts in enumerate(joints):
            for pose in opts:
                for c, h in pose.wedges:
                    cover_half[pi][c].append((ji, pose))
                    cover_cell[pi][c].append((ji, pose))
                for c in pose.fulls:
                    cover_cell[pi][c].append((ji, pose))

    grid = Grid(n)
    sol: List[Tuple[int, int, PiecePose]] = []
    nodes = [0]
    used = [False] * len(families)

    def bt(depth: int) -> bool:
        nodes[0] += 1
        if nodes[0] > max_nodes:
            return False
        if depth >= len(families):
            return grid.complete()

        pending = grid.pending_half()
        # Choose next piece dynamically: must be able to cover a pending half
        # if one exists; otherwise cover the first empty cell.
        if pending is not None:
            candidates = [
                pi
                for pi in range(len(families))
                if not used[pi] and cover_half[pi].get(pending)
            ]
            target = pending
            mode = "half"
        else:
            empty = next(
                (
                    c
                    for c in product(range(n), repeat=3)
                    if c not in grid.cells
                ),
                None,
            )
            if empty is None:
                return grid.complete()
            candidates = [
                pi
                for pi in range(len(families))
                if not used[pi] and cover_cell[pi].get(empty)
            ]
            target = empty
            mode = "cell"

        if not candidates:
            return False

        # Fewest options first among remaining pieces for this target
        def cand_key(pi: int) -> int:
            if mode == "half":
                return len(cover_half[pi][target])
            return len(cover_cell[pi][target])

        candidates.sort(key=cand_key)

        for pi in candidates:
            opts = (
                cover_half[pi][target]
                if mode == "half"
                else cover_cell[pi][target]
            )
            # Deduplicate identical poses
            seen = set()
            used[pi] = True
            for ji, pose in opts:
                key = (
                    tuple(sorted(pose.fulls)),
                    tuple(sorted((c, h) for c, h in pose.wedges)),
                )
                if key in seen:
                    continue
                seen.add(key)
                if not grid.can_place(pose):
                    continue
                grid.place(pose, pi)
                sol.append((pi, ji, pose))
                if bt(depth + 1):
                    return True
                sol.pop()
                grid.unplace()
            used[pi] = False
        return False

    ok = bt(0)
    print(f"nodes={nodes[0]}")
    return sol if ok else None

def bbox_vol(pose: PiecePose) -> int:
    cells = list(pose.fulls) + [c for c, _ in pose.wedges]
    return (
        (max(c[0] for c in cells) - min(c[0] for c in cells) + 1)
        * (max(c[1] for c in cells) - min(c[1] for c in cells) + 1)
        * (max(c[2] for c in cells) - min(c[2] for c in cells) + 1)
    )


def pick_nine(families: List[List[PiecePose]], offset: int = 0) -> List[List[PiecePose]]:
    rich = [f for f in families if len({normalize_pose(p) for p in f}) == 4]
    pool = rich if len(rich) >= 9 else families
    pool = sorted(pool, key=lambda f: bbox_vol(f[0]))
    nine = pool[offset : offset + 9]
    if len(nine) < 9:
        raise SystemExit(f"need 9 families, got {len(nine)}")
    return nine


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list-pieces", action="store_true")
    ap.add_argument("--max-nodes", type=int, default=5_000_000)
    ap.add_argument("--offset", type=int, default=0)
    args = ap.parse_args()

    print(f"modules={len(MODULES)}")
    t0 = time.time()
    families = enumerate_families()
    rich = sum(1 for f in families if len({normalize_pose(p) for p in f}) == 4)
    print(f"families={len(families)} joint4={rich} ({time.time()-t0:.2f}s)")

    if args.list_pieces:
        for i, fam in enumerate(families):
            nd = len({normalize_pose(p) for p in fam})
            print(f"  {i:3d} distinct-joints={nd} wedges={[c for c,_ in fam[0].wedges]}")
        return

    nine = pick_nine(families, args.offset)
    print(f"packing {len(nine)} types (offset={args.offset})")
    t1 = time.time()
    sol = solve(nine, max_nodes=args.max_nodes)
    print(f"search {time.time()-t1:.2f}s")
    if sol is None:
        print("NO SOLUTION (within node budget)")
    else:
        print("SOLUTION FOUND")
        for pi, ji, pose in sorted(sol, key=lambda t: t[0]):
            print(
                f"  piece {pi} joint {ji}: cubes={pose.fulls} "
                f"wedges={[c for c,_ in pose.wedges]}"
            )


if __name__ == "__main__":
    main()
