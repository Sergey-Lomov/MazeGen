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
    // Geometry primitives (GitHub issue #759), see "Geometry" below:
    fn center(&self, cell: Self::CellId) -> Point;
    fn face_segments(&self, cell: Self::CellId, face: Self::Face) -> Vec<Segment>;
    fn candidate_cells(&self, min: Point, max: Point, limit: usize) -> Option<Vec<Self::CellId>>;
    fn area(&self, cell: Self::CellId) -> f64; // default: signed area of the boundary path
}
```

Fifteen implementations: `SquareTessellation`, `HexTessellation`, `TriTessellation`, `CairoTessellation`, `SquareOctagonTessellation`, `BrickTessellation`, `TrihexagonalTessellation`, `SnubHexagonalTessellation`, `SnubSquareTessellation`, `RhombitrihexagonalTessellation`, `TruncatedHexagonalTessellation`, `TruncatedTrihexagonalTessellation`, `ElongatedTriangularTessellation`, `CurvedQuadrilateralTessellation`, `RadialTessellation` (`space::square`/`hex`/`triangle`/`cairo`/`square_octagon`/`brick`/`trihexagonal`/`snub_hexagonal`/`snub_square`/`rhombitrihexagonal`/`truncated_hexagonal`/`truncated_trihexagonal`/`elongated_triangular`/`curved_quadrilateral`/`radial`), each with its own cell-id (`SquarePoint`, `HexPoint`, `TriPoint`, `CairoPoint`, `SquareOctagonPoint`, `BrickPoint`, `TrihexagonalPoint`, `SnubHexagonalPoint`, `SnubSquarePoint`, `RhombitrihexagonalPoint`, `TruncatedHexagonalPoint`, `TruncatedTrihexagonalPoint`, `ElongatedTriangularPoint`, `CurvedQuadrilateralPoint`, `RadialPoint` — tessellation-internal coordinates; consumers only see `T::CellId`) and `Face` type.

**Cell vocabulary (GitHub issue #756).** The trait and the `Field`/`MultiLevelField` API use
"cell" for a tessellation tile: `T::CellId`, `is_valid_cell`, `cell_of`, `all_cells`,
`all_cells_with_level`, `cell_count`, `from_id_cells`, `split_cells`, `is_split_cell`; the
`maze-runner`/`maze-wasm` codec is `CellCodec` with `cell_from_xy`/`cell_to_xy`. Wire, project and
fixture keys (`split_points`, `[x, y]` coordinates) are unchanged here — they move with the opaque
`CellId` wire encoding (#759–#762).

**Instance (GitHub issue #755).** A tessellation is an instance: methods take `&self`, and one
instance per maze is shared via `Arc<T>` by `Field<T>` and `MultiLevelField<T>` (accessors
`tessellation() -> &T` and `shared_tessellation() -> &Arc<T>`). The six built-in tessellations
are zero-sized instances (`#[derive(Default)]`). Free functions built on the trait
(`face_index_toward`, `cell_position`, `edge_position`, `geometric_distance`,
`floor_aware_distance`) take the instance as their first argument; consumers resolve it from
the field (`maze.field.tessellation()`). `edge_position` takes the `Field` instead, since it must
see folds.

**Config and factory.** The wire, project and fixture formats store `{ "kind": "square" | "hex" |
"tri" | "cairo" | "square_octagon" | "brick" | "trihexagonal" | "snub_hexagonal" | "snub_square" | "rhombitrihexagonal" | "truncated_hexagonal" | "truncated_trihexagonal" | "elongated_triangular" | "curved_quadrilateral" | "radial", "params": { … } }` (`maze-runner`'s `TessellationConfig`/`TessellationKind`).
`maze-runner::runner::tessellation_factory::build_tessellation(config, visitor)` is the single
place where the runtime kind becomes a compile-time `T`: it builds the instance, rejects params
the kind does not accept or requires (`Err` with a reason; every built-in kind but `radial` accepts none) and hands
`Arc<T>` plus the kind's wire point codec (`CellCodec`) to a `TessellationVisitor`. `maze-runner`
(full run, canonical baselines, benchmarks, geometry snapshots) and `maze-wasm` (generate, compute
analytics, `tessellation_shapes`, `tessellation_cell_types`, the geometry snapshot and point queries) all
dispatch through it.

**Wire points are validated at the boundary.** Per-cell `Tessellation` queries treat an invalid
cell as a precondition violation, so every wire entry point that accepts raw `[x, y]` points
decodes them with `CellCodec::decode_valid(&tessellation, points)`, which returns
`Err("invalid cell [x, y]")` for the first point that is not a cell. This covers the per-point
queries (`tessellation_shapes`, `tessellation_cell_types`), the `scope` of the geometry point and
region queries, and the geometry snapshot's cells. Field construction (`Field::new`) and the field
operations reject invalid cells on their own. The fold ends of a floor's `topology` are wire points
too: `maze-runner::topology_wire::decode_topology` rejects an undecodable or invalid cell naming
the fold and side (`folds[i].a: invalid cell [x, y]`), see `Specs/topology.md`, "Wire form". The
canonical config string used as the topology fingerprint is produced by
`topology_wire::tessellation_fingerprint` (kind plus sorted params).

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
- **`is_straight(cell, in_face, out_face)`** — geometric semantics (GitHub issue #759, see the
  target model's topology contract): square and hex answer from the face's `opposite()` table
  (a straight pass leaves by the opposite side); triangle and Cairo always answer `false` (every
  pass through a triangle turns by 60°, and no two Cairo contact points are collinear with the
  pentagon's centroid). `geometry::tests` checks every table against `is_straight_geometric` and
  `neighbor_contract_tests` checks `Field::is_straight` against it for every tessellation.
- **`face_index_toward(tessellation, cell, other)`** (free function) — position in
  `faces_of(cell)` of the face reaching `other`, or `None` when `other` is not a tessellation
  neighbor. Base adjacency only (geometry, `edge_position`); maze algorithms use the fold-aware `Field::face_index_toward` / `MultiLevelField::face_index_toward`, e.g. the per-face split QC check. `edge_position` takes the `Field` and is fold-aware (see "Folded faces" under "Geometry"); it falls back to the midpoint of the centers only for cells that share neither a face nor an active fold.
- **`is_valid_cell`** identifies whether a coordinate represents an actual tile. `Field::new` and `Field::from_id_cells` reject invalid points before storing them.
- **`shape_descriptors`/`shape_of`** — the cell's shape template and allowed transform group (see
  "Shape templates" below). They are the only source of split-pattern variants; the old
  per-tessellation `rotation_symmetries`/`mirror_symmetries` tables, `transform_face_index` and
  `symmetry_degree` were removed in GitHub issue #758.
- **Geometry primitives** (`center`, `face_segments`, `candidate_cells`, `area`) — see
  "Geometry" below. `cell_position`/`edge_position` (free functions in `space::mod`) resolve a
  cell's center or an edge's contact point together with its scale; `geometric_distance`,
  `floor_aware_distance` and `floor_aware_xy_distance` measure between them in `cell_scale` units,
  unrelated to graph/nav distance (tile-hop count along real edges). They are planar and ignore
  folds (`planar_distance` is their shared core); the fold-aware `SurfaceMetric` and its contract
  are in `Specs/topology.md`, "Distance contract" and "Surface distance".

## Field\<T\>

```rust
pub struct Field<T: Tessellation> {
    tessellation: Arc<T>,
    cell_to_nodes: HashMap<T::CellId, Vec<NodeId>>,
    node_to_cell: HashMap<NodeId, T::CellId>,
    topology: Option<ResolvedTopology<T>>, // folds resolved against the cell set, None = no folds
}
```

The single-tessellation building block: a fixed set of cells, each resolving to one or more `NodeId`s (a cell splits into several routing passages via `add_node_at` — GitHub issue #219/epic #218). `Field` has no notion of "groups" or which geometric face belongs to which of a cell's several nodes — deciding that is entirely the caller's job (generation algorithms, QC/repair strategies).

Key methods: `new(tessellation: Arc<T>, cells, &mut IdGenerator) -> Result<_, _>`, `from_id_cells(tessellation: Arc<T>, entries) -> Result<_, _>` (rebuild preserving given ids, e.g. from a client snapshot — GitHub issue #236, while still rejecting invalid cells), `add_node_at`/`remove_node_at`/`replace_nodes_at` (cell-based, panic on an unknown cell), `nodes_at(cell)`/`node_at(cell)` (creation-order slice / first node), `neighbor_via(cell, face)` (effective adjacency: active fold, else `Tessellation::neighbor`; GitHub issue #832, `Specs/topology.md`), `face_index_toward(cell, other)`, `set_topology`/`clear_topology`/`topology`/`fold_activity`, `neighbors(node)` (iterates `faces_of`, goes through `neighbor_via`, skips faces with no crossing), `is_straight(from, via, to)` (resolves `via`'s faces toward `from` and `to` through `neighbor_via` in one pass over `faces_of(via)`, then asks `Tessellation::is_straight`; `false` when either is not a tessellation neighbor), `cell_of(node)`, `all_cells()`/`all_node_ids()` (both `NodeId`-sorted, deterministic), `cell_count()` (distinct cells) vs `node_count()` (all nodes, inflated by splits — density/ratio QC checks must use `cell_count()`, GitHub issue #267), `contains(cell)`, `build_nodes(&mut Graph)`.

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

**Folds (GitHub issues #831, #832).** Per-floor topology (cylinder/torus/twisted gluings of two faces, addressed by `(cell, face_idx)` with `face_idx` the position in `faces_of(cell)`) lives in `space::topology` and is installed per level with `Field::set_topology` / `MultiLevelField::set_topology`. `Field::neighbor_via(cell, face) -> Option<Crossing>` is the effective adjacency (active fold, else `Tessellation::neighbor`); `Field::neighbors`, `Field::is_straight`, `Field::face_index_toward` and every maze algorithm use it. `Tessellation::neighbor` is the base adjacency, called directly only from `space/` (geometry, `field_ops`, tessellation implementations) and the runner's geometry snapshot — enforced by a guard test. Without folds behaviour is unchanged. See `Specs/topology.md`.

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
    fn cell_types(&self) -> &[CellType];
    fn cell_type_of(&self, cell: Self::CellId) -> CellTypeId;
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
  changes together with the `cell_scale` change before its baseline update (done, see
  `baselines.md`). Consumers
  (`graph::classify`, `generation::vertex_based`) call
  `Field::is_straight(from, via, to)`, which resolves the faces of `via` toward `from` and `to`.

### Cell types

Status (GitHub issue #822): core API, config resolution and UI query are implemented; no QC rule
or generator consumes them yet.

- **`CellType`** is a tessellation-defined class of cells with a stable key (e.g. `octagon`,
  `square`), unique within the instance. `cell_types()` lists every type of the instance once and
  is never empty. `CellTypeId` is the position of a type in that list and is valid only for the
  instance that produced it.
- **`cell_type_of(cell) -> CellTypeId`** assigns a type to every valid cell (an invalid cell is a
  precondition violation). Allocation-free.
- **Independent of shapes.** A type may depend on the cell's position in the pattern, not only on
  its `ShapeDescriptor`, and cells of different types may share a shape. Types never affect
  topology or geometry.
- **Default.** A tessellation that does not override the methods has the single type `cell`, so
  consumers need no special case for uniform tilings. Built-in tessellations that mix polygons
  (4.8.8, 3.6.3.6, 3.12.12, 3.4.6.4, 3.3.4.3.4, 3.3.3.3.6, 4.6.12, 3.3.3.4.4) type cells by
  polygon: keys `triangle`, `square`, `hexagon`, `octagon`, `dodecagon`.

**Consuming types (QC rules, generator settings).** A new consumer adds only its own parameter and
reads it per cell; it never touches the type plumbing.

- **Config.** A per-type parameter is a map from type key to value (`BTreeMap<String, V>` in Rust,
  `Record<string, V>` on the wire), plus a default for types it does not name. Configs name types
  by key, never by `CellTypeId`, so they stay valid across serialization. Keys are unique only
  within one tessellation instance, so a stored config is meaningful for its tessellation kind.
- **Resolution.** `CellTypeTable::from_overrides(tessellation.cell_types(), &map, default)` resolves
  the keys against the built instance into one value per type, and fails with a message naming the
  unknown key and the known ones — a key the instance does not have is a config error, not ignored.
  `table.get(tessellation.cell_type_of(cell))` is the per-cell lookup. Build the table once per run,
  not per cell.
- **Helpers.** `cell_type_by_key(types, key)` and `Tessellation::cell_type_key_of(cell)` convert
  between ids and keys.
- **UI.** The `tessellation_cell_types` wasm export (`maze-wasm/src/geometry.rs`) takes
  `{ tessellation, points }` like `tessellation_shapes` and returns `{ keys, point_types }`: every
  type key of the instance and the type key of each point; a point that is not a cell is an error (`invalid cell [x, y]`), not a
  default answer. `mazeService.getTessellationCellTypes`
  wraps it. The UI offers exactly `keys` and stores the chosen keys in the consumer's config.

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
  neighbor center angles. Template geometry is not implemented yet.

### Geometry

A separate API from topology (an extension trait over `Tessellation`). Coordinates are world
units, math convention (x right, y up, counter-clockwise positive). There is no screen Y flip,
orientation or pixel scale (see "Display transform").

- **Scale.** `cell_scale(cell) = sqrt(area(cell))`. For regular tessellations the world unit is
  chosen so a cell's area is 1; Cairo pentagons are area 1 too. Distance-based QC thresholds are
  expressed in `cell_scale` units (`quality_control.md`'s "Geometric distance"). This was an
  intentional scale change for hex/tri/Cairo versus the old per-tessellation `cartesian`
  projection (#759, `baselines.md`).
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
- **Folded faces.** A face glued by an active fold is unpaired: `Field::edge_owner`, `edge_segments` and `contact_point` give it its own segments and contact point, and `space::edge_position` takes a `Field` so that across a fold it resolves the folded face's own contact point. Folds are classified isometric or topological-only (`Field::fold_class`). See `Specs/topology.md`, "Fold geometry". Without folds nothing changes.
- **Segments** (kinds: `Line`, `CircularArc`; more may be added) expose operations on a
  normalized parameter `t ∈ [0, 1]`, linear in arc length:
  - `point(t)` and `tangent(t)` (unit length).
  - `split(t) -> (Segment, Segment)`: the two halves share the split point exactly.
  - `length()`.
  - `reversed()`: `reversed().point(t) == point(1 − t)`.
  - `flatten(tolerance) -> polyline`: endpoints are exactly `point(0)` / `point(1)`, the maximum
    distance between the polyline and the true curve is at most `tolerance` (world units; a
    tolerance below `GEOM_EPS` is raised to it, so the piece count stays bounded), the output is
    deterministic, and a line flattens to its two endpoints.
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

Status (GitHub issue #759): implemented in `space::geometry`.

- **Split of responsibilities.** A tessellation implements four primitives on `Tessellation`:
  `center`, `face_segments(cell, face)` (the face's segments counter-clockwise along `cell`'s
  boundary — consumers never call it directly), `candidate_cells(min, max, limit)` (a superset of
  the cells whose boundary may touch a box, the candidate source for whole-space queries; `None`
  when there would be more than `limit`, counted before any is built) and `area`
  (defaults to the boundary's signed area; the built-ins return `1.0`, checked against the
  boundary by tests). Everything else is the `TessellationGeometry` extension trait (blanket impl
  for every `Tessellation`): `edge_owner` (the canonical edge key), `edge_segments` (owner-side
  `face_segments`, reversed for the other side), `boundary_path`, `contact_point` (computed on the
  owner side), `cell_scale`, `cell_at`, `cells_in_region`. `CellScope` is `Space` or
  `Cells(&[CellId])` — a cell set sorted by `CellId` without duplicates; membership is a binary
  search. `contact_point` is `chain_midpoint` (the arc-length midpoint) of the owner-side face
  segments. `is_straight_geometric` is the definition the `is_straight`
  tables are tested against.
- **Built-in geometry.** Square: unit squares, cell `(x, y)` spans `[x, x + 1] × [y, y + 1]`. Hex:
  flat-top hexagons, face `k` of `[E, NE, NW, W, SW, SE]` runs between the vertices at
  `60k − 60°` and `60k°`. Triangle: `pointing_up` cells have their base on top. Cairo: the base
  pentagon `(4,0), (6,6), (0,8), (-6,6), (-4,0)` (lattice unit `√2/12`, so the area is 1) turned
  counter-clockwise per orientation (U 0, L 1, D 2, R 3 quarter turns) and placed at
  `3 · (x, y)` plus the orientation offset (U `(0,-3)`, L `(3,0)`, D `(0,3)`, R `(-3,0)`), with each face's edge found once per orientation by
  matching vertices with the neighbor. Every vertex is an integer lattice point times a
  per-tessellation unit, so a vertex shared by several cells has identical coordinates from each
  of them (exact joints by construction, not by tolerance). Centers are area centroids.
- **Segments.** `Segment::Line` and `Segment::CircularArc` (explicit `from`/`to` endpoints plus
  center, radius, start angle and signed sweep, so joints stay exact). `flatten` cuts an arc into
  the fewest equal pieces whose sagitta stays within the tolerance; interior points interpolate between the endpoint vectors with weights built from the piece indices alone, so an arc and its `reversed()` flatten to bit-identical point lists. Containment, bounds and region
  tests are exact for arcs (never flattened): the ray test cuts an arc at its y-extrema into
  y-monotone pieces with the same half-open rule as lines, and region tests intersect region
  edges with the circle (`touches_line`, `crosses_line`; tangency touches but never crosses). Only
  the curved quadrilateral tessellation uses arcs.
- **Region size limit.** With `CellScope::Space`, `cells_in_region` returns
  `Err(RegionTooLarge)` when the region's bounding box holds more than `MAX_REGION_CANDIDATES`
  (250 000) candidate cells, before building any — an oversized request fails fast instead of
  stalling. Callers keep such requests within it (the web clamps selections, #761). With
  `CellScope::Cells`, the query examines only the scope's cells, so any region size is accepted.
  `cell_at` has no limit (its box is a point).
- **Scale between two positions.** A distance between two positions is divided by the **mean**
  of their `cell_scale`s (an edge position's scale is the mean of its two cells'). For the
  built-in tessellations every scale is 1; for a tiling mixing cell sizes this keeps the measure
  symmetric and independent of which side is "first".

### Field operations

Field-editing operations work on cell sets and live in core (`space/field_ops.rs`, GitHub issue
#760):

- **translate** by a world vector, which must be a translation symmetry of the tessellation;
- **reflect** across an axis (a world line through two points), which must be a reflection
  symmetry;
- **preset field shapes** built from named integer params: `rect`, `parallelogram`, `circle`,
  `triangle` and `hexagon` (the ported `square_rect`, `hex_hexagon`, `tri_*`, `cairo_rect` and the
  web generators from `storeHelpers`/`fieldConfig`).

Availability is separate from execution. `Tessellation::field_operations` lists the supported
operations and `Tessellation::presets` its preset list, each `PresetDescriptor { key, params }`
with `PresetParam { name, min }`, so the UI can hide unavailable tools and build param forms.
`Tessellation::preset_param_max(key, name)` optionally adds an upper bound that depends on the
instance (default `None`); `field_capabilities` carries it as `max` on the param, and the editor
prefers it to its own fallback limit.
Translate and reflect run through the `FieldOps` extension trait (blanket impl); presets through
`Tessellation::build_preset(key, params)`. Execution returns `Result<cells, FieldOpError>`, where
the error carries a reason:

- `Unavailable`: the operation or preset is not offered;
- `NotASymmetry`: the vector or axis is not a symmetry (decided geometrically: every cell around
  the origin, or around the axis, must map onto a cell with the same boundary vertices and segment midpoints, which tells a convex arc from a concave one over the same chord);
- `OutsideTessellation`: an input cell is invalid, or a mapped cell does not exist;
- `InvalidPreset(reason)`: unknown or missing params, a value below its minimum, a parameter
  product above 1,000,000 or a shape too large to build, or one that contains no cells.

Results are sorted by `CellId`. An empty input yields an empty result.

Presets are built in canonical math orientation — there is no orientation param, because core
geometry knows nothing about the display transform. All sizes are world units (cell area 1), the
shape is centered on the tessellation origin (the origin cell's center, or the lattice origin for
Cairo) and a cell is in when its center is inside, within `1e-6`. Lattice-exact shapes (the square
and hex rectangles, hex parallelogram and hexagon, tri rectangle, triangle and hexagon, Cairo
rectangle) are built from lattice coordinates; `circle` (the tri circle takes whole cells),
`triangle` (apex up) and `hexagon` (vertices on the x axis, Cairo only) are rasterized through the
cell geometry. The hex rectangle has screen-aligned sides on the flat-top lattice core uses.

Wire (`maze-runner::runner::field_ops`, exported by `maze-wasm`): `field_capabilities`,
`field_preset`, `field_preset_extents`, `field_translate_cells`, `field_reflect_cells`; failures are
`{ kind, message? }` with `kind` one of the reasons above (`invalid_request` for a malformed
request; also returned for non-finite vector or axis coordinates). `field_preset_extents` takes a preset plus two world directions and returns the `[min, max]` extent of the shape's cell boundaries along each, without shipping the cells (print-fit sizing evaluates many candidate sizes); it flattens only the cells whose centers lie within twice the cell reach (centre-to-farthest-boundary-point distance) of the center limits. The reach is the maximum over the cells at the limits and the first cell of every distinct shape descriptor, so a tessellation of mixed sizes (a dodecagon beside a triangle in 3.12.12, a dodecagon beside a square in 4.6.12) is not underestimated; cells of one shape are assumed near-uniform. Future extension: let a tessellation choose its extent mode (for example a core-supplied upper bound of cell reach, or an exact full scan when none is given), with a shared test comparing every mode against the full scan on small fields. The web `configAllCells` treats
`invalid_preset` as an empty field and caches built presets by tessellation, key and params.

### Display transform

A single web-side affine transform (rotation, reflection, scale, translation) applies to every
visual coordinate: cells, walls, markers, labels and export. Its inverse applies to hit-testing
and editor input. Hex flat/pointy and tri r0–r270 become instances of it. Core geometry knows
nothing about it, and changing it never invalidates geometry.

### Geometry snapshot lifecycle

`maze-wasm` exports immutable region snapshots for a cell set. A snapshot holds, per cell, the
boundary in the one representation the request asks for — exact path commands (`{ kind: "path" }`,
arcs included, the caller decides how to flatten them) or a polyline flattened at a tolerance
(`{ kind: "polyline", tolerance }`) — never both, plus the center and `cell_scale`; per face, the contact point and segment data. Point queries (`cell_at`,
`cells_in_region`) are exported too. A snapshot is bound to the tessellation instance identity
and the field version (incremented on every cell-set change). The web geometry access layer
invalidates it when either changes, and never because of the display transform.

Status (GitHub issue #759): `maze_runner::runner::geometry` builds snapshots
(`geometry_snapshot(GeometrySnapshotRequest { tessellation, cells, boundary, field_version })`,
computing each canonical edge's segments and contact point once per snapshot and only for the
requested cells, and assembling each boundary path from them) and answers
`cell_at`/`cells_in_region` requests (scope: a cell list in any order, sorted and deduplicated by the
runner, or `None` for the whole space); `maze-wasm`
exports them as `geometry_snapshot`, `geometry_cell_at`, `geometry_cells_in_region`. The snapshot's
`instance` is the serialized tessellation config (equal configs build equal instances) and
`field_version` is echoed from the request — the web owns the version counter (#761). An invalid
cell or a polyline request with a non-positive tolerance is an error.

Status (GitHub issue #833): the request may carry `topology_version` and `topology`
(`{ field_cells, folds: [{ a, b, twist, group }], groups }`, cells as `[x, y]` and `face_idx` a position in
`faces_of`). `field_cells` is the floor's whole cell set, which decides fold activity (the requested `cells` may be a
region of it); it must be non-empty and hold only valid cells, otherwise the request is an error. The topology is
validated structurally and resolved like `Field::set_topology`, and an invalid one is an error. The snapshot echoes `topology_version` and is bound to the field version **and** the topology version: the web
invalidates it when either changes. Every face of an active fold carries `fold`
(`{ fold, partner_cell, partner_face_idx, twist, start_meets, isometric, transform }`): the partner `(cell, face)`, the endpoint
correspondence (`start_meets`: which end of the partner's chain this face's chain start meets, `end` untwisted, `start`
twisted; plus `twist`) and, for an isometric fold, the affine matrix `[a, b, c, d, e, f]` mapping the partner's face geometry
into this cell's coordinates (the inverse of the class transform on side `b`). The face's `segments` and `contact_point` are
its own, unpaired. The web never derives any of this from coordinates. Without `topology`, or with no active fold,
the snapshot equals the plain one. A folded face's `neighbor` is still the base `Tessellation::neighbor` (possibly a cell
outside the field); the glued partner is given by `fold` only. The snapshot rebuilds its `Field` on every call. The benchmark measures the snapshot as its
`geometry` stage.

Status (GitHub issue #761, first step): `maze-web/src/pixi/cartesianCache.ts` is the web geometry
access layer. It holds the snapshot of the current field's cells, invalidated by the tessellation
instance (the serialized config) and a web-owned field version (bumped when the cell set or the
instance changes) — never by the display transform. Reads (`getCellGeometry`, `getCartesian`) are
synchronous; a cell outside the field costs one single-cell snapshot call and lives in a bounded LRU (`DEFAULT_MAX_OUTSIDE_CELLS`); field cells are never evicted. Point and region queries
(`cellAtWorldPoint`, `cellsInWorldRegion`) are scoped to the field's cells by default, so a selection
over a zoomed-out canvas never reaches `MAX_REGION_CANDIDATES`; `CellId` is a branded tuple. The web
test suite requires the wasm build (`tools/require-wasm.mjs`; `scripts/test.sh`/`scripts/windows/test.ps1` rebuild it).

Status (GitHub issue #761, second step): `maze-web/src/pixi/geometry/` holds the generic consumers
of core geometry. `pathRenderer.ts` draws the path commands of a `{ kind: "path" }` snapshot (the web cache requests the path commands too, see #763) (`tracePath` onto Pixi `Graphics` or a
canvas 2D context, `pathToSvg` for SVG; PNG export goes through Pixi; `tracePath` traces an arc as chords of at most π/32 whose end points lie exactly on the circle, so arcs sharing a vertex join exactly and an arc and its reverse trace the same points) after a `WorldTransform` — a
similarity (rotation, reflection, uniform scale, translation) so arcs stay arcs; a reflection
reverses an arc's direction. `polylineOps.ts` works on flattened polylines: `closestPointOnPolyline`,
`polylineIntersections` (touching ends count, parallel and collinear segments give none) and
`offsetPolyline` (left of travel is positive, miter join bevelled past a limit, no self-overlap
trimming). Coincidence tests use `GEOM_EPS` (`1e-9`), the same world-unit tolerance as core;
results are exact for the polyline and within the snapshot's flatten tolerance of the true curve.

Status (GitHub issue #761, third step): the web has no per-tessellation geometry code.
`FaceGeometry` also carries `neighbor` (the adjacent cell, `None` at the field edge) and
`canonical_face` (the template's canonical index of the local face), so the web needs no face tables.
`pixi/geometry/tessellationUi.ts` holds only UI metadata per `kind` (name, orientations, default
params, the display base transform and pixel sizes). `pixi/tessellationGeometry.ts` derives cell
centers, vertices, shared edges, neighbor offsets, and nearest-cell lookup from the snapshot through
the display transform (`pixel = pixelsPerUnit · Orient · Base · core`). Face indices of cells in the web —
split blueprints, post-edit and preset face editors — follow core's `faces_of` order
(counter-clockwise), the same order the generator reads. A pattern's `face_index` is the shape
template's canonical index everywhere; the pattern editor reads the anchor tile through the anchor
cell's `canonical_face` (`anchorCanonicalFaces`).

Status (GitHub issue #764): `CellGeometry` also carries `shape` (the cell's `ShapeDescriptor` key:
`regular:4`, `regular:6`, `cairo_pentagon`, …). Special split shape recognition (`bridge`, `diagonal`,
`hex_*`, `cairo_*`), their node positions and semantic names are keyed on that shape and evaluated on
the template's canonical faces (`splitShapeBinding`, `pixi/splitShape.ts`), not on the tessellation
kind or the cell's face count. Shared-edge contact points come from core's `contact_point` for every
face. `CellGeometry` carries `allowed_group` (the cell's allowed transforms as canonical-face permutations,
identity first); split-point rotation (`rotateFaceIndex`) applies the group element that shifts every
canonical face by one step and is unavailable (controls hidden, faces unchanged) when the group has none,
as for Cairo (identity + one reflection). The corridor contour engine orders ports with an angular epsilon so float noise at the ±π
branch cut cannot reorder them.

Status (GitHub issue #762): the field editor is built on core's geometry and field operations.
Selection, editor primitives, nearest-cell lookup and print layout use the snapshot geometry;
moving a selection, the symmetry tool and the preset shapes call `field_translate_cells`,
`field_reflect_cells` and `field_preset`. `field_capabilities` decides which shapes, parameter
forms and tools the editor offers (a tool whose operation is unavailable is hidden). Refusals
(`FieldOpError`) are shown to the user. The web does no arithmetic on `CellId`s outside the geometry
access layer. Each floor holds one `selectedShape` instead of per-kind shape fields.

Status (GitHub issue #763): drawing and hit-testing work from core geometry snapshots through the
single display transform. The cache requests `{ kind: "path" }` boundaries and derives a flattened
`polyline` per cell (`pixi/geometry/pathFlatten.ts`, tolerance `1e-3` world units). Cells, walls,
one-way markers, edge highlights and the grid draw with `tracePath` on the display-space path
(`getCellPath`, `SharedEdge.path`); geometric operations (hit-testing, wall chaining, boundary
highlight bands, region contours, `closestPointOnPolyline`, `offsetPolyline`, `trimPolyline`) use
polylines. `getSharedEdgeSegment` returns a `SharedEdge` (`v0`, `v1`, `path`, `polyline`, `contact`);
markers and corridor crossings sit at the face's contact point, taken from core for every face; `getTileDiagram` sides carry the same `contact`, relative to the tile center. Print-fit treats a shape core refuses as not fitting. No consumer inspects the segment type. Print-fit sizing
measures presets with `field_preset_extents` along the rows of the display transform. The
triangle/hexagon selection shapes, equilateral snapping (`TessellationUi.equilateralSnap`: step and canonical offset in core space, turned by the orientation),
primitive hexagon frames and hex connector axes take their orientation from the display
transform's orientation instance, so orientation exists only as a `displayTransform` instance. The
corridor contour engine stays polygon-based (convex cells); split-pattern geometry belongs to #764.

### UI registry and kind branching (web)

`TESSELLATION_UI[kind]` is the only place the web names a kind outside serialization
(`store/projectExport/`) and `fieldConfig.ts`. Besides display metadata it carries
`orientationSlot` (which maze-wide orientation setting the kind uses) and an `editor` block of lattice-dependent behavior: axis-aligned grid, rect label,
closed-form cell counts, lattice primitives, circle inclusion and the cell-size label of the print
dialogs and PNG result. Per-kind connector axes live in a `Record` lookup next to the connector
router. `architectureKindBranching.test.ts` fails on any `kind === "<kind>"` comparison elsewhere in
`maze-web/src`.

### Square-octagon tessellation (4.8.8)

Status (GitHub issue #784): `space::square_octagon` (`SquareOctagonTessellation`, kind `square_octagon`, no params) is the truncated square tiling. Regular octagons and squares turned by 45° share edges of world length 1 (octagon area `2 (1 + √2)`, square area 1, so `cell_scale` differs between the two).

- **Cell ids.** `SquareOctagonPoint { x, y }` on a lattice of half the octagon pitch: both coordinates even is an octagon, both odd is a square, mixed parity is not a tile (`is_valid_cell` is false). Negative coordinates follow `rem_euclid`. `SquareOctagonPoint::step(face)` is the direct neighbor calculation and returns `None` for a non-tile, a cardinal face of a square, or `i32` overflow.
- **Faces.** One `SquareOctagonFace` enum of the eight compass directions. An octagon has all eight, counter-clockwise from `E` (`regular:8`); a square has `NE, NW, SW, SE` (`regular:4`). `neighbor(c, f)` is `step(f)` with the opposite face; an octagon reaches octagons through `E, N, W, S` and squares through the diagonals, a square reaches four octagons.
- **Straightness.** A pass is straight iff it leaves through the opposite face (table, checked against the geometric definition).
- **Geometry.** Every vertex coordinate is `(m + n·√2) / 2` for integers `m`, `n` derived from the lattice point, so a vertex shared by several cells is bit-identical from each. `candidate_cells` counts the valid lattice cells in the box exactly before building any.
- **Presets.** `rect` (`cols × rows` octagons plus the squares between them, origin octagon at `size / 2`), `circle` and `triangle`; translate and reflect are derived geometrically.
- **Wire and web.** `{ "kind": "square_octagon", "params": {} }`; points are `[x, y]` pairs. Web entry `TESSELLATION_UI.square_octagon` (no orientations, `pixelsPerUnit = TILE_SIZE`), connector axes at 0°, 45°, 90°, 135°. Tessellation-specific split templates are not part of this ticket.

### Brick tessellation (offset-row squares)

Status (GitHub issue #789): `space::brick` (`BrickTessellation`, kind `brick`, no params) is the running-bond layout: unit squares in rows, every odd row shifted right by half a cell. Cell `(x, y)` is row `y`, column `x` and spans `[x + s, x + s + 1] × [y, y + 1]` with `s = 1/2` on odd rows (`rem_euclid`, so negative rows follow the same rule) and `0` on even ones. Area 1, one shape template.

- **Faces.** One `BrickFace` enum `E, NE, NW, W, SW, SE`, counter-clockwise from `E` (also the canonical order). `E`/`W` are whole vertical edges; the top and bottom edges are each shared with two cells of the adjacent row, so they are split into the half faces `NE`/`NW` and `SW`/`SE` (each of world length 1/2). Template `brick:brick` (6 faces); its group is the closure of the two axis mirrors (`[3,2,1,0,5,4]`, `[0,5,4,3,2,1]`), so 4 elements including the half turn.
- **Neighbors.** `step(face)`: `E`/`W` are `x ± 1`; from an even row `NE`/`NW` are `(x, y+1)`/`(x-1, y+1)` and `SE`/`SW` are `(x, y-1)`/`(x-1, y-1)`; from an odd row `NE`/`NW` are `(x+1, y+1)`/`(x, y+1)` and `SE`/`SW` are `(x+1, y-1)`/`(x, y-1)`. Every cell is valid and has exactly six distinct neighbors; `neighbor` returns the opposite face, and `None` on `i32` overflow.
- **Straightness.** A pass is straight iff it leaves through the opposite face (`NE`↔`SW`, `NW`↔`SE`, `E`↔`W`); the centers of such a pair of neighbors are collinear with the cell's center.
- **Geometry.** All vertex coordinates are multiples of 1/2, computed from integer half units, so a vertex (including the one splitting a top edge) is bit-identical from every cell sharing it and a half face of one cell reversed equals the matching half face of its neighbor. `candidate_cells` is the exact index box around the query box.
- **Presets.** `rect` (`cols × rows` cells, origin cell at `size / 2` rounded down; ragged because of the shifted rows), `circle` by cell center, and `triangle`, a pyramid rather than an equilateral triangle: `side` is the number of bricks in the bottom row and every row above has one brick fewer, each resting on two below it (sides rise at `atan(2)` ≈ 63.4°, which the half-cell row shift follows exactly, where an equilateral triangle's 60° would leave a ragged edge; `side (side + 1) / 2` cells, at most 1 000 000). Translate and reflect are derived geometrically (a vector must keep the row parity shift, e.g. `(1, 0)` or `(1/2, 1)`; `(0, 1)` is not a symmetry).
- **Wire and web.** `{ "kind": "brick", "params": {} }`; points are `[x, y]` pairs. Web entry `TESSELLATION_UI.brick` (no orientations, `pixelsPerUnit = TILE_SIZE`, `FLIP_Y`), connector axes at 0° and 90°. Tessellation-specific split templates are not part of this ticket.

### Shared multi-shape machinery

Status (GitHub issue #811): the anchor-lattice tessellations (trihexagonal, snub hexagonal, snub square, rhombitrihexagonal, truncated hexagonal, truncated trihexagonal) share two internal modules; the per-tessellation sections below only describe what differs.

- **`space::multi_shape`** (all six). `AnchoredPoint<K>` is the cell id `{ q, r, kind }`, with `K: CellKind` (`all()` in wire order, `index()`); `XPoint` is an alias of it and `new`, `to_xy`, `from_xy` are shared. Wire encoding is `[x, y] = [k·q + kind index, r]` with `k` the number of kinds; `q` beyond `±i32::MAX / k` wraps. `CellFace` is the face type of the polygon tessellations (`XFace` aliases it): the position in `faces_of`, counter-clockwise. Every cell is a regular polygon of side 1, so `faces_of` is `polygon_faces(n)`, the local-to-canonical map of `shape_of` is the identity, the shape is the one `regular:n` descriptor with `n` faces (`regular_cell_shape`, side counts must be distinct within a tessellation) and the default area is `n / (4·tan(π/n))`. Also shared: `is_opposite_face`, the `candidate_cells` enumeration with its cell-count limit (`anchor_cells`, `expanded_box`), the `rect` / `circle` / `triangle` preset dispatch (`preset_cells`, `lattice_rect_cells`) and `retain_attached` (keeps a non-anchor cell only beside a kept anchor cell, errors when nothing is left).
- **`space::exact_tiling`** (snub square, rhombitrihexagonal, truncated hexagonal, truncated trihexagonal). Cells are polygons with vertices in `ℤ[√3]` kept as integer quadruples over a denominator (2 or 4). A tessellation supplies the denominator, the two lattice steps and one vertex `Template` per kind; `Tiling` provides `center`, `face_segments` and the neighbor table `link(kind, face)`, built once per kind by matching reversed edges among cells anchored within two lattice steps of the origin. Trihexagonal and snub hexagonal keep their own lattice geometry.

### Trihexagonal tessellation (3.6.3.6)

Status (GitHub issue #792): `space::trihexagonal` (`TrihexagonalTessellation`, kind `trihexagonal`, no params) is the kagome tiling: regular hexagons and equilateral triangles of edge length 1 alternate around every vertex. A hexagon has six triangle neighbors, a triangle three hexagon neighbors. Hexagon area `3√3 / 2`, triangle area `√3 / 4`, so `cell_scale` differs between the two. The split editor consumes its arc faces through the faces' flattened polylines (GitHub issue #800, `Specs/split-blueprints.md`).

- **Cell ids.** `TrihexagonalPoint { q, r, kind }` with `kind` one of `Hexagon`, `Up`, `Down`. Hexagon centers form a triangular lattice with axial coordinates `(q, r)` (flat-top hexagons, neighbors touch at a vertex, center distance 2). Every lattice triangle holds one kagome triangle: `Down(q, r)` (apex down) sits between hexagons `(q, r)`, `(q+1, r)`, `(q, r+1)`; `Up(q, r)` (apex up) between `(q+1, r)`, `(q, r+1)`, `(q+1, r+1)`. Every id is a valid cell. Wire encoding: `[x, y] = [3q + kind, r]` with kind 0 hexagon, 1 up, 2 down (`to_xy`/`from_xy`; `q` beyond `±i32::MAX / 3` wraps).
- **Faces.** One `TrihexagonalFace` enum of the compass directions `NE, N, NW, SW, S, SE`. A hexagon has all six, counter-clockwise from `NE` (`regular:6`); an up triangle `NE, NW, S` and a down triangle `N, SW, SE` (`regular:3`, both counter-clockwise). `opposite()` is the 180° turn; neighbors always meet across opposite faces.
- **Neighbors.** `step(face)` returns `None` for a face the cell lacks or on `i32` overflow. A hexagon's `NE, NW, S` lead to down triangles and `N, SW, SE` to up triangles.
- **Straightness.** A hexagon is passed straight iff the pass leaves by the opposite face; no pass through a triangle is straight (every pass turns by 60°). Checked against the geometric definition.
- **Geometry.** Vertices sit on the integer lattice `x = i / 2`, `y = j·√3 / 2`, so a vertex shared by several cells is bit-identical from each. `candidate_cells` counts exactly (three cells per lattice anchor) before building any.
- **Presets.** `rect` (`cols × rows` hexagons in screen-aligned rows, every row shifted by half a pitch, plus every triangle whose three hexagons are all in the set; origin hexagon at `size / 2`, rounded down), `circle` by cell center and `triangle` by whole cell; translate and reflect are derived geometrically.
- **Wire and web.** `{ "kind": "trihexagonal", "params": {} }`; points are `[x, y]` pairs. Web entry `TESSELLATION_UI.trihexagonal` (no orientations, `pixelsPerUnit = TILE_SIZE`, `FLIP_Y`), connector axes at 30°, 90°, 150°.

### Snub hexagonal tessellation (3.3.3.3.6)

Status (GitHub issue #793): `space::snub_hexagonal` (`SnubHexagonalTessellation`, kind `snub_hexagonal`, no params) is the snub trihexagonal tiling: regular hexagons and equilateral triangles of edge length 1, four triangles and one hexagon around every vertex. Per hexagon there are eight triangles: six share an edge with it (one per hexagon face) and two border only triangles. Hexagon area `3√3 / 2`, triangle area `√3 / 4`, so `cell_scale` differs between the two. The split editor consumes its arc faces through the faces' flattened polylines (GitHub issue #800, `Specs/split-blueprints.md`).

- **Construction.** Vertices are the points `a + b·ω` (`ω = e^{iπ/3}`, written `(a, b)`, world position `x = a + b/2`, `y = b·√3/2`) of the unit triangular lattice minus the index-7 sublattice `L = { a ≡ 2b (mod 7) }`. Each removed point is a hexagon center (its six lattice neighbors are the hexagon's vertices); every lattice triangle touching no removed point is a triangle cell. `L` is spanned by `(2, 1)` and `(-1, 3)` (hexagon center distance `√7`) and is closed under 60° rotation, so the tiling has the full `p6` symmetry about a hexagon center and the two lattice translations.
- **Handedness.** The tiling is chiral. The fixed form is counter-clockwise (y up): the lattice vector `(2, 1)` points `atan(√3 / 5) ≈ 19.1°` counter-clockwise from the hexagon's vertex axis. The mirror image (`a ≡ 4b (mod 7)`) is not offered. The tiling has no mirror symmetry, so the kind lists only `Translate` in `field_operations` and `reflect_cells` is `Unavailable` (the web Symmetry tool stays visible but disabled, tooltip "Unavailable in this tessellation"); translation works for lattice vectors only (`q·(5/2, √3/2) + r·(1/2, 3√3/2)`).
- **Cell ids.** `SnubHexagonalPoint { q, r, kind }`, `kind` one of `Hexagon`, `Edge0 … Edge5`, `Inner0`, `Inner1` (`SnubHexagonalKind::ALL`, wire order). `(q, r)` names the hexagon with center `q·(2, 1) + r·(-1, 3)` (lattice units). `Edge k` is the triangle across face `k` of that hexagon; `Inner0`/`Inner1` are the nearest translates of the two triangle classes that border no hexagon (a triangle is the kind's template translated to its anchor). Every id is a valid cell. Wire encoding: `[x, y] = [9q + kind index, r]` (`to_xy`/`from_xy`; `q` beyond `±i32::MAX / 9` wraps).
- **Faces.** `SnubHexagonalFace` is the position in `faces_of`: counter-clockwise from the cell's first vertex, a hexagon `0..6` (face `k` runs from the vertex at `60°·k` to the next; `regular:6`), a triangle `0..3` (`regular:3`; an edge triangle's face `0` is the one shared with its anchor hexagon). The opposite face is not a function of the face: `neighbor` returns it, found as the cell on the other side of the same unit lattice edge.
- **Neighbors.** `neighbor(cell, face)` is `None` only when the neighbor's `q` or `r` leave `i32`. Hexagon faces lead to its edge triangles; an edge triangle has one hexagon neighbor and two triangle neighbors; an inner triangle has three triangle neighbors.
- **Straightness.** A hexagon is passed straight iff the pass leaves by the opposite face (`(face + 3) mod 6`); no pass through a triangle is straight (every pass turns by 60°). Checked against the geometric definition.
- **Geometry.** Vertices come from the integer lattice coordinates, so a vertex shared by several cells is bit-identical from each. All edges are unit lattice steps (directions 0°, 60°, 120°). `candidate_cells` is exact per row `r` (nine cells per hexagon `(q, r)`, vertices within `2` of the anchor center) and counts before building any.
- **Presets.** `rect` (cells fully inside a `cols·√7 × rows·√7` rectangle centered on the origin hexagon), `circle` by cell center and `triangle` by whole cell; translate is derived geometrically.
- **Wire and web.** `{ "kind": "snub_hexagonal", "params": {} }`; points are `[x, y]` pairs. Web entry `TESSELLATION_UI.snub_hexagonal` (no orientations, `pixelsPerUnit = TILE_SIZE`, `FLIP_Y`), connector axes at 30°, 90°, 150°.

### Rhombitrihexagonal tessellation (3.4.6.4)

Status (GitHub issue #795): `space::rhombitrihexagonal` (`RhombitrihexagonalTessellation`, kind `rhombitrihexagonal`, no params) is the rhombitrihexagonal tiling: regular hexagons, squares and equilateral triangles of edge length 1; around every vertex a triangle, a square, a hexagon and a square meet in that order. Per hexagon there are three squares and two triangles. Hexagon area `3√3 / 2`, square area `1`, triangle area `√3 / 4`, so `cell_scale` differs per shape. The split editor consumes its arc faces through the faces' flattened polylines (GitHub issue #800, `Specs/split-blueprints.md`).

- **Construction.** Hexagon centers form a triangular lattice of spacing `1 + √3`, spanned by `A = (1 + √3)·(cos 30°, sin 30°)` and `B = (1 + √3)·(0, 1)`. A hexagon's vertices lie at `60°·k` at distance 1 from its center; its face `k` points at `30° + 60°·k`. Neighboring hexagons are joined by a square across each face; a triangle sits at every vertex of a hexagon. The tiling has full `p6m` symmetry, so `field_operations` lists `Translate` and `Reflect`.
- **Cell ids.** `RhombitrihexagonalPoint { q, r, kind }`, `kind` one of `Hexagon`, `Square0`, `Square1`, `Square2`, `TriangleA`, `TriangleB` (`RhombitrihexagonalKind::ALL`, wire order). `(q, r)` names the hexagon with center `q·A + r·B`. `Square k` is the square across face `k` (`k = 0, 1, 2`, normals `30°`, `90°`, `150°`) of that hexagon; the squares across faces `3, 4, 5` are the squares `0, 1, 2` of the neighboring hexagons `(q-1, r)`, `(q, r-1)`, `(q+1, r-1)`. The three squares are the three orientations (60° apart). `TriangleA`/`TriangleB` are the triangles at hexagon vertices `0` and `1`; the triangles at vertices `2, 4` and `3, 5` are translates of these. Every id is a valid cell. Wire encoding: `[x, y] = [6q + kind index, r]` (`to_xy`/`from_xy`; `q` beyond `±i32::MAX / 6` wraps).
- **Faces.** `RhombitrihexagonalFace` is the position in `faces_of`: counter-clockwise from the cell's first vertex, a hexagon `0..6` (face `k` runs from the vertex at `60°·k` to the next; `regular:6`), a square `0..4` (`regular:4`; face `0` is the one shared with its anchor hexagon), a triangle `0..3` (`regular:3`; at anchor vertex `j`, face `0` is shared with the square across anchor face `j - 1`). The opposite face is not a function of the face: `neighbor` returns it. It comes from a table, built once per kind by matching reversed edges among the cells anchored within two lattice steps of the origin hexagon.
- **Neighbors.** `neighbor(cell, face)` is `None` only when the neighbor's `q` or `r` leave `i32`. A hexagon has six square neighbors, a square two hexagons and two triangles, a triangle three squares.
- **Straightness.** Per orientation, a hexagon is passed straight iff the pass leaves by the opposite face (`(face + 3) mod 6`), a square iff it leaves by `(face + 2) mod 4`; no pass through a triangle is straight. Checked against the geometric definition.
- **Geometry.** Every vertex is `((xr + xs·√3) / 2, (yr + ys·√3) / 2)` for integers, kept as an integer quadruple, so vertices compare exactly and a vertex shared by several cells is bit-identical from each. `candidate_cells` is exact (`x` fixes `q`, then `y` bounds `r`; six cells per hexagon `(q, r)`, vertices within `2` of the anchor center) and counts before building any.
- **Presets.** `rect` (cells fully inside a `cols·(1 + √3) × rows·(1 + √3)` rectangle centered on the origin hexagon), `circle` by cell center and `triangle` by whole cell; translate and reflect are derived geometrically.
- **Wire and web.** `{ "kind": "rhombitrihexagonal", "params": {} }`; points are `[x, y]` pairs. Web entry `TESSELLATION_UI.rhombitrihexagonal` (no orientations, `pixelsPerUnit = TILE_SIZE`, `FLIP_Y`), connector axes at 0°, 30°, 60°, 90°, 120°, 150° (hexagon and square face normals).

### Truncated hexagonal tessellation (3.12.12)

Status (GitHub issue #810): `space::truncated_hexagonal` (`TruncatedHexagonalTessellation`, kind `truncated_hexagonal`, no params) is the truncated hexagonal tiling: regular dodecagons and equilateral triangles of edge length 1; around every vertex a triangle and two dodecagons meet. Per dodecagon there are two triangles. Dodecagon area `3·(2 + √3)`, triangle area `√3 / 4`, so `cell_scale` differs per shape. Tessellation-specific split templates are out of scope.

- **Construction.** Dodecagon centers form a triangular lattice of spacing `2 + √3` (twice the apothem), spanned by `A = (2 + √3)·(1, 0)` and `B = (2 + √3)·(cos 60°, sin 60°)`. A dodecagon's face `f` has its outward normal at `30°·f`; even faces are shared with neighboring dodecagons, odd faces with triangles. The tiling has full `p6m` symmetry, so `field_operations` lists `Translate` and `Reflect`.
- **Cell ids.** `TruncatedHexagonalPoint { q, r, kind }`, `kind` one of `Dodecagon`, `TriangleUp`, `TriangleDown` (`TruncatedHexagonalKind::ALL`, wire order). `(q, r)` names the dodecagon with center `q·A + r·B`. `TriangleUp` (apex at `90°`) is the triangle across face `3` of that dodecagon, `TriangleDown` (apex at `30°`) the one across face `1`; the triangles across faces `5, 9` and `7, 11` are translates of these, anchored at neighboring dodecagons. Every id is a valid cell. Wire encoding: `[x, y] = [3q + kind index, r]` (`to_xy`/`from_xy`; `q` beyond `±i32::MAX / 3` wraps).
- **Faces.** `TruncatedHexagonalFace` is the position in `faces_of`: counter-clockwise from the cell's first vertex, a dodecagon `0..12` (face `f` has its normal at `30°·f`; `regular:12`), a triangle `0..3` (`regular:3`; face `0` is the one shared with its anchor dodecagon). The opposite face is not a function of the face: `neighbor` returns it. It comes from a table, built once per kind by matching reversed edges among the cells anchored within two lattice steps of the origin dodecagon.
- **Neighbors.** `neighbor(cell, face)` is `None` only when the neighbor's `q` or `r` leave `i32`. A dodecagon has six dodecagon and six triangle neighbors, a triangle three dodecagons.
- **Straightness.** A dodecagon is passed straight iff the pass leaves by the opposite face (`(face + 6) mod 12`); no pass through a triangle is straight (every pass turns by 60°). Both triangle orientations are handled the same way. Checked against the geometric definition.
- **Geometry.** Every vertex is `((xr + xs·√3) / 4, (yr + ys·√3) / 4)` for integers, kept as an integer quadruple, so vertices compare exactly and a vertex shared by several cells is bit-identical from each. `candidate_cells` is exact (`y` fixes `r`, then `x` bounds `q`; three cells per dodecagon `(q, r)`, vertices within `1 + √3` of the anchor center) and counts before building any.
- **Presets.** `rect` (cells fully inside a `cols·(2 + √3) × rows·(2 + √3)·√3 / 2` rectangle centered on the origin dodecagon), `circle` and `triangle` by cell center. A triangle none of whose dodecagons is in the shape is dropped (it would be disconnected); translate and reflect are derived geometrically.
- **Wire and web.** `{ "kind": "truncated_hexagonal", "params": {} }`; points are `[x, y]` pairs. Web entry `TESSELLATION_UI.truncated_hexagonal` (no orientations, `pixelsPerUnit = TILE_SIZE`, `FLIP_Y`), connector axes at 0°, 60°, 120° only: dodecagon edges run along every multiple of 30°, and a connector line through a cell center at 30°, 90° or 150° lies on the shared wall of lattice-neighbor dodecagons.

### Truncated trihexagonal tessellation (4.6.12)

Status (GitHub issue #812): `space::truncated_trihexagonal` (`TruncatedTrihexagonalTessellation`, kind `truncated_trihexagonal`, no params) is the truncated trihexagonal tiling: regular dodecagons, hexagons and squares of edge length 1; around every vertex a square, a hexagon and a dodecagon meet. Per dodecagon there are two hexagons and three squares. Dodecagon area `3·(2 + √3)`, hexagon area `3·√3 / 2`, square area `1`. Tessellation-specific split templates are out of scope.

- **Construction.** Dodecagon centers form a triangular lattice of spacing `3 + √3` (two apothems plus one square), spanned by `A = (3 + √3)·(1, 0)` and `B = (3 + √3)·(cos 60°, sin 60°)`. Dodecagons never share an edge: a dodecagon's face `f` has its outward normal at `30°·f`; even faces are shared with squares (one square between every two lattice-neighbor dodecagons), odd faces with hexagons (one hexagon at the center of every lattice triangle). The tiling has full `p6m` symmetry, so `field_operations` lists `Translate` and `Reflect`.
- **Cell ids.** `TruncatedTrihexagonalPoint { q, r, kind }`, `kind` one of `Dodecagon`, `Square0`, `Square60`, `Square120`, `Hexagon30`, `Hexagon90` (`TruncatedTrihexagonalKind::ALL`, wire order). `(q, r)` names the dodecagon with center `q·A + r·B`; a square or hexagon is named by the normal angle of the face of that dodecagon it sits across (`Square0`/`Square60`/`Square120` across faces `0/2/4`, `Hexagon30`/`Hexagon90` across faces `1/3`). The cells across the other faces are translates, anchored at neighboring dodecagons. The three squares are turned by 60° against each other. Every id is a valid cell. Wire encoding: `[x, y] = [6q + kind index, r]` (`to_xy`/`from_xy`; `q` beyond `±i32::MAX / 6` wraps).
- **Faces.** `TruncatedTrihexagonalFace` is the position in `faces_of`: counter-clockwise from the cell's first vertex, a dodecagon `0..12` (face `f` has its normal at `30°·f`; `regular:12`), a hexagon `0..6` (`regular:6`), a square `0..4` (`regular:4`); face `0` of a square or hexagon is the one shared with its anchor dodecagon, so canonical face `0` points in a different absolute direction for each kind of one shape (the three squares are turned by 60° against each other, `Hexagon30` and `Hexagon90` by 60°); a future split template for this tiling must account for it. The opposite face is not a function of the face: `neighbor` returns it. It comes from a table, built once per kind by matching reversed edges among the cells anchored within two lattice steps of the origin dodecagon.
- **Neighbors.** `neighbor(cell, face)` is `None` only when the neighbor's `q` or `r` leave `i32`. A dodecagon has six square and six hexagon neighbors (alternating), a hexagon three squares and three dodecagons (alternating), a square two hexagons and two dodecagons (alternating).
- **Straightness.** A pass is straight iff it leaves by the opposite face: `(face + n / 2) mod n` for a cell with `n` faces. Faces are counter-clockwise, so this holds for every orientation of a square (the three orientations need no separate table). Checked against the geometric definition.
- **Geometry.** Vertices are integer quadruples as in 3.12.12, so a vertex shared by several cells is bit-identical from each. `candidate_cells` is exact (`y` fixes `r`, then `x` bounds `q`; six cells per dodecagon `(q, r)`, vertices within `2 + √3` of the anchor center) and counts before building any.
- **Presets.** `rect` (cells fully inside a `cols·(3 + √3) × rows·(3 + √3)·√3 / 2` rectangle centered on the origin dodecagon), `circle` and `triangle` by cell center. A square or hexagon beside no dodecagon of the shape is dropped (it would be disconnected); translate and reflect are derived geometrically.
- **Wire and web.** `{ "kind": "truncated_trihexagonal", "params": {} }`; points are `[x, y]` pairs. Web entry `TESSELLATION_UI.truncated_trihexagonal` (no orientations, `pixelsPerUnit = TILE_SIZE`, `FLIP_Y`), connector axes at 0°, 60°, 120° (the dodecagon-square face normals; no axis line through a cell center runs along a cell edge, checked by a web test).

### Elongated triangular tessellation (3.3.3.4.4)

Status (GitHub issue #813): `space::elongated_triangular` (`ElongatedTriangularTessellation`, kind `elongated_triangular`, no params) is the elongated triangular tiling: unit squares and equilateral triangles of edge length 1 in alternating rows (a row of squares, then a row of triangles); around every vertex three triangles and two squares meet. Square area `1`, triangle area `√3 / 4`, so `cell_scale` differs per shape. Tessellation-specific split templates are out of scope.

- **Construction.** The plane is cut into bands: band `y` is a row of squares with the row of triangles above it, starting at world height `y·(1 + √3/2)`. Band `y` is shifted `y / 2` to the right (a shear, so negative `y` needs no parity handling): the squares of band `y + 1` stand exactly on the down-pointing triangles of band `y`. Translations: `(1, 0)` and `(1/2, 1 + √3/2)`; the tiling also has vertical mirrors, so `field_operations` lists `Translate` and `Reflect` (derived geometrically).
- **Cell ids.** `ElongatedTriangularPoint { x, y, kind }`, `kind` one of `Square`, `TriangleUp`, `TriangleDown` (`ElongatedTriangularKind::ALL`, wire order). `Square` is the column `x` of band `y`; `TriangleUp` stands on its top edge (apex up); `TriangleDown` hangs between `TriangleUp` of columns `x` and `x + 1` (apex down), its top edge being the bottom of `Square(x, y + 1)`. Every id is a valid cell. Wire encoding: `[x, y] = [3·column + kind index, band]` (`to_xy`/`from_xy`; columns beyond `±i32::MAX / 3` wrap).
- **Faces.** `ElongatedTriangularFace` is the position in `faces_of`: counter-clockwise from the cell's first vertex, a square `0..4` (bottom, right, top, left; `regular:4`), a triangle `0..3` (`regular:3`; an up triangle starts with its base, a down triangle with its right side). The opposite face is not a function of the face: `neighbor` returns it, from a table built once per kind by matching reversed edges among the cells anchored within two steps of the origin square.
- **Neighbors.** `neighbor(cell, face)` is `None` only when the neighbor's `x` or `y` leave `i32`. A square has two square and two triangle neighbors, a triangle two triangles and one square.
- **Straightness.** A square is passed straight iff the pass leaves by the opposite face (`(face + 2) mod 4`); no pass through a triangle is straight (every pass turns by 60°). Both triangle orientations are handled the same way. Checked against the geometric definition.
- **Geometry.** Every vertex is `((xr + xs·√3) / 4, (yr + ys·√3) / 4)` for integers, kept as an integer quadruple, so vertices compare exactly and a vertex shared by several cells is bit-identical from each. `candidate_cells` is exact (`y` fixes the bands, then `x` bounds the columns of each band; three cells per `(x, y)`) and counts before building any.
- **Presets.** `rect` (cells whose center lies in a `cols × rows·(1 + √3/2)` rectangle around the origin square, moved a quarter of a lattice spacing so no center lies on an edge and every band keeps exactly `cols` squares: the bands are staggered, so whole-cell inclusion would empty thin rectangles and break the monotonic extent that print sizing searches over), `circle` and `triangle` by cell center. Only the largest connected group of the chosen cells is kept (a rim triangle between excluded squares would be cut off).
- **Wire and web.** `{ "kind": "elongated_triangular", "params": {} }`; points are `[x, y]` pairs. Web entry `TESSELLATION_UI.elongated_triangular` (no orientations, `pixelsPerUnit = 1.5 * TILE_SIZE`, `FLIP_Y`), connector axes at 0°, 30°, 150° only: a vertical line through a square center runs along the vertical walls of the half-shifted band above or below.

### Snub square tessellation (3.3.4.3.4)

Status (GitHub issue #814): `space::snub_square` (`SnubSquareTessellation`, kind `snub_square`, no params) is the snub square tiling: regular squares and equilateral triangles of edge length 1; around every vertex three triangles and two squares meet, in the order triangle, triangle, square, triangle, square. Per lattice cell there are two squares and four triangles (area `2 + √3`). Every square has 4 triangle neighbors; every triangle has 2 square neighbors and 1 triangle neighbor. Tessellation-specific split templates are out of scope.

- **Construction.** The translation lattice is square, spanned by `A = ((2 + √3) / 2, -1/2)` (anchor `q + 1`) and `B = (1/2, (2 + √3) / 2)` (anchor `r + 1`), both of length `(1 + √3) / √2`. The squares come in two orientations turned by 30° against each other, the triangles in four; all edges run along multiples of 30°. The tiling is invariant under 90° rotations about a square center. It is chiral: this module fixes the form in which `A` points 15° clockwise from the x axis (y up), the mirror image is not offered, and `field_operations` lists `Translate` only.
- **Cell ids.** `SnubSquarePoint { q, r, kind }`, `kind` one of `Square`, `TiltedSquare`, `TriangleDown`, `TriangleRight`, `TriangleUp`, `TriangleLeft` (`SnubSquareKind::ALL`, wire order). `(q, r)` names the corner `q·A + r·B`, the first vertex of the axis-aligned `Square`; the triangles sit on its bottom, right, top and left sides (named by apex direction), the `TiltedSquare` hangs from its bottom-right corner. Every id is a valid cell. Wire encoding: `[x, y] = [6q + kind index, r]` (`to_xy`/`from_xy`; `q` beyond `±i32::MAX / 6` wraps).
- **Faces.** `SnubSquareFace` is the position in `faces_of`: counter-clockwise from the cell's first vertex, a square `0..4` (`regular:4`), a triangle `0..3` (`regular:3`). The first vertex differs per kind, so canonical face `0` points in a different absolute direction for each kind of one shape (two squares, four triangles); a future split template for this tiling must account for it. The opposite face is not a function of the face: `neighbor` returns it, from a table built once per kind by matching reversed edges among the cells anchored within two lattice steps of the origin.
- **Neighbors.** `neighbor(cell, face)` is `None` only when the neighbor's `q` or `r` leave `i32`.
- **Straightness.** A pass through a square is straight iff it leaves by the opposite face, `(face + 2) mod 4`, whatever the orientation (faces are counter-clockwise). A triangle has no opposite face; no pass through it is straight.
- **Geometry.** Vertices are integer quadruples as in 3.12.12, so a vertex shared by several cells is bit-identical from each. `candidate_cells` is exact for the anchor lattice (the box mapped into lattice coordinates, `q` bounded by the rotated corners, then `r` by `x` and `y`; six cells per anchor, vertices within `2` of the anchor) and counts before building any.
- **Presets.** `rect` (cells fully inside a `cols·p × rows·p` rectangle centered on the origin square, `p = (1 + √3) / √2`), `circle` and `triangle` by cell center. A triangle beside no square of the shape is dropped (it would be disconnected).
- **Wire and web.** `{ "kind": "snub_square", "params": {} }`; points are `[x, y]` pairs. Web entry `TESSELLATION_UI.snub_square` (no orientations, `pixelsPerUnit = TILE_SIZE`, `FLIP_Y`), connector axes at 15°, 45°, 75°, 105°, 135°, 165°: every multiple of 30° lies along some cell edge through a cell center, the odd multiples of 15° never do (checked by a web test).

### Curved quadrilateral tessellation

Status (GitHub issue #799): `space::curved_quadrilateral` (`CurvedQuadrilateralTessellation`, kind `curved_quadrilateral`, no params) is the square grid with every edge replaced by a quarter circle, so each tile has two opposite convex and two opposite concave sides (convexity relative to the tile's interior). The first built-in tessellation with `Segment::CircularArc` faces. Every cell has 4 neighbors and area `1`. The split editor consumes its arc faces through the faces' flattened polylines (GitHub issue #800, `Specs/split-blueprints.md`).

- **Cell ids.** `CurvedQuadrilateralPoint { x, y }`, any `i32` pair is a valid cell; cell `(x, y)` is the tile over the unit square `[x, x + 1] × [y, y + 1]`. Wire encoding: `[x, y]`.
- **Curvature.** In a cell of even `x + y` (`rem_euclid`, so negative coordinates work) the east and west sides are convex and the north and south sides concave; an odd cell is the other way round. A neighbor of a convex side has a concave side there, so the plane is covered without gaps or overlaps. A convex side is the quarter of the circumcircle (radius `√2 / 2`, around the cell's own center) through the square's corners; the same arc is the neighbor's concave side (center = that neighbor's center), so bulges and dents cancel and every tile has area exactly `1`. A convex side reaches `√2 / 2 - 1 / 2 ≈ 0.207` beyond its square. The curvature is fixed, not a parameter.
- **Faces.** `CurvedQuadrilateralFace` is `E, N, W, S` (the canonical counter-clockwise order, identical to the square's). The opposite face is `neighbor`'s returned face. A pass is straight iff it leaves by the opposite face (the contact points of opposite sides and the center are collinear). The center is the center of the underlying square.
- **Shape.** One template `curved_quadrilateral:curved_quadrilateral`, four faces, group generated by the two axis mirrors (identity, both mirrors and the half turn). A quarter turn is not a symmetry (it swaps the convex and the concave pair).
- **Geometry.** Each face is one `CircularArc` with explicit integer corner endpoints (so joints and the shared edge are bit-identical), start angle from the center, sweep `+π/2` for a convex side and `-π/2` for a concave one. `candidate_cells` is the box widened by the bulge, counted before building any.
- **Presets.** `rect` (`cols × rows` cells, origin cell at `size / 2` rounded down), `circle` and `triangle` by cell center. Translate and reflect are derived geometrically: since the neighbor parity matters, a vector must keep `x + y` parity (`(1, 1)` and `(2, 0)` are symmetries, `(1, 0)` is not); an axis is accepted only if it passes the same check (axes along lattice lines or through cell centers swap the convex and the concave pair, so they are refused).
- **Wire and web.** `{ "kind": "curved_quadrilateral", "params": {} }`; points are `[x, y]` pairs. Web entry `TESSELLATION_UI.curved_quadrilateral` (no orientations, axis-aligned editor like the square, `pixelsPerUnit = TILE_SIZE * 1.5` = 60 px so markers fit between the concave sides, `FLIP_Y`), connector axes at 0° and 90°. Rendering, hit-testing and corridor geometry use the universal arc-aware renderers.

### Radial tessellation

Status (GitHub issue #804): `space::radial` (`RadialTessellation`, kind `radial`) is one central disc surrounded by concentric rings. It is the only tessellation built from params and the only one with a variable face count per cell; ring boundaries are `Segment::CircularArc`, sector boundaries are lines. Cells stay visually uniform: the cell count of a ring grows with its radius according to the `ring_layout` param.

- **Params.** `{ "first_ring_cells": n, "ring_layout": "classic" | "smooth", "max_cells": c }`, all required: `n` an integer in `6..=24` (approximate cell count of ring 1; default `9`), `ring_layout` one of `RadialLayout::ALL` (default `classic`), `c` an integer in `100..=10000` (`MIN_CELL_LIMIT`..=`MAX_CELL_LIMIT`; default `DEFAULT_CELL_LIMIT = 3000`) bounding the cell count. `RadialTessellation::new` rejects an out-of-range `n` or `c` with a reason naming the param; the factory also rejects unknown, missing, fractional, negative and non-listed values. The same params always yield the same cells, face order and neighbors.
- **Cell ids.** `RadialPoint { ring, index }`. `(0, 0)` is the center (a disc of radius 1); otherwise `ring >= 1`, `0 <= index < ring_count(ring)` and the cell is the sector `index` of ring `ring` (the annulus between radii `ring` and `ring + 1`), counted counter-clockwise from the positive x axis. The ring counts come from the layout. **`classic`**: `ring_count(1) = n`; ring `r` keeps the count of ring `r - 1` or doubles it when a cell of that count is at least 1.5 times wider than the ring is thick, measured at the ring's mid radius (`2π (r + 1/2) / count >= 1.5`). Every sector boundary of a ring is then also one of the next ring, so no narrow shared arcs exist; cell width swings between 0.75 and 1.5 of the ring thickness. **`smooth`**: the ideal count of ring `r` is `n · (2r + 1) / 3` (proportional to the annulus area); the table is the non-decreasing sequence of multiples of three within ±25% of the ideal that minimizes the summed squared relative deviation, subject to the narrowest arc shared by two neighboring rings being at least a third of the narrower cell (exact integer check, which reduces to the reduced narrower count being at most three; deterministic dynamic program). Ring 1 holds `n` rounded to a multiple of three (within 3). The space has at most `max_cells` cells (the center included): rings stop before the first one that would exceed it (`ring_count` returns `None` there; `ring_total` is the ring count). `smooth` solves its table for the rings whose ideal sizes fit the limit and then drops trailing rings that overshoot, so it may stop one ring short of what the limit would allow. Wire encoding: `[ring, index]`.
- **Faces.** `RadialFace`, counter-clockwise canonical order: `Outer(0..a)` (outer-ring neighbors in angular order), `Next` (radial side toward the next sector), `Inner(0..b)` (inner-ring neighbors in decreasing angle, as the inner arc is traversed), `Prev`. Where ring boundaries of neighboring rings differ, a cell touches every cell of the adjacent ring whose sector overlaps its own with positive length (`a` is 1-3, `b` is 1-2; with `classic` always `b = 1`, `a` is 1 or 2; ring 1 has the single `Inner(0)` = the center). The shared edge is the arc over the overlap only. The center has `ring_count(1)` faces (`Outer(k)` = ring-1 cell `k`). The last ring has a single `Outer(0)` face without a neighbor. `neighbor` is reciprocal. `is_straight` is the geometric definition (`is_straight_geometric`).
- **Shape.** The center is `regular:m` (`m = ring_count(1)`); a ring cell with `a` outer and `b` inner neighbors has the shape `radial:ring_a_b` (`a + b + 2` faces; only the ones that occur are listed), with the mirror as its only generator. Rotations are not symmetries of a ring cell.
- **Geometry.** Vertices are `polar(radius, TAU · a / b)` with the fraction `a / b` reduced first, so a vertex shared by cells of rings with different counts is bit-identical from each side. A shared arc is built once as the counter-clockwise arc over the overlap; the outer ring's cell takes its reverse, so both sides agree exactly. The center of a ring cell is the polar point at radius `ring + 1/2` and the middle angle; `area` is `π` for the center and `π (2·ring + 1) / ring_count` for a ring cell. `candidate_cells` bounds the ring range by the box distance from the origin and the sector range by the box's angular span, counted before building any.
- **Presets.** Only `circle` (cells whole inside the radius, `Inclusion::WholeCell`); a radius beyond `ring_total + 1` is refused with a reason (the space ends at `max_cells` cells); `preset_param_max` publishes that bound, so the editor limit follows `first_ring_cells` and `ring_layout`. The field operations offer reflect only (no translation preserves the rings); an axis through the origin is a symmetry iff it maps every ring boundary onto one (the x axis always; `smooth` rings are multiples of three, so also its 60° rotations).
- **Wire and web.** `{ "kind": "radial", "params": { "first_ring_cells": 9, "ring_layout": "classic", "max_cells": 3000 } }`; points are `[ring, index]` pairs. Web entry `TESSELLATION_UI.radial` (no orientations, `pixelsPerUnit = TILE_SIZE` so a ring is one tile thick, `FLIP_Y`, `paramSpecs` (an integer range or a choice list) that Basic configuration renders as a number input and a select and the project import validates), connector axes of the square. Default and preview circle radii are capped at the `max` that `field_capabilities` publishes (a small `max_cells` leaves few rings). Params are maze-wide store state (`tessellationParams`/`previewParams`); changing them discards the maze like a kind change. Rendering, hit-testing and corridor geometry use the universal arc-aware renderers. Tessellation-specific split templates are out of scope.

### Jittered Voronoi tessellation

Status (GitHub issue #817): `space::voronoi` (`VoronoiTessellation`, kind `voronoi`) is the Voronoi diagram of a triangular lattice of sites, each displaced by a seeded pseudo-random offset: organic, irregular, convex cells that stay close to a regular hexagonal layout. At `jitter = 0` it is exactly the regular hexagonal grid. Like `radial` it is built from params and its space is finite.

- **Params.** `{ "jitter": j, "seed": s, "max_cells": c }`, all required: `j` a number in `0..=0.4` (`MAX_JITTER`; default `DEFAULT_JITTER = 0.15`), the displacement of a site in units of the lattice distance; `s` an integer in `0..=u32::MAX`; `c` an integer in `100..=10000` (default `3000`) bounding the cell count. `VoronoiTessellation::new` rejects out-of-range `j` and `c` with a reason naming the param; the factory also rejects unknown, missing, fractional, negative and non-numeric values. The same params always yield the same cells, face order and neighbors.
- **Sites.** Lattice point `(q, r)` is `d · (q + r / 2, r · √3 / 2)` with `d = sqrt(2 / √3)` (the lattice distance, chosen so a regular hexagon has area 1). Its site is displaced by a vector uniform in the disc of radius `d · jitter`, a function of `(seed, q, r)` alone (splitmix64). Then each site is pushed away from every one of its six lattice neighbors (at their displaced positions) that is closer than `0.8 · d`, by half of the deficit, so close pairs, which squeeze the cells between them into slivers, are pulled apart. A site depends only on lattice points within distance 1, so every cell is still computed locally.
- **Space and cell ids.** `VoronoiPoint { q, r }` is the lattice coordinate of a cell's site. The space is the largest hexagonal disc `|q|, |r|, |q + r| <= R` with at most `max_cells` cells (`3R(R + 1) + 1`). Wire encoding: `[q, r]`.
- **Cells.** The Voronoi region of a site is clipped by every other site within lattice distance 3, including sites outside the space, so cells on the boundary are exact and convex. A cell outside the disc does not exist: faces toward such sites have no neighbor. Cells therefore tile the union without gaps or overlaps.
- **Faces.** `VoronoiFace { dq, dr }` is the lattice offset to the neighbor's site; the opposite face is the negated offset, so `neighbor` is reciprocal by construction. Faces run counter-clockwise starting at the smallest lattice direction angle (the east neighbor at zero jitter). Every face is one line segment. A cell's neighbors are distinct. `is_straight` is the geometric definition.
- **Vertices.** A vertex is the circumcenter of a site triple, computed from the triple in sorted order, so a vertex shared by several cells is bit-identical from each. An edge shorter than `0.2 · d` is collapsed to the mean of its endpoints for every cell at once (the two cells it separated stop being neighbors; no gaps appear), so there are no very short edges (the threshold is the largest that keeps every cell convex at the maximum jitter: `0.3 · d` already breaks convexity there). Elongation is bounded: the farthest vertex from a cell's center is at most `1.2 + 5 · jitter` times the distance to its nearest side (checked over seeds).
- **Geometry.** `center` is the polygon centroid, `area` the polygon area (stored per cell; mean 1). `candidate_cells` walks the lattice rows of the box widened by two lattice distances, counted before building any.
- **Shape.** Cells are irregular, so `shape_descriptors` is empty and `shape_of` is `None` for every cell: split patterns never apply.
- **Presets and operations.** Only `circle` (cells by center within `radius` world units of the origin; the radius is at most `preset_param_max`, about the space's extent). No translation or reflection maps a jittered diagram onto itself, so `field_operations` is empty.
- **Wire and web.** `{ "kind": "voronoi", "params": { "jitter": 0.15, "seed": 1, "max_cells": 3000 } }`; points are `[q, r]` pairs. Web entry `TESSELLATION_UI.voronoi` (no orientations, `pixelsPerUnit = TILE_SIZE`, `FLIP_Y`, `paramSpecs`: a real number `jitter` rendered with step 0.05, integer `seed` and `max_cells`), connector axes of the square. Params are maze-wide store state like radial's.
