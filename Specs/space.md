# Space: Tessellation, Field, MultiLevelField

Geometry layer of `maze-core` — how a maze's cells and their adjacency are represented, independent of `Graph` (which is purely a directed-edge structure with no geometry of its own). Covers the `Tessellation` trait, the single-level `Field<T>`, and the multi-level aggregator `MultiLevelField<T>`/`LevelId` (GitHub issue #334, part of epic #333 — Floors).

Module: `maze-core/src/space/`.

## Tessellation

> **Current API.** Superseded by "Target model: extensible tessellation" at the end of this file
> (GitHub epic #752). Each sub-issue rewrites the affected parts of this section when it lands.

```rust
pub trait Tessellation: Send + Sync + 'static {
    type CellId: Copy + Eq + Ord + Hash + Debug;
    type Face: Copy + Eq + Hash + Debug + 'static;

    fn is_valid_cell(&self, cell: Self::CellId) -> bool;
    fn faces_of(&self, cell: Self::CellId) -> &[Self::Face];
    fn neighbor(&self, cell: Self::CellId, face: Self::Face) -> Option<(Self::CellId, Self::Face)>;
    fn is_straight(&self, cell: Self::CellId, in_face: Self::Face, out_face: Self::Face) -> bool;
    fn shape_descriptors(&self) -> &[ShapeDescriptor];
    fn shape_of(&self, cell: Self::CellId) -> Option<CellShape<'_>>;
    fn cartesian(&self, cell: Self::CellId) -> (f64, f64);
    fn edge_position(&self, from: Self::CellId, to: Self::CellId) -> (f64, f64); // default: midpoint of endpoints
}
```

Four implementations: `SquareTessellation`, `HexTessellation`, `TriTessellation`, `CairoTessellation` (`space::square`/`hex`/`triangle`/`cairo`), each with its own cell-id (`SquarePoint`, `HexPoint`, `TriPoint`, `CairoPoint` — tessellation-internal coordinates; consumers only see `T::CellId`) and `Face` type.

**Cell vocabulary (GitHub issue #756).** The trait and the `Field`/`MultiLevelField` API use
"cell" for a tessellation tile: `T::CellId`, `is_valid_cell`, `cell_of`, `all_cells`,
`all_cells_with_level`, `cell_count`, `from_id_cells`, `split_cells`, `is_split_cell`; the
`maze-runner`/`maze-wasm` codec is `CellCodec` with `cell_from_xy`/`cell_to_xy`. Wire, project and
fixture keys (`split_points`, `[x, y]` coordinates) are unchanged here — they move with the opaque
`CellId` wire encoding (#759–#762).

**Instance (GitHub issue #755).** A tessellation is an instance: methods take `&self`, and one
instance per maze is shared via `Arc<T>` by `Field<T>` and `MultiLevelField<T>` (accessors
`tessellation() -> &T` and `shared_tessellation() -> &Arc<T>`). The four built-in tessellations
are zero-sized instances (`#[derive(Default)]`). Free functions built on the trait
(`face_index_toward`, `geometric_distance`, `geometric_edge_distance`, `floor_aware_distance`,
`floor_aware_edge_distance`) take the instance as their first argument; consumers resolve it from
the field (`maze.field.tessellation()`).

**Config and factory.** The wire, project and fixture formats store `{ "kind": "square" | "hex" |
"tri" | "cairo", "params": { … } }` (`maze-runner`'s `TessellationConfig`/`TessellationKind`).
`maze-runner::runner::tessellation_factory::build_tessellation(config, visitor)` is the single
place where the runtime kind becomes a compile-time `T`: it builds the instance, rejects params
the kind does not accept (`Err` with a reason; the built-in kinds accept none) and hands
`Arc<T>` plus the kind's wire point codec (`CellCodec`) to a `TessellationVisitor`. `maze-runner`
(full run, canonical baselines, benchmarks) and `maze-wasm` (generate, compute analytics,
`cartesian_coords`, `tessellation_shapes`) all dispatch through it.

**Per-cell neighbor contract (GitHub issue #756).** Passing an invalid cell, or a face not in
`faces_of(cell)`, to `faces_of`/`neighbor`/`is_straight` is a precondition violation
(`debug_assert`), not a `None` result.

- **`faces_of(cell)`** — the cell's faces, allocation-free (a borrowed slice), in the canonical
  circular order (counter-clockwise, GitHub issue #758): square `[E, N, W, S]`, hex `[E, NE, NW,
  W, SW, SE]`, triangle `[Base, Left, Right]` (pointing up, `Base` neighbor at `row - 1`) or
  `[Base, Right, Left]` (the other orientation), Cairo from `Twin` per orientation (R `[Twin, NW,
  SE, NE, SW]`, U `[Twin, SE, NE, SW, NW]`, L `[Twin, SE, SW, NW, NE]`, D `[Twin, NW, SW, NE,
  SE]`). Triangle and Cairo order therefore differs per cell. A cell has at most one face toward
  any neighbor, so `Field::neighbors` never visits the same neighbor twice.
- **`neighbor(cell, face) -> Option<(cell', face')>`** — the adjacent cell and the face of `cell'`
  that is the same boundary piece; `None` when no cell exists there (built-in tessellations: only on `i32` coordinate overflow). Cairo's offset tables carry the back face directly, indexed by face discriminant.
  Reciprocal for every tessellation (`neighbor(cell', face') == Some((cell, face))`), checked by
  `space_tests.rs`'s `neighbor_contract_tests`. Field membership is separate.
- **`is_straight(cell, in_face, out_face)`** — face-identity semantics, kept from the old
  `Field::is_straight` so canonical baselines match: straight iff `out_face` equals the face of the
  previous cell that `in_face` touches (`neighbor(cell, in_face).1`). Square/hex/tri answer from
  the face's `opposite()` table (`TriFace`: `Left ↔ Right`, `Base ↔ Base`); Cairo resolves the
  reciprocal face from its transition table. The geometric definition lands in #759.
  `neighbor_contract_tests` also checks `Field::is_straight` against an independent re-statement
  of the old definition (face of `from` toward `via` equals face of `via` toward `to`) for every
  tessellation.
- **`face_index_toward(tessellation, cell, other)`** (free function) — position in
  `faces_of(cell)` of the face reaching `other`, or `None` when `other` is not a tessellation
  neighbor. Used by the per-face split QC check.
- **`is_valid_cell`** identifies whether a coordinate represents an actual tile. `Field::new` and `Field::from_id_cells` reject invalid points before storing them.
- **`shape_descriptors`/`shape_of`** — the cell's shape template and allowed transform group (see
  "Shape templates" below). They are the only source of split-pattern variants; the old
  per-tessellation `rotation_symmetries`/`mirror_symmetries` tables, `transform_face_index` and
  `symmetry_degree` were removed in GitHub issue #758.
- **`cartesian`/`edge_position`** — pure geometry, no rendering-specific orientation. `geometric_distance<T>`/`geometric_edge_distance<T>` (free functions in `space::mod`) build on these for node-to-node/edge-to-edge Euclidean distance, unrelated to graph/nav distance (tile-hop count along real edges).

## Field\<T\>

```rust
pub struct Field<T: Tessellation> {
    tessellation: Arc<T>,
    cell_to_nodes: HashMap<T::CellId, Vec<NodeId>>,
    node_to_cell: HashMap<NodeId, T::CellId>,
}
```

The single-tessellation building block: a fixed set of cells, each resolving to one or more `NodeId`s (a cell splits into several routing passages via `add_node_at` — GitHub issue #219/epic #218). `Field` has no notion of "groups" or which geometric face belongs to which of a cell's several nodes — deciding that is entirely the caller's job (generation algorithms, QC/repair strategies).

Key methods: `new(tessellation: Arc<T>, cells, &mut IdGenerator) -> Result<_, _>`, `from_id_cells(tessellation: Arc<T>, entries) -> Result<_, _>` (rebuild preserving given ids, e.g. from a client snapshot — GitHub issue #236, while still rejecting invalid cells), `add_node_at`/`remove_node_at`/`replace_nodes_at` (cell-based, panic on an unknown cell), `nodes_at(cell)`/`node_at(cell)` (creation-order slice / first node), `neighbors(node)` (iterates `faces_of`, skips faces whose `neighbor` is `None`), `is_straight(from, via, to)` (resolves `via`'s faces toward `from` and `to` in one pass over `faces_of(via)`, then asks `Tessellation::is_straight`; `false` when either is not a tessellation neighbor), `cell_of(node)`, `all_cells()`/`all_node_ids()` (both `NodeId`-sorted, deterministic), `cell_count()` (distinct cells) vs `node_count()` (all nodes, inflated by splits — density/ratio QC checks must use `cell_count()`, GitHub issue #267), `contains(cell)`, `build_nodes(&mut Graph)`.

`Field`'s cell set is fixed at construction — `add_node_at`/`remove_node_at` only add/remove nodes *within* an existing cell, never grow or shrink the cell set itself. `Clone` is a manual impl (not derived): the tessellation instance is shared via `Arc`, never copied, so `T` itself needs no `Clone`.

This layer is unaffected by the multi-level work below — `Field<T>` remains the single-tessellation, single-level primitive it always was. Everything below is a wrapper around one-or-more `Field<T>` instances.

## MultiLevelField\<T\> and LevelId

Aggregates one `Field<T>` per level (floor) behind a single interface, plus an explicit `NodeId -> LevelId` map maintained at construction/mutation time — no linear scan, no derivation from ID ranges (GitHub issue #334). `Graph`/`IdGenerator` stay level-agnostic exactly as before: `NodeId`s remain globally unique across every level, and the graph itself never needs to know which level a node belongs to.

```rust
#[derive(Copy, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub struct LevelId(u32);

pub struct MultiLevelField<T: Tessellation> {
    levels: HashMap<LevelId, Field<T>>,
    level_order: Vec<LevelId>,
    node_to_level: HashMap<NodeId, LevelId>,
    next_level_id: u32,
}
```

`LevelId` is a stable, minted identifier — never an index into `level_order`, never reused, never renumbered when levels are added/removed/reordered. This is deliberate groundwork for GitHub issue #335 (add/remove/reorder floors UI), which relies on a level's id staying meaningful across structural changes to the level set.

### API shape: node-id-first

Operations addressing an existing node take only `NodeId` — the level is resolved internally via `node_to_level`, never required from the caller. This mirrors the fact that the graph itself is level-agnostic: growth algorithms (generation frontiers, QC/repair candidate pools) freely mix nodes from different levels in one structure without ever needing to know or pass a `LevelId`. `LevelId` is required only where a bare geometric point is otherwise ambiguous (point-based lookup/creation) or for managing the level set itself.

**Node-id-based (level resolved internally):**
- `level_of(node) -> Option<LevelId>`
- `cell_of(node) -> Option<T::CellId>`
- `neighbors(node) -> Vec<NodeId>` — empty `Vec` for an unknown node (mirrors `Field::neighbors`, not a panic)
- `is_straight(from, via, to) -> bool` — `false` unless all three resolve to the *same* level and are geometrically straight on it; a cross-level triple is never straight (geometric straightness is undefined between levels — a future stairs/elevator notion, GitHub issue #337, is a separate mechanism, not an extension of `is_straight`)
- `remove_node_at(node)` — resolves both level and point internally, unlike `Field::remove_node_at` which takes the point explicitly (redundant once derivable from the node). Panics if `node` doesn't belong to any level, mirroring `Field::remove_node_at`'s own panic-on-unknown-node contract — never a silent no-op.

**Point-based (level required — a bare point is ambiguous across levels):**
- `node_at(level, point) -> Option<NodeId>` / `nodes_at(level, point) -> &[NodeId]`
- `add_node_at(level, point, &mut IdGenerator) -> NodeId` — panics if `level` doesn't exist or `point` isn't already in that level's field
- `replace_nodes_at(level, point, new_ids: Vec<NodeId>)` — unmaps every old node currently at that point, then maps every id in `new_ids`; after the call, any old id not in `new_ids` gives `level_of(old_id) == None`, and every id in `new_ids` gives `level_of(new_id) == Some(level)`

**Level management:**
- `add_level(field: Field<T>) -> LevelId` — mints a fresh id, registers every node of `field` into `node_to_level`. Debug-asserts none of `field`'s nodes already belong to another level (a `NodeId` collision across levels would otherwise silently overwrite the mapping instead of signaling a broken invariant — the global per-`Maze` `IdGenerator` is expected to guarantee uniqueness, but the aggregator does not blindly trust callers). Also debug-asserts `field` shares the aggregator's tessellation instance (`Arc::ptr_eq`), skipped for zero-sized tessellations whose instances are indistinguishable.
- `remove_level(level) -> Option<Field<T>>` — removes the level and unmaps all of its nodes, returns the removed `Field` (or `None` if `level` doesn't exist). The caller decides what to do with the returned `Field`'s nodes (GitHub issue #335); this only guarantees the aggregator's own structure stays consistent afterward.
- `reorder_levels(&[LevelId])` — sets the display/iteration order. Panics (`assert_eq!`) if `new_order` isn't a permutation of the current level set — a structural invariant violation, not a recoverable runtime condition.
- `single_level_id() -> LevelId` — the aggregator's *first* level (by `levels_ordered()` position); panics only if there are no levels at all (never happens for a live `MultiLevelField` — every constructor adds at least one). QC/repair/routing/analytics/post-edit are all multi-floor-aware as of the GitHub issue #333 epic; the only remaining caller is `io::render_ascii`, a debug/example tool that only ever renders one floor by design.
- `field_of(level) -> Option<&Field<T>>` — read-only access to one level's underlying `Field`, for callers that need the full `Field` contract without level bookkeeping (rendering, geometry). Never `&mut`: every mutation must go through the aggregator's own node-id-based/point-based methods so `node_to_level` never drifts out of sync.
- `level_count()`, `levels_ordered() -> impl Iterator<Item = LevelId>`
- `level_index_of(node) -> Option<usize>` (GitHub issue #337) — `node`'s 0-based position in `levels_ordered()`, the web client's `floors` array index. Unlike `LevelId` (a stable minted id, never reused or renumbered), this is only valid until the next `add_level`/`remove_level`/`reorder_levels` call — recompute per snapshot, never cache across a mutation.

**Truly global aggregates (span every level, no `LevelId` required):**
- `all_node_ids() -> impl Iterator<Item = NodeId>` — every node across every level, sorted. For a single-level aggregator this is byte-for-byte identical to calling `all_node_ids()` on the wrapped `Field` directly — generation's RNG consumption depends on this exact ordering match.
- `max_node_id() -> Option<NodeId>`, `node_count() -> usize`
- `cell_count() -> usize` — total distinct field cells (points) across every level, summed. Ratio/density QC checks normalizing "per 100 field cells" use this, not `node_count()` (inflated by split tiles) and not any single level's own `cell_count()`.
- `all_cells_with_level() -> impl Iterator<Item = (LevelId, T::CellId)>` — every point across every level, grouped by level in `levels_ordered()` order, each level's own points in that level's `Field::all_cells()` order. For single-level or level-agnostic callers, prefer `field_of(level).all_cells()` instead — this is for genuinely level-aware code (multi-level UI/QC, split-topology aggregates that are conceptually maze-wide).
- `split_cells() -> impl Iterator<Item = (LevelId, T::CellId)>` (GitHub issue #614) — every split tile (a point with `nodes_at(level, point).len() >= 2`) across every level, each appearing exactly once. Shared replacement for the `all_cells_with_level()` + dedup + node-count-filter pattern QC checks, `cross_element`, and `split_topology` used to each repeat independently.
- `is_split_cell(level, point) -> bool` — `true` if that point carries `>= 2` nodes; `false` (not a panic) if `level`/`point` don't exist, mirroring `nodes_at`'s own contract. Used where only a single point's split status matters (e.g. `routing`'s per-node split counting), not a full enumeration.

### Constructors

- `single_level(tessellation: Arc<T>, points, &mut IdGenerator) -> Result<Self, &'static str>` — wraps a single `Field::new(tessellation, points, ids)` call into a one-level aggregator. The drop-in replacement for every pre-#334 `Field::new` call site across `maze-core`/`maze-wasm`/`maze-runner`; the resulting level's id is retrievable via `single_level_id()`.
- `new(tessellation: Arc<T>, levels: impl IntoIterator<Item = Field<T>>) -> Self` — builds from already-constructed `Field`s, one level per entry in iteration order. General-purpose constructor for genuinely multi-level scenarios and for wrapping a `Field` built via an alternate constructor (e.g. `Field::from_id_cells`, used by `maze-wasm`'s post-edit path) — not used by the single-level migration itself.

### Migration status (GitHub issue #334)

Every existing single-floor call site across `maze-core`, `maze-wasm`, and `maze-runner` was migrated from raw `Field<T>` to `MultiLevelField<T>` (via `single_level`), with no intended behavior change — same generation output (byte-identical RNG consumption, verified by comparing `all_node_ids()` order against direct `Field::all_node_ids()`), same QC/repair results, same project file format. `Maze<T>.field` is `MultiLevelField<T>`; `Maze::remove_node_at` resolves its node's level internally, while `Maze::add_node_at_on_level` takes the target level from the caller (no level-less `add_node_at` exists — every caller already knows which level it's adding to).

Raw `Field<T>` remains in use only:
- Internally, as the per-level storage `MultiLevelField` wraps.
- In `Field<T>`'s own unit tests (`maze-core/tests/field_test.rs`, `hex_field_test.rs`, `triangle_field_test.rs`, `multi_node_point_test.rs`) — single-tessellation-only tests that have no need for the aggregator.
- At `maze-wasm`'s post-edit path (`analytics/post_edit.rs`'s `build_field_from_nodes`), which constructs via `Field::from_id_cells` (preserving client-supplied ids) and then wraps the result with `MultiLevelField::new([field])`.

Built on top of this layer since: add/remove/reorder floors UI (#335), and — as of #337 — `CustomVertexBased` generation, which builds a field from `GenerateConfig.level_fields` (`maze-wasm`'s `dispatch_generate`/`build_multi_level_field`) and connects levels via `EdgeKind::VerticalPassage`/`Elevator` (`Specs/generation.md`'s "Vertical Connections"). As of #338, each level's own field *shape* is independent — `level_fields` carries one point-set per floor — though tessellation *kind* (`T`) is still fixed maze-wide (a `MultiLevelField<T>` uses one `T` for every level it holds — `Maze<T>`'s existing single-`T`-per-maze design). QC/repair/routing during generation is multi-floor-aware. `compute_analytics` (post-edit's confirm step and analytics/snapshot recompute) is genuinely multi-level as of GitHub issue #359 — `ComputeAnalyticsConfig` gained its own `level_fields`, mirroring `GenerateConfig`'s; `maze-wasm`'s `build_analytics_snapshot` always surfaces every floor now — the `all_levels: bool` param that used to gate this was removed (GitHub issue #355), since every real caller had passed `true` since #359 — see `Specs/floors.md`'s "`compute_analytics` multi-level awareness" section. Not yet built: a `LevelId`-aware project file format, or a wire-level way to vary tessellation kind itself between levels.

## Target model: extensible tessellation (GitHub epic #752)

Target contracts written by GitHub issue #754 ahead of the code changes in #755–#765. Core is the
single source of topology, geometry and field operations. A new tessellation (mixed-shape 4.8.8,
radial, Voronoi, …) is added by a core implementation plus a factory/registry entry, without
touching any consumer. Rules: generics only in core (no `dyn Tessellation`, no enum of
tessellations inside algorithms), no allocations on hot paths (`faces_of`, `neighbor`,
`is_straight`), deterministic results everywhere.

### Instance and config

- A tessellation is an **instance**, not a marker type. It is built deterministically from a
  config `{ kind, params }`: the same config always yields the same cell set, face order,
  neighbor relation, shapes and geometry. An instance may carry data (lookup tables, ring sizes,
  Voronoi sites). Invalid params are rejected by the factory with a reason (`Result`), never a
  panic.
- One instance per maze, shared via `Arc<T>` by `Field<T>` and `MultiLevelField<T>` (every
  level uses the same instance). The existing tessellations are zero-sized instances.
- Algorithm code is generic over `T: Tessellation`. Branching on `kind` is allowed only in
  factories (`maze-wasm`, `maze-runner`), registries (web UI metadata: name, orientations,
  default params) and serialization. It is forbidden in generation, QC, repair, editor and
  renderers.
- Wire, project and fixture formats store `{ "kind": "<kind>", "params": { … } }` (no combined
  values like `cairo_circle`; field shape is a separate setting). No migration of old formats.

### Topology contract

```rust
pub trait Tessellation: Send + Sync + 'static {
    type CellId: Copy + Eq + Ord + Hash + Debug;
    type Face: Copy + Eq + Hash + Debug;

    fn is_valid_cell(&self, cell: Self::CellId) -> bool;
    fn faces_of(&self, cell: Self::CellId) -> &[Self::Face];
    fn neighbor(&self, cell: Self::CellId, face: Self::Face) -> Option<(Self::CellId, Self::Face)>;
    fn is_straight(&self, cell: Self::CellId, in_face: Self::Face, out_face: Self::Face) -> bool;
    fn shape_descriptors(&self) -> &[ShapeDescriptor];
    fn shape_of(&self, cell: Self::CellId) -> Option<CellShape<'_>>;
}
```

The sketch fixes semantics, not exact signatures.

- **`CellId`** is opaque. It is valid only within the instance that produced it (equivalently,
  within the same config). Consumers never decode it or do arithmetic on it. The only exceptions
  are the tessellation implementation itself and, in the web, the geometry access layer (where
  `CellId` is a branded type). `Ord` exists only for deterministic ordering and tie-breaks. Its
  wire encoding is defined by the tessellation and round-trips only under the same config.
- **Precondition.** Passing a `CellId` that is not valid for the instance, or a face not in
  `faces_of(cell)`, to any topology method is a precondition violation (`debug_assert`), not a
  `None` result.
- **Face.** A face is a contiguous piece of a cell's boundary with exactly one neighbor (or no
  neighbor at the edge of the tessellation's space). A geometric side touching two neighbors is
  two faces. A cell has at most one face toward any given neighbor, so a cell's neighbors are
  pairwise distinct (`Field::neighbors` relies on this).
- **`faces_of(cell)`** is allocation-free (a slice borrowed from static or instance-owned data)
  and may differ per cell (mixed and radial tilings). Order is the canonical circular order:
  counter-clockwise along the cell boundary, starting at a tessellation-defined first face that
  is stable for the instance. (Built-in tessellations use it since #758.)
- **`neighbor(cell, face) -> Option<(cell', face')>`** returns the adjacent cell and the face of
  `cell'` that is the same boundary piece. `None` means no cell exists there in the
  tessellation's space. Reciprocity is mandatory and tested for every tessellation:
  `neighbor(c, f) == Some((c', f'))` implies `neighbor(c', f') == Some((c, f))`. Field
  membership is separate: a `Field` neighbor is a tessellation neighbor that is also in the
  field's cell set.
- **`is_straight(cell, in_face, out_face)`** has a geometric definition. Let `A` be the contact
  point of `in_face`, `C` the center of `cell`, and `B` the contact point of `out_face` (see
  "Geometry"). The triple is straight iff `in_face != out_face`, `dot(C − A, B − C) > 0`, and
  `|cross(C − A, B − C)| <= STRAIGHT_TOLERANCE · |C − A| · |B − C|`.
  `STRAIGHT_TOLERANCE = 1e-6` only absorbs floating-point noise; it is not an "almost straight"
  threshold. Implementations may answer from a table for speed, but a test checks every table
  against the geometric definition. Consequence: a triangle cell has no straight triple (every
  pass through it turns by 60°). The old face-identity check reports `Left → Left` /
  `Right → Right` as straight. Cairo straightness likewise follows geometry, not face-slot
  identity. Staging: #756 introduces the per-cell `is_straight` with the old face-identity
  semantics as tables, so canonical baselines still match. #759 switches it to the geometric
  definition, adds the table-vs-geometry test, and documents the resulting tri/Cairo generation
  changes together with the `cell_scale` change before its baseline update. Consumers
  (`graph::classify`, `generation::vertex_based`) call
  `Field::is_straight(from, via, to)`, which resolves the faces of `via` toward `from` and `to`.

### Shape templates

- **`ShapeDescriptor`** is a reusable topological template: a stable key, a face count `n`, the
  canonical circular face order `0..n` (counter-clockwise), and the template's symmetry group.
  The group is a list of permutations of canonical indices (`perm[i]` = image of canonical face
  `i`). Element 0 is the identity, and the list is closed under composition. The group is
  computed once per descriptor and cached. Descriptor families:
  - `RegularPolygon { n }`: dihedral group, `n` rotations + `n` reflections; key `regular:<n>`.
  - `CairoPentagon`: identity + the reflection that fixes the long side; key `cairo_pentagon`.
  - Tessellation-registered templates: key `<kind>:<name>`.

  Descriptors are equal iff their keys are equal. Geometrically identical cells with different
  face counts get different descriptors: a square whose one side is split into two faces is a
  5-face template, not `RegularPolygon { 4 }`. A descriptor also provides template geometry
  (a unit-scale outline in template coordinates) for UI drawing. Topology never uses it.
- **`shape_of(cell) -> Option<CellShape>`** returns:
  - the cell's descriptor;
  - `local_to_canonical`: a bijection from local face index (position in `faces_of(cell)`) to
    canonical index;
  - the cell's **allowed transform group**: a subgroup of the descriptor's group (contains the
    identity, closed under composition), given as indices into the descriptor's group. It is the
    full group by default. A tessellation restricts it where a template symmetry is not
    realizable for that cell.

  `None` means the cell has no template. It still has full topology and geometry, but split
  patterns never apply to it.
- **Face chain** `local → canonical → transformed → local`: for transform `g` in the allowed
  group, canonical face `k` of a template-relative object (for example a split-pattern face)
  lands on local face `local_to_canonical⁻¹(g[k])`. Reading a built cell back into template terms
  uses `local_to_canonical`. Every step is a bijection, so the chain is invertible.
- **Triangle** gets its full group: 3 rotations + 3 reflections. The old empty mirror table was
  an artifact of non-circular face order.
- The descriptor-level split-pattern contract (two-level applicability) lives in
  `split-patterns.md`.

Status (GitHub issues #757, #758): implemented in `space::shape` (`ShapeFamily`,
`ShapeDescriptor`, `CellShape` with the face-chain methods `canonical_of_local`,
`local_of_canonical`, `transformed_local`, `canonical_of_transformed_local`) and
`Tessellation::shape_descriptors`/`shape_of` for square (`regular:4`), hex (`regular:6`), tri
(`regular:3`) and Cairo (`cairo_pentagon`); every built-in cell gets its full group. Split
patterns, QC split matching, split topology and repair split planning consume it (see
`split-patterns.md`).

- Group element order: `RegularPolygon` lists rotations `i -> i + k` (`k = 0..n`) then
  reflections `i -> k - i` (mod `n`); `CairoPentagon` is `[identity, i -> -i mod 5]`; a
  `Registered` template is the closure of its generator permutations under composition, identity
  first, then breadth-first discovery order. A generator that is not a permutation of
  `0..face_count`, or a registered `kind` of `regular` (it would collide with `regular:<n>` keys),
  panics: templates are tessellation code, not user params.
- `CellShape` fields are private. It is built by `CellShape::full` or
  `CellShape::restricted(descriptor, local_to_canonical, allowed_transforms)`, which
  debug-assert that `local_to_canonical` is a permutation of `0..face_count` and the allowed set
  contains the identity and indexes the group. Using a transform outside the allowed set is a
  debug-asserted precondition violation.
- Built-in `faces_of` is the canonical order (#758), so `local_to_canonical` is the identity for
  every built-in cell; `shape_tests.rs` checks that, and checks the canonical order against
  `cartesian` neighbor angles. Template geometry is not implemented yet.

### Geometry

A separate API from topology (an extension trait over `Tessellation`). Coordinates are world
units, math convention (x right, y up, counter-clockwise positive). There is no screen Y flip,
orientation or pixel scale (see "Display transform").

- **Scale.** `cell_scale(cell) = sqrt(area(cell))`. For regular tessellations the world unit is
  chosen so a cell's area is 1. Distance-based QC thresholds are expressed in `cell_scale` units.
  This is an intentional scale change for hex/tri/Cairo versus the old `cartesian`, explained in
  #759 before its baseline update.
- **Point queries:**
  - `center(cell)`.
  - `contact_point(cell, face)`: the point where a corridor crosses the face, by default the
    arc-length midpoint of the face's segment chain. It is identical from both sides of the face.
  - `area(cell)`, `cell_scale(cell)`.
  - Point and region queries take a **scope**: either a cell set (e.g. a field level's cells, for
    selection and hit-testing) or the whole tessellation space (e.g. the field editor adding
    cells outside the current field). Candidates outside the scope are never returned and never
    win a tie-break.
  - `cell_at(point, scope)`: the in-scope cell whose closed boundary contains `point` (within
    `GEOM_EPS`). On shared boundaries and vertices the minimal `CellId` among the in-scope
    candidates wins. A point covered by no in-scope cell returns `None`.
  - `cells_in_region(region, mode, scope)`, with region a closed polygon. Modes:
    - `Intersects`: cell and region share at least one point, boundaries included.
    - `Contained`: the whole cell boundary lies inside the region.
    - `CenterInside`: `center(cell)` lies inside the region.

    Boundary tests use `GEOM_EPS`. The result is sorted by `CellId`. The tool picks the mode,
    never the tessellation.
- **`GEOM_EPS`** is the single world-unit tolerance (`1e-9`) for every geometric equality,
  containment and boundary test. It is distinct from `STRAIGHT_TOLERANCE` (relative, angular) and
  from `flatten` tolerance (caller-provided).
- **Canonical edge key.** Each face pair `(c, f) ↔ (c', f')` has key `(owner, owner_face)`, where
  owner is the side with the smaller `CellId`. A face with no neighbor is owned by its cell.
  Edge geometry is computed deterministically from the key and cached only for the requested
  area, never as a precomputed map of the whole (possibly infinite) space. Both cells get the
  same segments: the owner's run counter-clockwise along its boundary, and the other cell gets
  them reversed. Paired faces are therefore identical as segments and as flattened polylines.
- **Segments** (kinds: `Line`, `CircularArc`; more may be added) expose operations on a
  normalized parameter `t ∈ [0, 1]`, linear in arc length:
  - `point(t)` and `tangent(t)` (unit length).
  - `split(t) -> (Segment, Segment)`: the two halves share the split point exactly.
  - `length()`.
  - `reversed()`: `reversed().point(t) == point(1 − t)`.
  - `flatten(tolerance) -> polyline`: endpoints are exactly `point(0)` / `point(1)`, the maximum
    distance between the polyline and the true curve is at most `tolerance` (world units), the
    output is deterministic, and a line flattens to its two endpoints.
  - `path_commands()`.

  Consumers never inspect the segment kind: drawing uses path commands, geometric operations use
  polylines.
- **Path commands:** `MoveTo(p)`, `LineTo(p)`, `ArcTo { center, radius, start_angle, end_angle,
  ccw }`. Every renderer (Pixi, SVG, PNG) supports all three. A new segment kind adds its own
  command (e.g. `CubicTo` for Bézier segments) together with renderer support.
- **`BoundaryPath(cell)`** is the concatenation of each face's segment chain in `faces_of` order.
  Invariants, tested per tessellation:
  - closed: the last end equals the first start;
  - exact joints: each segment's end is the next one's start, emitted as identical coordinates;
  - no self-intersection;
  - counter-clockwise (positive signed area);
  - face order along the path equals `faces_of(cell)`.

### Field operations

Field-editing operations work on cell sets and live in core:

- **translate** by a world vector, which must be a translation symmetry of the tessellation;
- **reflect** across an axis (a world line), which must be a reflection symmetry;
- **preset field shapes** built from named params (the ported `square_rect`, `hex_hexagon`,
  `tri_*`, `cairo_rect` and the web generators from `storeHelpers`/`fieldConfig`).

Availability is separate from execution. The tessellation exposes which operations it supports
(and its preset list with param schemas) so the UI can hide unavailable tools. Execution returns
`Result<cells, FieldOpError>`, where the error carries a reason:

- `Unavailable`;
- `NotASymmetry`;
- `OutsideTessellation`: a mapped cell does not exist;
- `ConnectivityBroken`: the resulting cell set is disconnected.

Results are sorted by `CellId`.

### Display transform

A single web-side affine transform (rotation, reflection, scale, translation) applies to every
visual coordinate: cells, walls, markers, labels and export. Its inverse applies to hit-testing
and editor input. Hex flat/pointy and tri r0–r270 become instances of it. Core geometry knows
nothing about it, and changing it never invalidates geometry.

### Geometry snapshot lifecycle

`maze-wasm` exports immutable region snapshots for a cell set. A snapshot holds, per cell, the
boundary path commands, the flattened polylines (at the requested tolerance), the center and
`cell_scale`; per face, the contact point and segment data. Point queries (`cell_at`,
`cells_in_region`) are exported too. A snapshot is bound to the tessellation instance identity
and the field version (incremented on every cell-set change). The web geometry access layer
invalidates it when either changes, and never because of the display transform.
