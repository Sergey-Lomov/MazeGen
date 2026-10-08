# Space: Tessellation, Field, MultiLevelField

Geometry layer of `maze-core` — how a maze's cells and their adjacency are represented, independent of `Graph` (which is purely a directed-edge structure with no geometry of its own). Covers the `Tessellation` trait, the single-level `Field<T>`, and the multi-level aggregator `MultiLevelField<T>`/`LevelId` (GitHub issue #334, part of epic #333 — Floors).

Module: `maze-core/src/space/`.

## Tessellation

```rust
pub trait Tessellation {
    type Point: Copy + Eq + Hash;
    type Face: Copy + PartialEq + 'static;

    fn step(point: Self::Point, face: Self::Face) -> Option<Self::Point>;
    fn is_valid_point(point: Self::Point) -> bool;
    fn faces() -> &'static [Self::Face];
    fn face_between(from: Self::Point, to: Self::Point) -> Option<Self::Face>;
    fn face_index(face: Self::Face) -> Option<usize>;   // default: linear scan over faces()
    fn face_at(index: usize) -> Option<Self::Face>;      // inverse of face_index
    fn rotation_symmetries() -> &'static [&'static [usize]];
    fn mirror_symmetries() -> &'static [&'static [usize]];
    fn cartesian(point: Self::Point) -> (f64, f64);
    fn edge_position(from: Self::Point, to: Self::Point) -> (f64, f64); // default: midpoint of endpoints
}
```

Three implementations: `SquareTessellation`, `HexTessellation`, `TriTessellation` (`space::square`/`hex`/`triangle`), each with its own `Point`/`Face` type.

- **`step`** moves from a point through a face to the neighboring point, returning `None` when that face has no coordinate in the tessellation (for example, a gap in a non-rectangular coordinate space). For a fixed point, distinct faces must not produce the same `Some` point — `Field::neighbors` relies on this to never visit the same neighbor twice. Total coordinate spaces return `Some` for every face, as the built-in square, hex, and triangle tessellations do.
- **`face_between`** reports the geometric face direction between two coordinates. It does not imply that `step(from, face)` reaches `to`; code that needs a traversable transition must check `step` and, for a concrete `Field`, membership of the resulting point.
- **`is_valid_point`** identifies whether a coordinate represents an actual tile. `Field::new` and `Field::from_id_points` reject invalid points before storing them; `step` remains separate because a valid tile may still have no neighbor through a particular face.
- **`rotation_symmetries`/`mirror_symmetries`** — each tessellation states its own rotation/mirror symmetry as an explicit permutation table over `faces()`, never a shared arithmetic formula (GitHub issue #275: a hex-shaped `(index + rotation) % degree` silently breaks for square/tri, whose `faces()` order isn't angular). `transform_face_index<T>(face_index, rotation, mirror)` is the one shared function built on top of these tables — used by split-pattern adaptation search, repair's split strategies, and QC's split-pattern matching.
- **`cartesian`/`edge_position`** — pure geometry, no rendering-specific orientation. `geometric_distance<T>`/`geometric_edge_distance<T>` (free functions in `space::mod`) build on these for node-to-node/edge-to-edge Euclidean distance, unrelated to graph/nav distance (tile-hop count along real edges).

## Field\<T\>

```rust
pub struct Field<T: Tessellation> {
    point_to_nodes: HashMap<T::Point, Vec<NodeId>>,
    node_to_point: HashMap<NodeId, T::Point>,
}
```

The single-tessellation building block: a fixed set of points, each resolving to one or more `NodeId`s (a point splits into several routing passages via `add_node_at` — GitHub issue #219/epic #218). `Field` has no notion of "groups" or which geometric face belongs to which of a point's several nodes — deciding that is entirely the caller's job (generation algorithms, QC/repair strategies).

Key methods: `new(points, &mut IdGenerator) -> Result<_, _>`, `from_id_points(entries) -> Result<_, _>` (rebuild preserving given ids, e.g. from a client snapshot — GitHub issue #236, while still rejecting invalid points), `add_node_at`/`remove_node_at`/`replace_nodes_at` (point-based, panic on an unknown point), `nodes_at(point)`/`node_at(point)` (creation-order slice / first node), `neighbors(node)` (skips faces whose `step` returns `None`), `is_straight(from, via, to)`, `point_of(node)`, `all_points()`/`all_node_ids()` (both `NodeId`-sorted, deterministic), `point_count()` (distinct cells) vs `node_count()` (all nodes, inflated by splits — density/ratio QC checks must use `point_count()`, GitHub issue #267), `contains(point)`, `build_nodes(&mut Graph)`.

`Field`'s point set is fixed at construction — `add_node_at`/`remove_node_at` only add/remove nodes *within* an existing point, never grow or shrink the point set itself. `Clone` is a manual impl (not derived) since only `T::Point` needs `Clone`, not `T` itself (typically a zero-sized marker).

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
- `point_of(node) -> Option<T::Point>`
- `neighbors(node) -> Vec<NodeId>` — empty `Vec` for an unknown node (mirrors `Field::neighbors`, not a panic)
- `is_straight(from, via, to) -> bool` — `false` unless all three resolve to the *same* level and are geometrically straight on it; a cross-level triple is never straight (geometric straightness is undefined between levels — a future stairs/elevator notion, GitHub issue #337, is a separate mechanism, not an extension of `is_straight`)
- `remove_node_at(node)` — resolves both level and point internally, unlike `Field::remove_node_at` which takes the point explicitly (redundant once derivable from the node). Panics if `node` doesn't belong to any level, mirroring `Field::remove_node_at`'s own panic-on-unknown-node contract — never a silent no-op.

**Point-based (level required — a bare point is ambiguous across levels):**
- `node_at(level, point) -> Option<NodeId>` / `nodes_at(level, point) -> &[NodeId]`
- `add_node_at(level, point, &mut IdGenerator) -> NodeId` — panics if `level` doesn't exist or `point` isn't already in that level's field
- `replace_nodes_at(level, point, new_ids: Vec<NodeId>)` — unmaps every old node currently at that point, then maps every id in `new_ids`; after the call, any old id not in `new_ids` gives `level_of(old_id) == None`, and every id in `new_ids` gives `level_of(new_id) == Some(level)`

**Level management:**
- `add_level(field: Field<T>) -> LevelId` — mints a fresh id, registers every node of `field` into `node_to_level`. Debug-asserts none of `field`'s nodes already belong to another level (a `NodeId` collision across levels would otherwise silently overwrite the mapping instead of signaling a broken invariant — the global per-`Maze` `IdGenerator` is expected to guarantee uniqueness, but the aggregator does not blindly trust callers).
- `remove_level(level) -> Option<Field<T>>` — removes the level and unmaps all of its nodes, returns the removed `Field` (or `None` if `level` doesn't exist). The caller decides what to do with the returned `Field`'s nodes (GitHub issue #335); this only guarantees the aggregator's own structure stays consistent afterward.
- `reorder_levels(&[LevelId])` — sets the display/iteration order. Panics (`assert_eq!`) if `new_order` isn't a permutation of the current level set — a structural invariant violation, not a recoverable runtime condition.
- `single_level_id() -> LevelId` — the aggregator's *first* level (by `levels_ordered()` position); panics only if there are no levels at all (never happens for a live `MultiLevelField` — every constructor adds at least one). QC/repair/routing/analytics/post-edit are all multi-floor-aware as of the GitHub issue #333 epic; the only remaining caller is `io::render_ascii`, a debug/example tool that only ever renders one floor by design.
- `field_of(level) -> Option<&Field<T>>` — read-only access to one level's underlying `Field`, for callers that need the full `Field` contract without level bookkeeping (rendering, geometry). Never `&mut`: every mutation must go through the aggregator's own node-id-based/point-based methods so `node_to_level` never drifts out of sync.
- `level_count()`, `levels_ordered() -> impl Iterator<Item = LevelId>`
- `level_index_of(node) -> Option<usize>` (GitHub issue #337) — `node`'s 0-based position in `levels_ordered()`, the web client's `floors` array index. Unlike `LevelId` (a stable minted id, never reused or renumbered), this is only valid until the next `add_level`/`remove_level`/`reorder_levels` call — recompute per snapshot, never cache across a mutation.

**Truly global aggregates (span every level, no `LevelId` required):**
- `all_node_ids() -> impl Iterator<Item = NodeId>` — every node across every level, sorted. For a single-level aggregator this is byte-for-byte identical to calling `all_node_ids()` on the wrapped `Field` directly — generation's RNG consumption depends on this exact ordering match.
- `max_node_id() -> Option<NodeId>`, `node_count() -> usize`
- `point_count() -> usize` — total distinct field cells (points) across every level, summed. Ratio/density QC checks normalizing "per 100 field cells" use this, not `node_count()` (inflated by split tiles) and not any single level's own `point_count()`.
- `all_points_with_level() -> impl Iterator<Item = (LevelId, T::Point)>` — every point across every level, grouped by level in `levels_ordered()` order, each level's own points in that level's `Field::all_points()` order. For single-level or level-agnostic callers, prefer `field_of(level).all_points()` instead — this is for genuinely level-aware code (multi-level UI/QC, split-topology aggregates that are conceptually maze-wide).
- `split_points() -> impl Iterator<Item = (LevelId, T::Point)>` (GitHub issue #614) — every split tile (a point with `nodes_at(level, point).len() >= 2`) across every level, each appearing exactly once. Shared replacement for the `all_points_with_level()` + dedup + node-count-filter pattern QC checks, `cross_element`, and `split_topology` used to each repeat independently.
- `is_split_point(level, point) -> bool` — `true` if that point carries `>= 2` nodes; `false` (not a panic) if `level`/`point` don't exist, mirroring `nodes_at`'s own contract. Used where only a single point's split status matters (e.g. `routing`'s per-node split counting), not a full enumeration.

### Constructors

- `single_level(points, &mut IdGenerator) -> Result<Self, &'static str>` — wraps a single `Field::new(points, ids)` call into a one-level aggregator. The drop-in replacement for every pre-#334 `Field::new` call site across `maze-core`/`maze-wasm`/`maze-runner`; the resulting level's id is retrievable via `single_level_id()`.
- `new(levels: impl IntoIterator<Item = Field<T>>) -> Self` — builds from already-constructed `Field`s, one level per entry in iteration order. General-purpose constructor for genuinely multi-level scenarios and for wrapping a `Field` built via an alternate constructor (e.g. `Field::from_id_points`, used by `maze-wasm`'s post-edit path) — not used by the single-level migration itself.

### Migration status (GitHub issue #334)

Every existing single-floor call site across `maze-core`, `maze-wasm`, and `maze-runner` was migrated from raw `Field<T>` to `MultiLevelField<T>` (via `single_level`), with no intended behavior change — same generation output (byte-identical RNG consumption, verified by comparing `all_node_ids()` order against direct `Field::all_node_ids()`), same QC/repair results, same project file format. `Maze<T>.field` is `MultiLevelField<T>`; `Maze::remove_node_at` resolves its node's level internally, while `Maze::add_node_at_on_level` takes the target level from the caller (no level-less `add_node_at` exists — every caller already knows which level it's adding to).

Raw `Field<T>` remains in use only:
- Internally, as the per-level storage `MultiLevelField` wraps.
- In `Field<T>`'s own unit tests (`maze-core/tests/field_test.rs`, `hex_field_test.rs`, `triangle_field_test.rs`, `multi_node_point_test.rs`) — single-tessellation-only tests that have no need for the aggregator.
- At `maze-wasm`'s post-edit path (`analytics/post_edit.rs`'s `build_field_from_nodes`), which constructs via `Field::from_id_points` (preserving client-supplied ids) and then wraps the result with `MultiLevelField::new([field])`.

Built on top of this layer since: add/remove/reorder floors UI (#335), and — as of #337 — `CustomVertexBased` generation, which builds a field from `GenerateConfig.level_fields` (`maze-wasm`'s `dispatch_generate`/`build_multi_level_field`) and connects levels via `EdgeKind::VerticalPassage`/`Elevator` (`Specs/generation.md`'s "Vertical Connections"). As of #338, each level's own field *shape* is independent — `level_fields` carries one point-set per floor — though tessellation *kind* (`T`) is still fixed maze-wide (a `MultiLevelField<T>` uses one `T` for every level it holds — `Maze<T>`'s existing single-`T`-per-maze design). QC/repair/routing during generation is multi-floor-aware. `compute_analytics` (post-edit's confirm step and analytics/snapshot recompute) is genuinely multi-level as of GitHub issue #359 — `ComputeAnalyticsConfig` gained its own `level_fields`, mirroring `GenerateConfig`'s; `maze-wasm`'s `build_analytics_snapshot` always surfaces every floor now — the `all_levels: bool` param that used to gate this was removed (GitHub issue #355), since every real caller had passed `true` since #359 — see `Specs/floors.md`'s "`compute_analytics` multi-level awareness" section. Not yet built: a `LevelId`-aware project file format, or a wire-level way to vary tessellation kind itself between levels.
