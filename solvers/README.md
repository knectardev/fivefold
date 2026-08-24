# Cell-puzzle cube packers

Solvers for packing hinged module pieces into a **3×3×3** cube.

## Geometry model

- **Module** = 1 unit cube + 1 triangular-prism half-cube (volume 1.5).
- **Digonal piece** = two face-joined cubes + one wedge per cube (volume 3).
- **Cubic joint** = lavender cube + two modules (volume 4). Catalog Collection 2: 30 mounting families, 16 quarter-turn poses.
- **Joint** = 4 snap rotations about the shared-face / arm-axis normal.
- **Placement** = 24 lattice orientations × translations inside the box.
- Half-cells must complete in **complementary pairs** (same diagonal cut, opposite sides).

Digonal volume: \(9 \times 3 = 27\). Cubic-joint kit: \(6 \times 4 + 3\) (L-tromino part) \(= 27\).

## Scripts

| File | Role |
|------|------|
| `cube_pack.py` | Digonal geometry, piece enumeration, backtracking search |
| `cube_pack_sat.py` | OR-Tools CP-SAT packer (fast infeasibility proofs) |
| `perp_no_rect_search.py` | 12-family digonal pool, 8+L product path |
| `cubic_joint.py` | Collection 2 occupancy (30 families × 16 clocks) |
| `cubic_joint_search.py` | CP-SAT census / prove-max / 6+L enumeration |
| `solver-gemini.txt` | Gemini’s draft (incomplete; voxel counts don’t match 27) |

```bash
# List unique digonal piece families (15 with 4 distinct joints each)
python solvers/cube_pack.py --list-pieces

# CP-SAT: pack first 9 fitting families
python solvers/cube_pack_sat.py --time 60

# CP-SAT: scan 9-subsets
python solvers/cube_pack_sat.py --scan --time 30

# Cubic joints: which of the 30 families fit in the box
python solvers/cubic_joint.py --check
python solvers/cubic_joint_search.py --census

# Max pieces (volume caps at 6) and 6+L orbits
python solvers/cubic_joint_search.py --prove-max --time 120
python solvers/cubic_joint_search.py --enumerate6 --l-tromino --time 300 --limit 48

# Exhaustive orbits of the all-unique 6-family kit (7 Oh classes)
python solvers/cubic_joint_search.py --enumerate6 --l-tromino --inventory "O-F1F1:1,O-F1F2:1,L-F0F2:1,L-F1F2:1,L-F3F3:1,L-F3F4:1" --time 240 --out solvers/cubic_joint_unique6_orbits.json
```

Viewer: `/solvers/view_cubic_joint.html` (mixed sample `cubic_joint_orbits.json`; check “This piece mix only” for the 7-orbit all-unique kit). Surface colors: `/solvers/view_cubic_joint.html?surface=1`.

Requires: `numpy`, `ortools` (`pip install ortools`).

## Result (digonal pieces)

Under the digonal cube-core model above, CP-SAT finds:

1. **Any 9 distinct digonal families tried so far → `INFEASIBLE`.**
2. **Even allowing duplicate piece types, filling the cube is `INFEASIBLE`.**
3. **Maximum number of digonal pieces placeable with completed half-cells is 8** (optimal).

So a full 3×3×3 is **not feasible** if every piece is a face-joined cube pair with one exterior wedge per cube.

Nine disjoint digonal *cubes alone* can cover 18 cells; the obstruction is completing the 9 half-cells with the wedges those digonal pieces carry.

## If your Rhino pieces are not all digonal

Some gallery configs (end-to-end, offset joins) put cubes **non-adjacent** (wedge between them). Those need a general two-module contact model, not the digonal default. Export the nine piece transforms (or STEP/OBJ per joint pose) and we can extend the packer.
