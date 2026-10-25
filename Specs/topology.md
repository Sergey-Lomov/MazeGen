# Topology: folds and fold groups

Data model and structural validation of per-floor topology (GitHub issue #831, part of the topology epic). A **fold** glues one face of a cell to one face of another cell (or of the same cell), turning a flat field into a cylinder, torus or twisted surface. This layer is data, structural validation and core authoring tools ("Authoring"); structural validation knows nothing about the field's cell set. Activity and neighbor lookup against a field are described below (GitHub issue #832), and seam geometry in "Fold geometry" (GitHub issue #833); rendering is out of scope.

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

## Wire form

GitHub issue #836. Module: `maze-runner/src/topology_wire.rs`. One serialized shape serves the `maze-runner` fixture config, the `maze-wasm` dispatchers and the project file (TypeScript: `WireTopology` in `maze-web/src/wasm/types.ts`).

```json
{ "fingerprint": "square{}",
  "folds":  [ { "a": { "cell": [4, 0], "face_idx": 0 }, "b": { "cell": [0, 0], "face_idx": 2 }, "twist": false, "group": 0 } ],
  "groups": [ { "id": 0, "folds": [0] } ] }
```

- `cell` is the tessellation's wire point (`CellCodec`); `face_idx` is the position in `faces_of(cell)`; `twist` defaults to `false`; `groups[].folds` are indices into `folds`. `folds` and `groups` default to empty.
- **Per floor.** `GenerateConfig.topology` and `ComputeAnalyticsConfig.topology` (post-edit confirm and analytics recompute) are arrays in `level_fields` order; a missing or `null` entry means no folds on that floor, more entries than floors is an error. Both are optional, so configs predating the key deserialize unchanged. Errors are prefixed `topology[<floor>]:`.
- **Fingerprint.** `tessellation_fingerprint(config)` is the kind name followed by the params as JSON with sorted keys (`square{}`, `radial{"first_ring_cells":9,"max_cells":3000}`); a whole-valued number renders as an integer (`1` and `1.0` agree). The web client renders the same string (`tessellationFingerprint`, `maze-web/src/store/topologyWire.ts`). Decoding compares it with the current config first and fails with `topology was authored for tessellation `<found>`, current is `<expected>`` before any cell is read.
- **Validation at the boundary.** `decode_topology` checks the fingerprint, decodes every end with the same rule as other wire points (undecodable or invalid cell: `folds[i].a|b: invalid cell [x, y]`) and runs `Topology::validate`, whose `Display` names the offending fold or group. `install_topologies` then calls `MultiLevelField::set_topology` per floor, so activity is resolved against each floor's own cell set. `encode_topology` is the inverse; decode followed by encode returns the same wire value.
- **Project file.** The optional `floorTopology` section maps floor id to `WireTopology` (`Specs/project-file.md`). Loading rejects an entry whose fingerprint differs from the file's tessellation and any structural violation (`validateWireTopology`); cell validity and face ranges are checked by core when the topology is installed.
- **Fixtures.** `maze-runner/tests/fixtures/topology-{cylinder,torus,mobius}.json` (a 6x5 square field) with `maze-runner/tests/topology.rs`; generation parameters come from the fixtures.

## Authoring

GitHub issue #837. Module: `maze-core/src/space/topology_edit.rs`. Core-only tools to build a topology; no wire or UI changes.

- **Contours.** `boundary_contours(&Field) -> Result<Vec<Contour>, TopologyEditError>` (`OpenContour` if a boundary walk does not close, never a silently dropped chain): closed chains of boundary faces (`FoldEnd`s with no in-field ordinary neighbour) in traversal order, field cells on the left (outer contour counter-clockwise, a hole clockwise). Faces already glued by an installed topology are still listed. `Contour::run(start, len)` takes consecutive faces, wrapping around the end.
- **Glue.** `Topology::glue(field, fingerprint, run_a, run_b, twist)` makes one fold per face pair and adds them as one new `FoldGroup`. Untwisted, `a[i]` meets `b[len-1-i]` (both runs follow their boundary in the same rotational sense, the ordinary orientation-reversing match); twisted, `a[i]` meets `b[i]`. Runs must be non-empty and equally long, and paired cells must have equal face counts (`Topology::glue_folds` does the pairing alone).
- **Groups.** `add_group`, `replace_group(id, folds)` and `remove_group(id)` act on whole groups. Replacement keeps the group id and position; new ids are `max + 1`; `FoldId`s are reassigned.
- **Transactions.** Every edit builds a candidate, validates it as a whole and replaces `self` only on success: the base topology must be structurally valid, the candidate must pass `Topology::validate`, and every fold of the candidate must be `Active` in the field (so an edit also fails on `Inactive { fold, reason }`, including folds of other groups). On any error the topology is unchanged. Errors are `TopologyEditError` (`Display` names the reason).
- **Presets.** `TopologyPreset::{Cylinder, Torus, Mobius, Klein}` (`ALL`, `key`, `from_key`), `build(field, fingerprint) -> Result<Topology>`. The field must have a single boundary contour that splits into four runs (left, right, bottom, top; each boundary face is classified by its contact point against the bounding box). Left-right is glued by every preset (twisted for Möbius and Klein), bottom-top by torus and Klein (untwisted); each glued pair is its own group. Verified per fold: equal run lengths, equal face counts, an `Isometric` seam (`classify_fold_faces`), cells neither equal nor neighbours (`TooSmall`: at least 3 cells along a glued dimension, torus at least 3x3 on a square grid) and the candidate activity check above. Tessellations whose sides stagger (e.g. brick) can fail with the reason instead of a partial topology. `topology_preset_availability(field, fingerprint)` returns every preset with `Ok` or the reason it does not build (the core analogue of `field_capabilities`). Runner / wasm / web exposure of presets is not part of this ticket. An inactive fold anywhere in the topology blocks edits of other groups; removing the group that holds it is allowed.

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

## Surface distance

GitHub issue #835. Module: `maze-core/src/space/geometry/surface.rs`. `Field::surface_metric() -> SurfaceMetric` (`SurfaceMetric::new(&field)`, `.with_policy(DistancePolicy)`) implements the result types of "Distance contract":

- `surface_distance(a, b) -> Result<DistanceResult, DistanceError>` and `surface_distance_at_most(a, b, limit) -> Result<WithinLimit, DistanceError>` (`compare(Comparison::Le, limit)` of the bracket). Arguments are `ScaledPoint`s (arbitrary surface points, e.g. `edge_position`s); results are in `cell_scale` units of the mean scale, like `planar_distance`. `planar_distance(a, b)` is `floor_aware_xy_distance` without height; `geometric_distance` is a thin wrapper and stays planar.
- Floors are independent: one metric per `Field`; the floor difference is not part of the surface path (`floor_aware_distance` is unchanged).
- A field with an active `TopologicalOnly` fold is `Unsupported` under `Strict`; under `Approximate` the result is the planar distance with `exact = false`. Inactive folds change nothing.

### Model

The tessellation's flat embedding is the *development*: every cell sits in one plane, an *unbounded* one (a path may run outside the field's cells, as `planar_distance` already does). An active isometric fold with transform `T` (b onto a, `Field::fold_class`) glues the chain `A` of side `a` to the chain `B` of side `b`. A path that leaves cell `a` through `A` continues in a second copy of the plane, placed across `A` by `T`; unfolding keeps a *frame* `g` (sheet coordinates to the plane of the source `s`), initially the identity:

- leaving `a` through `A`: `g' = g ∘ T`; leaving `b` through `B`: `g' = g ∘ T⁻¹`;
- the target `t` then sits at `g(t)` and the path is a curve from `s` to `g(t)`, so its length is at least `|s − g(t)|`; it is exactly that when the straight segment is realizable;
- only a crossing that *leaves* the glued cell counts (its interior is left of the counter-clockwise chain); a path running along a seam or touching it tangentially crosses nothing.

`surface_distance == planar_distance` (exact) when the floor has no active isometric fold.

### Bounds

All values below are world units; the bracket is `[lower, upper]` with `lower <= true <= upper`.

- **Upper bound.** `planar` (the no-crossing path) and every *traced* candidate: a frame `g` whose straight segment `s → g(t)` is followed seam by seam (`Tracer::walk`): each chain image it crosses, in order and in the leaving direction, switches the frame; the trace succeeds when the frame maps `t` onto the segment's end (a target on a seam also matches through the partner sheet). Candidates are tried nearest first, at most 64, at most 6 crossings, so the first success is the best upper bound. A traced path is a real polyline.
- **Seam bound (early out).** Let `S` be the union of the segments of all sides of all isometric seams. Any path through at least one seam has length `>= d(s, S) + d(S, t)`: all cells lie in one planar development and seams are the only way to leave it, so the leg before the first crossing and the leg after the last both lie in the development (their endpoints on `S`, `s` and `t` at their own planar positions) and they do not overlap; each is at least the distance from its endpoint to `S`. A path through no seam is at least `planar`. Hence `lower >= min(planar, d(s, S) + d(S, t))`, and when `d(s, S) + d(S, t) >= planar` the result is `planar`, exact, with no search. `d(·, S)` is computed lazily and cached per point; results are cached per `(source, target)`.
- **Periodic developments (cylinder, torus).** When every isometric seam is a pure translation, the group generated by the seam transforms is a lattice `L` (rank 1 or 2; a basis is picked from the translations and every translation must be an integer combination of it, otherwise the lattice proof is not applied). Every path through at least one seam unfolds to `s → t + v` for some `v ∈ L`, and a path through none is the `v = 0` case, so `lower >= min over v ∈ L of |s − t − v|` (never smaller than the seam bound). The minimum is found exactly: only `v` with `|s − t − v| < planar` matter, and with `σ` the smallest singular value of the basis they have integer coordinates within `planar / σ` of the coordinates of `s − t`, a finite box (a query that would enumerate more than 40 000 points skips the proof). The best `v` is traced as an upper bound; when the trace succeeds the two meet and the result is exact. The search over copies is therefore bounded by a proven region, so a shortest path through two seams on a torus is found.
- **Arbitrary isometric folds** (rotations, reflections, glued cubes, Möbius strips): no lattice, so the candidates are the distinct products of up to 3 seam transforms (at most 4096), tried nearest first. The result is exact only when the best traced upper bound meets `min(planar, seam bound)`; otherwise it is a bracket (`exact = false`).
- **Limits.** `surface_distance_at_most` stops as soon as the bracket decides (`upper <= limit` is `Yes`, `lower > limit` is `No`): after the seam bound, after the lattice bound, and at the first successful trace. A partial result is not cached.

### Lifecycle

A `SurfaceMetric` snapshots the field's active isometric folds at construction (build a new one after `set_topology`). It holds interior caches (`RefCell`), so it is neither `Sync` nor shared between threads: build one per thread/run. The unfolding candidates of the non-lattice case (products of up to 3 seam transforms) are built on first use.

### Singular vertices

At a vertex where the gluing is not flat (cube corners, cone points, the end of a partially glued edge) a shortest path may bend at the vertex instead of crossing a seam transversally. The search only traces straight unfoldings, so such a path is never produced: the upper bound stays a valid real path, possibly longer than the true distance, and the lower bounds stay sound (they do not assume straight paths). A result is `exact` only when the two bounds coincide, never because the search "finished". Bending at a seam endpoint is not searched.

### Not done

- `FoldRun` grouping (optional, internal): folds are processed one by one, every chain is an independent seam side.
- Consumer migration and the indeterminate-issue wiring (see "Follow-ups").

### Follow-ups (not in this ticket)

- `surface_distance` (done, #835, see "Surface distance") implements the result types and `compare`; consumers 1–7 migrate to it.
- Algorithm audit: each `Strict` consumer gets the indeterminate-issue wiring and a `maze-runner` fixture with an active non-isometric fold.
- `approximate_topology` is added to check/strategy params and the wasm/web config.
