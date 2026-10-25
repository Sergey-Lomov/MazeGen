# Topology: folds and fold groups

Data model and structural validation of per-floor topology (GitHub issue #831, part of the topology epic). A **fold** glues one face of a cell to one face of another cell (or of the same cell), turning a flat field into a cylinder, torus or twisted surface. This layer is pure data plus validation; structural validation knows nothing about the field's cell set. Activity and neighbor lookup against a field are described below (GitHub issue #832), and seam geometry in "Fold geometry" (GitHub issue #833); rendering is out of scope.

Module: `maze-core/src/space/topology.rs`.

## Model

```rust
pub struct FoldEnd<C> { pub cell: C, pub face_idx: usize }   // face_idx = position in faces_of(cell)
pub struct Fold<C>    { pub a: FoldEnd<C>, pub b: FoldEnd<C>, pub twist: bool, pub group: FoldGroupId }
pub struct FoldGroup  { pub id: FoldGroupId, pub folds: Vec<FoldId> }
pub struct Topology<T: Tessellation> { /* fingerprint, folds, groups, (cell, face_idx) index */ }
```

- A `Topology` describes one floor. Storing one per `LevelId` is left to the future owner of per-floor data (no map exists in this layer yet).
- `Topology<T>` implements `Clone`/`Debug` manually, so `T` itself needs neither (only `T::CellId` is stored).
- `FoldId` is the index of the fold in `Topology::folds()`. `FoldGroupId` is unique within one topology.
- `fold_of(cell, face_idx) -> Option<(&Fold, FoldSide)>` returns the fold gluing that face and which side (`A`/`B`) the face is on.
- `twist` is part of the model: it fixes the endpoint correspondence of the glued boundary pieces (reversed versus default), so it affects topology semantics, not only rendering.
- **Groups are the editable unit.** Operations address whole groups. Folds are never regrouped heuristically from geometry.
- A topology without folds changes nothing: with no folds all existing behaviour is unchanged.

## Fingerprint

A topology stores a `TessellationFingerprint`: a canonical string of the tessellation config (kind + params). `face_idx` is stable only within one config, so `validate` first compares the stored fingerprint with the current one and fails with `FingerprintMismatch` when they differ. Producing the canonical string is the factory's job (`maze-wasm` / `maze-runner`), core only compares.

## Two-level validation

1. **Structural (this module, `Topology::validate`)** — independent of the field, over **all** stored folds including inactive ones (folds whose cells are not in the field). Checks, returning the first violation in fold order:
   - fingerprint matches;
   - both ends: the cell is valid for the tessellation (`is_valid_cell`) and `face_idx < faces_of(cell).len()`;
   - no fold glues a face to itself (`a == b`); two different faces of one cell may be glued together;
   - a face belongs to at most one fold (across both sides of all folds);
   - every fold belongs to exactly one group: its `group` exists, that group lists it, and no group (including that one) lists it more than once; groups reference existing folds; group ids are unique.

   Every `TopologyError` variant names the offending fold (or group), and `Display` carries the reason.
2. **Field-dependent (GitHub issue #832, `Field::set_topology`)** — activity of each fold relative to the field, see below. Connectivity stays a later concern.

## Activity

`Field::set_topology(topology, &fingerprint)` validates structurally, then resolves every fold against the field's cell set (`Field::fold_activity()`, indexed by `FoldId`). The field's cell set is fixed at construction, so there is no other change to react to; resolution is a pure function of topology and cell set. A fold is `Active` or `Inactive(reason)`; checked in this order, folds considered in fold order:

- `MissingCell` — an end cell is not in the field.
- `InteriorNeighbor` — a glued face has an ordinary in-field tessellation neighbour; the fold must not silently override it. A face with no neighbour, or whose neighbour is outside the field, may be glued.
- `DuplicateNeighbor` — gluing would make a cell neighbour the same cell twice among the ordinary in-field neighbours and the folds accepted before it (the v1 constraint below).

Inactive folds are ignored by adjacency.

## Effective adjacency

`Field::neighbor_via(cell, face) -> Option<Crossing { cell, face, orientation }>` (and `MultiLevelField::neighbor_via(level, cell, face)`) is the adjacency every maze algorithm uses: an active fold glued at `(cell, face)` wins, otherwise `Tessellation::neighbor`. It is not filtered by field membership. Without active folds it equals `Tessellation::neighbor` with an unflipped orientation. `Field::neighbors`, `Field::is_straight`, `Field::face_index_toward` and the split-pattern logic, split QC and repair go through it. Gluing is reciprocal: crossing a fold and then the returned face leads back, also for twisted folds.

`Tessellation::neighbor` stays the base adjacency (geometry, `field_ops`, tessellation implementations). A guard test (`maze-core/tests/neighbor_guard_test.rs`) forbids direct `.neighbor(` calls outside `space/` and the runner's geometry snapshot.

## Crossing orientation

`Orientation { flips, entry }` separates chirality change from direction correspondence. `flips` is `false` for ordinary neighbours and untwisted folds, `true` for a twisted fold (`Fold::twist`). `entry` is the face the crossing leaves through. Contract: with equal face counts, the face at circular offset `k` from the entry face maps to the face at offset `-k` from the exit face (`flips == false`, the ordinary mirror across a shared side) or `+k` (`flips == true`). `Crossing::transfer(tessellation, from, face)` applies it and returns `None` when the face counts differ. Adapting algorithms to use `transfer` is deferred; the contract is fixed.

## Fold geometry

GitHub issue #833. Module: `maze-core/src/space/geometry/fold.rs`. Seam geometry for active folds; inactive folds change nothing.

- **Unpaired folded faces.** A face glued by an *active* fold has no ordinary partner. `Field::edge_owner`, `Field::edge_segments` and `Field::contact_point` (fold-aware counterparts of the `TessellationGeometry` methods of the same names) treat it as unpaired: the face owns itself, its segments are its own `face_segments` (counter-clockwise along its cell, never reversed from a neighbor) and its contact point is the arc-length midpoint of those segments. Each side of a fold therefore computes its own. This holds even when the base `Tessellation::neighbor` of the face is a cell outside the field. Other faces go through the tessellation unchanged. `Field::folded_face(cell, face) -> Option<FoldedFace>` returns the fold, the side and the partner end.
- **Classification.** `Field::fold_class(fold) -> Option<FoldClass>` (`None` for an unknown or inactive fold) is `Isometric { transform }` or `TopologicalOnly`. A fold is isometric iff one rigid transform `T` maps the **whole** chain of side `b` onto the chain of side `a` within `FOLD_ISOMETRY_EPS` (`1e-7`): same segment count, same segment kinds, same positions and curvature (compared by sampling at `t = 0, ¼, ½, ¾, 1`, with arc radii compared too). A length match alone is not enough, so a line against two collinear halves, a bent chain against a straight one and arcs of equal length but different radius are all `TopologicalOnly`, as are two arcs with the same chord that bulge opposite ways. A topological-only fold glues adjacency but is not passed to the distance algorithm.
- **Deriving `T` with `twist`.** Chains run counter-clockwise along their own cells. Untwisted, `a`'s start meets `b`'s end (the ordinary match): `b`'s chain is taken reversed and `T` is orientation-preserving (the glued cells end up on opposite sides). Twisted, the starts meet: `b`'s chain is taken as is and `T` is a reflection across the x axis followed by a rotation and translation (`RigidTransform { reflects: true, .. }`), because chirality flips. `T` is fixed by the endpoint correspondence and then verified against the whole chain. Consequently two congruent outer arcs of one ring never match (they curve the same way around their cells), while an outer arc and an inner arc of the same radius and span match under either twist.
- **`edge_position`.** `space::edge_position(field, from, to)` takes the `Field` (callers on a multi-level field use the field of `from`'s level) and resolves the face through `Field::face_index_toward` and the contact point through `Field::contact_point`. Across an active fold it is `from`'s own contact point on the folded face, not the midpoint of the two centers (the fallback for cells that share no face and no fold). Across a fold `edge_position(a, b) != edge_position(b, a)`: each side has its own point. Without folds the result is unchanged.
- **Snapshot.** See `Specs/space.md`, "Geometry snapshot lifecycle".

## v1 constraint

A cell has **at most one face toward a given neighbour** (`Specs/space.md`, "Topology contract"; `Field::neighbors` relies on it). Folds must not break it in v1: gluing must not make a cell neighbour the same cell through two faces. Structural validation does not check it; activity resolution does (`DuplicateNeighbor`).

## Distance contract

GitHub issue #834 (audit; part of the topology epic, depends on #831). Fixes the contract that `surface_distance` and the algorithm audit implement. **No behaviour change**: until `surface_distance` exists every consumer below keeps its current planar behaviour.

### Metrics

- **`planar_distance`** — what `geometric_distance`, `floor_aware_distance` and `floor_aware_xy_distance` compute today: Euclidean distance in the tessellation's flat embedding, in `cell_scale` units, optionally with the floor difference as a third coordinate. It ignores folds entirely. The existing functions stay as thin wrappers (`geometric_distance` = `planar_distance` of two cell centers); they are not renamed in this ticket.
- **`surface_distance`** — shortest path along the floor's surface, crossing active *isometric* folds (`Field::fold_class`). The only metric that is correct on a cylinder, torus or twisted surface.
- **graph/nav distance** — tile-hop count over real edges (`MazeAnalysis::distance_from_start/finish`, `bfs_min_distance`, the nav distance cache). Already adjacency-based (folds are seen through `Field::neighbor_via`); independent of this contract.

Without active folds on a floor `surface_distance == planar_distance` (exact). The floor difference is folded in as before (`GeometricFloorMode`) and is never part of the surface path.

### Result types

```rust
pub struct DistanceResult { pub lower_bound: f64, pub upper_bound: f64, pub exact: bool }
pub enum DistanceError { Unsupported }   // surface_distance(..) -> Result<DistanceResult, DistanceError>
pub enum WithinLimit { Yes, No, Unknown }
```

- `lower_bound <= true distance <= upper_bound`. `exact == true` iff the value is computed exactly (then `lower_bound == upper_bound`). Planar distance with no active fold is always exact.
- **`Unsupported`**: the pair touches a floor with an active fold whose class is `TopologicalOnly`, and the caller did not opt into approximation. A topological-only fold glues adjacency but is not passed to the distance algorithm, so no surface path through it can be measured. Folds are scoped per floor: floors without such folds are unaffected.
- **`WithinLimit`** comes from `DistanceResult::compare(Comparison, limit)`: `Yes` when every value in `[lower_bound, upper_bound]` satisfies the comparison, `No` when none does, `Unknown` otherwise. An `exact` result is never `Unknown`. Strict/inclusive semantics stay those of the caller's current comparison (`<` for the proximity scans, `Comparison` for teleport length).

### Approximation flag

Approximation is **explicit opt-in, chosen by the caller**: never a global switch, never silent.

```rust
pub enum DistancePolicy { Strict, Approximate }   // default: Strict
```

- `Strict` (default): `Unsupported` and `Unknown` are returned to the caller.
- `Approximate`: an unsupported pair yields `planar_distance` flagged `exact = false` (`lower_bound == upper_bound == planar`); the caller accepts that the answer may be wrong near the seam. Exposed as a per-check / per-strategy parameter (`approximate_topology: bool`, default `false`), so the choice is visible in the config JSON and in `maze-runner` fixtures.
- `Approximate` replaces only `Unsupported`; it never makes an already exact result inexact.

### Consumers

Audit of every non-test caller of the three functions across `maze-core`, `maze-wasm`, `maze-web` and `maze-runner`. The wasm, web and runner crates call none of them, and `geometric_distance` itself has no production caller (only its `lib.rs` re-export and tests). "Threshold" = the result is compared against a configured limit.

| # | Consumer | Function | Metric | Accuracy | Threshold | Active non-isometric fold |
|---|----------|----------|--------|----------|-----------|---------------------------|
| 1 | `TeleportGeometricLengthCheck` (`teleport_geometric_length_core.rs`), endpoint cell centers | `floor_aware_distance` | `surface_distance` | exact decision | yes, `Comparison` vs `length` | `Strict`: indeterminate (see policy). `Approximate`: planar |
| 2 | `OneWayGroupGeometricProximityCheck`, edge contact points (`edge_position`) | `floor_aware_xy_distance` | `surface_distance` | exact decision | yes, `< distance` | as 1 |
| 3 | `SplitGroupGeometricProximityCheck`, cell centers | `floor_aware_distance` | `surface_distance` | exact decision | yes, `< distance` | as 1 |
| 4 | `VerticalPassageGroupGeometricProximityCheck`, cell centers | `floor_aware_distance` | `surface_distance` | exact decision | yes, `< distance` | as 1 |
| 5 | `ElevatorStopGroupGeometricProximityCheck`, cell centers | `floor_aware_distance` | `surface_distance` | exact decision | yes, `< distance` | as 1 |
| 6 | `CrossElementGeometricProximityCheck`, pre-resolved occurrence positions | `floor_aware_xy_distance` | `surface_distance` | exact decision | yes, `< distance` | as 1 |
| 7 | `ExpandRegionPassageStrategy` `one_way` mode: `farthest_pair`, `farthest_pair_combination` rank candidate bridging pairs | `floor_aware_xy_distance` (floor 0, no height) | `surface_distance` | ordering only | no (argmax / max-min) | never fails: ranks by `upper_bound`; `Unsupported` falls back to planar. Migrating changes seeded output, see `Specs/baselines.md` |
| 8 | `lib.rs` re-export of `geometric_distance` (public API) | `geometric_distance` | `planar_distance` | exact | n/a | unchanged: stays planar, documented as ignoring folds |

Consumers 2 and 6 take `edge_position`s, which are fold-aware (a fold's two sides have distinct contact points, #833), so `surface_distance` must accept arbitrary surface points, not only cell centers. Consumers 2–6 share `pairwise_geometric_scan`, whose `distance` closure is their single integration point; consumer 1 is a plain filter.

Not consumers of this contract:

- **graph/nav distance** (unchanged): `waypoint_distance_core`, `loop_distance_from_start/finish`, `one_way_waypoint_distance`, `one_way_group_graph_proximity`, `analysis.rs`, `graph/nav/build.rs`, `teleport_region_merge`, repair's `bfs_min_distance`. They count hops over real edges and are already correct across folds via `neighbor_via`.
- **planar by design**: `field_ops` symmetry tolerance and preset-radius selection, `voronoi` seed spacing, `geometry/*` segment and fold-isometry tolerances. They work on the flat embedding; folds do not apply.

### Consumer policy for `Unknown` / `Unsupported`

- **QC threshold checks (1–6)** must not silently treat an undecidable pair as pass or fail. Under `Strict`, an `Unsupported` pair or a `WithinLimit::Unknown` comparison is not flagged **and** is recorded as indeterminate: the check surfaces a non-repairable warning-level issue naming the pair/element and the reason (`unsupported_topology` / `distance_unknown`), so the user sees the check could not decide. Repair strategies ignore it. The concrete issue type is defined with `surface_distance`; this section fixes only the rule. `Yes` flags and `No` passes, as today.
- **Under `Approximate`** the planar fallback decides (`exact = false`) and the check also records that the result was approximate (same warning channel, lower severity), so an approximate pass is visible too.
- **Ranking consumers (7)** never fail and never raise issues: they use the bound that suits the ranking (`upper_bound` for "farthest") and fall back to planar for `Unsupported`.
- **No consumer may fall back to `planar_distance` on its own.** A fallback happens only through `DistancePolicy::Approximate`, chosen by the caller and visible in config.

### Follow-ups (not in this ticket)

- `surface_distance` implements the result types and `compare`; consumers 1–7 migrate to it.
- Algorithm audit: each `Strict` consumer gets the indeterminate-issue wiring and a `maze-runner` fixture with an active non-isometric fold.
- `approximate_topology` is added to check/strategy params and the wasm/web config.
