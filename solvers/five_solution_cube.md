# Five-solution digonal cube

Mathematical derivation of the eight-piece packing, the L-tromino void, and the five-color surface map. Product view: `solvers/view_perp_no_rect.html` with `inventory_20_L_orbits.json`.

## 1. Geometry

The box is the unit lattice cube \( [0,3)^3 \), twenty-seven cells.

A **module** is one full cell plus a triangular-prism half of an adjacent cell (volume \( 1.5 \)). The half is one of the six diagonal bisections of a cube (`eq` or `sum` on a pair of axes), with a side in \( \{0,1\} \).

A **digonal piece** is two modules whose full cells share a face. The two cubes form a \( 1\times 2 \) bar. Each cube carries one exterior wedge. Relative to the bar, the second module has **four joint snaps**: \( 90^\circ \) rotations about the shared-face normal. Those four snaps are pairwise incongruent under \( \mathrm{SO}(3) \); they are different solids, not the same part turned in space.

A **placement** is a lattice orientation in the octahedral rotation group (\( 24 \) elements) times a translation that keeps the piece in the box.

**Half-cell law.** Every occupied half-cell must be completed by the complementary half (same cut plane, opposite side). Unpaired wedges are forbidden.

Volume of nine digonal pieces: \( 9 \times 2 \times 1.5 = 27 \). The count matches a full cube; the half-cell law does not.

## 2. Why the cube does not fill

CP-SAT on this model proves:

- maximum number of digonal pieces with completed halves is **eight** (optimal);
- every nine-piece instance tried, including duplicates, is **infeasible**.

Eight pieces cover twenty-four cells of volume and leave **three empty cells** (the leftover volume is \( 4.5 \), but the empty set is three full cells: the nine half-cells those eight pieces carry complete among themselves, so the leftover is three uncut cells).

Those three cells are the **void**. For the manufactured set they are required to be a face-connected **L-tromino** (bent, not a straight \( 1\times 1\times 3 \)).

## 3. Search pool

There are fifteen congruence families of digonal pieces. Three of them self-pair into a \( 2\times 3\times 1 \) rectangle, \( \{0,2,6\} \). They are excluded.

The remaining **twelve-family pool** is

\[
\{1,3,4,5,7,8,9,10,11,12,13,14\}.
\]

Known rectangle-forming family pairs are also banned as joint inventories: \( (1,3) \), \( (5,10) \), \( (7,12) \), and the self-pairs already removed. All four joint snaps are allowed (parallel, perpendicular, and axial-on-end).

A mixed-inventory enumeration from this pool produced forty-eight packings inequivalent under the full octahedral group \( O_h \) (\( 48 \) rotations and reflections of the cube). That list is a sample of inventories, not a classification of one kit. Viewer orbit **#20** in that file is the kit below.

## 4. Fixed inventory

The product uses eight pieces with family counts

\[
\{1{:}1,\; 4{:}1,\; 7{:}1,\; 8{:}1,\; 9{:}1,\; 10{:}1,\; 11{:}2\}.
\]

Seven distinct shapes; family \( 11 \) appears twice (the duplicated teal part).

CP-SAT with this exact multiplicity, eight pieces, completed halves, rectangle-pair bans, and the void constrained to an L-tromino:

| | |
|---|---|
| Raw solutions | \( 144 \) |
| Status | `OPTIMAL` (enumeration finished) |
| Inequivalent under \( O_h \) | **6** orbits |

So there are six cube-symmetry classes of L-void packings of this kit, and no more.

## 5. The six orbits

Two of the six differ only by **swapping families \( 4 \) and \( 8 \)** on the same two cube seats. They share the L, the rest of the skeleton, and the joint list; the two parts complete a shared meeting cell on two different diagonal cuts. That pair is one physical layout with a trivial relabeling.

The **five inequivalent layouts** (skipping the swap duplicate) are the product solutions. Joint string is `family`+`j`+snap.

| Product | Viewer | Color | L-void cells | Joints |
|---|---|---|---|---|
| 1 | #0 (pool #20) | orange | \( (1,1,2),\;(1,2,1),\;(1,2,2) \) | `1j3 4j3 7j1 8j3 9j0 10j0 11j0 11j3` |
| 2 | #1 | green | \( (2,0,0),\;(2,0,1),\;(2,1,1) \) | `1j0 4j0 7j1 8j0 9j0 10j1 11j2 11j3` |
| — | #2 | *(same marks as #1)* | same L as #1 | same snaps; \( 4\leftrightarrow 8 \) seats |
| 3 | #3 | cyan | \( (0,0,0),\;(1,0,0),\;(1,0,1) \) | `1j0 4j2 7j1 8j1 9j0 10j0 11j0 11j3` |
| 4 | #4 | purple | \( (1,0,1),\;(2,0,1),\;(2,1,1) \) | `1j0 4j3 7j1 8j2 9j0 10j0 11j0 11j3` |
| 5 | #5 | indigo | \( (1,0,1),\;(1,1,0),\;(1,1,1) \) | `1j0 4j2 7j2 8j2 9j1 10j1 11j0 11j3` |

Representatives are \( O_h \)-canonical; the L may sit in a different corner after turning the cube. The two copies of family \( 11 \) are always perpendicular bars with two different snaps (never the same clock position).

## 6. Joints: every hinged part must rotate

Each family’s four snaps are four distinct solids. Across the five layouts, **no family stays on a single snap**:

| Family | Snaps used |
|---|---|
| 1 | \( j0, j3 \) |
| 4 | \( j0, j2, j3 \) |
| 7 | \( j1, j2 \) |
| 8 | all four |
| 9 | \( j0, j1 \) |
| 10 | \( j0, j1 \) |
| 11 | \( j0, j2, j3 \); both copies differ in **every** packing |

So every digonal part in the kit needs the four-stop hinge. The L-tromino is a rigid three-cell void, not two modules, so it has no joint.

Near-rigid exceptions if one drops a layout: family \( 1 \) is a single snap if #0 is removed; families \( 7 \) and \( 9 \) are a single snap if #5 is removed. The full five-solution set needs all hinges.

## 7. Surface colors

The physical kit is one set of eight hinged parts. A face of a part that is on the **outer \( 3\times 3\times 3 \) skin** in one packing may be buried in another.

Paint is therefore **on the part**, in a local frame of each module (cube + its wedge), not on a fixed cell of the box.

- Each square or right isosceles triangle of a part is divided into five sections (one per product solution).
- Section \( i \) is painted iff that same local face lies on the outer skin in solution \( i \).
- L-hole walls and contacts between parts are not “outer skin.”
- Faces that never reach the outer skin in any of the five stay unpainted (base color).
- Assembled in solution \( i \), every outer square/triangle shows section \( i \) filled. Buried faces show the mixed ticks of the other solutions in which those faces were outside.

The two family-\( 11 \) copies are matched across packings as two instances of the same family (sorted by joint). Section colors do not encode family identity; a single base color (gray) keeps the five ticks readable.

## 8. How to reproduce

```bash
# Mixed 12-pool 8-piece orbits (includes kit as one representative)
python solvers/perp_no_rect_search.py --enumerate8 --limit 48

# Exhaustive L-void orbits of this inventory
python solvers/enumerate_inventory_L.py
```

Viewer: `/solvers/view_perp_no_rect.html`, “This piece mix only,” “Five-solution surface colors.”

## Cubic-joint analog (all-unique kit)

One manufactured mix of six **distinct** cubic joints plus a rigid L-tromino (no duplicate parts):

\[
\{\mathrm{O\text{-}F1F1},\; \mathrm{O\text{-}F1F2},\; \mathrm{L\text{-}F0F2},\; \mathrm{L\text{-}F1F2},\; \mathrm{L\text{-}F3F3},\; \mathrm{L\text{-}F3F4}\}
\]

plus the L part. Exhaustive \(O_h\) enumeration: **168** raw solutions, **7** orbits, **7** cube bodies, **6** L seats (orbits #0 and #6 share an L). The surface map paints five of those seven: orbits **#0, #1, #2, #4, #5** (skip #6 as the L-seat twin of #0, and #3 as a clock-similar twin of #2).

```bash
python solvers/cubic_joint_search.py --enumerate6 --l-tromino --inventory "O-F1F1:1,O-F1F2:1,L-F0F2:1,L-F1F2:1,L-F3F3:1,L-F3F4:1" --time 240 --out solvers/cubic_joint_unique6_orbits.json
```

Viewer: `/solvers/view_cubic_joint.html?surface=1` — “This piece mix only,” “Five-layout surface colors.”
