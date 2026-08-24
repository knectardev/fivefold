#!/usr/bin/env python3
"""Dump 24×12 half-id rotation table using the same matrices as json_contract.mjs."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cube_pack import PLANES, plane_value, probe_point  # noqa: E402


def rotations24():
    perms = ([0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0])
    out = []
    for p in perms:
        for sx in (-1, 1):
            for sy in (-1, 1):
                for sz in (-1, 1):
                    M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
                    M[0][p[0]] = sx
                    M[1][p[1]] = sy
                    M[2][p[2]] = sz
                    det = (
                        M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
                        - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
                        + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])
                    )
                    if det == 1:
                        out.append(M)
    assert len(out) == 24
    return out


def apply_rot(v, M):
    return (
        M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
        M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
        M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
    )


def half_index(plane_idx, side):
    return plane_idx * 2 + side


def identify_local(local):
    best_i = 0
    best_abs = -1.0
    best_side = 0
    for i, pl in enumerate(PLANES):
        v = plane_value(pl, local)
        if abs(v) > best_abs:
            best_abs = abs(v)
            best_i = i
            best_side = 0 if v <= 0 else 1
    return half_index(best_i, best_side)


def rotate_half(h, M):
    plane_idx, side = divmod(h, 2)
    plane = PLANES[plane_idx]
    p = probe_point((plane, side))
    u = (2 * p[0] - 1, 2 * p[1] - 1, 2 * p[2] - 1)
    ru = apply_rot(u, M)
    local = ((ru[0] + 1) / 2, (ru[1] + 1) / 2, (ru[2] + 1) / 2)
    return identify_local(local)


def main():
    rots = rotations24()
    table = [[rotate_half(h, M) for h in range(12)] for M in rots]
    json.dump({"rotations": len(rots), "table": table}, sys.stdout)


if __name__ == "__main__":
    main()
