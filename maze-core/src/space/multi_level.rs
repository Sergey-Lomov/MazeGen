use std::collections::HashMap;
use crate::ids::{NodeId, IdGenerator};
use crate::space::{Field, Tessellation};

/// Stable identifier for one level (floor) inside a `MultiLevelField`. Never an index into any
/// `Vec` — never reused, never renumbered when other levels are added/removed/reordered (GitHub
/// issue #335 adds add/remove/reorder UI on top of this without requiring a structure change).
#[derive(Copy, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub struct LevelId(u32);

/// Aggregates one `Field<T>` per level behind a single interface, plus an explicit
/// `NodeId -> LevelId` map maintained at construction/mutation time (GitHub issue #334) — no
/// linear scan, no derivation from ID ranges. `Graph`/`IdGenerator` stay level-agnostic, as
/// today; `NodeId`s remain globally unique across every level.
///
/// **API shape**: operations addressing an existing node take only `NodeId` — the level is
/// resolved internally via `node_to_level`, never required from the caller (see
/// `Specs`/GitHub issue #334's design discussion: the graph itself is level-agnostic, growth
/// algorithms freely mix nodes from different levels in one frontier). `LevelId` is required
/// only where a bare geometric point is otherwise ambiguous (point-based lookup/creation) or for
/// managing the level set itself.
pub struct MultiLevelField<T: Tessellation> {
    levels: HashMap<LevelId, Field<T>>,
    level_order: Vec<LevelId>,
    node_to_level: HashMap<NodeId, LevelId>,
    next_level_id: u32,
}

impl<T: Tessellation> Clone for MultiLevelField<T> {
    fn clone(&self) -> Self {
        Self {
            levels: self.levels.clone(),
            level_order: self.level_order.clone(),
            node_to_level: self.node_to_level.clone(),
            next_level_id: self.next_level_id,
        }
    }
}

impl<T: Tessellation> MultiLevelField<T> {
    /// Empty aggregator, no levels yet — internal starting point for `single_level`/`new`.
    fn empty() -> Self {
        Self {
            levels: HashMap::new(),
            level_order: Vec::new(),
            node_to_level: HashMap::new(),
            next_level_id: 0,
        }
    }

    /// Wraps a single `Field::new(points, ids)` call into a one-level aggregator — the drop-in
    /// replacement for every existing `Field::new` call site during the single-level migration
    /// (GitHub issue #334). The resulting level's id is retrievable via `single_level_id()`.
    pub fn single_level(
        points: impl IntoIterator<Item = T::Point>,
        ids: &mut IdGenerator,
    ) -> Result<Self, &'static str> {
        let field = Field::new(points, ids)?;
        let mut mf = Self::empty();
        mf.add_level(field);
        Ok(mf)
    }

    /// Builds a multi-level aggregator from already-constructed `Field`s, one level per entry in
    /// iteration order. General-purpose constructor for future multi-level scenarios — not used
    /// by the single-level migration itself (`single_level` covers that).
    pub fn new(levels: impl IntoIterator<Item = Field<T>>) -> Self {
        let mut mf = Self::empty();
        for field in levels {
            mf.add_level(field);
        }
        mf
    }

    /// Adds `field` as a new level, minting a fresh `LevelId` (never reused, never tied to
    /// position — GitHub issue #335 add/remove/reorder relies on this). Registers every node in
    /// `field` into `node_to_level`.
    ///
    /// Debug-asserts none of `field`'s nodes already belong to another level — a `NodeId`
    /// collision across levels would otherwise silently overwrite the mapping instead of
    /// signalling a broken invariant (mirrors `Field::from_id_points`'s duplicate-id
    /// `debug_assert!` convention). The global per-`Maze` `IdGenerator` is expected to guarantee
    /// uniqueness, but the aggregator does not blindly trust callers of `new`/`add_level`.
    pub fn add_level(&mut self, field: Field<T>) -> LevelId {
        let level = LevelId(self.next_level_id);
        self.next_level_id += 1;
        for node in field.all_node_ids() {
            debug_assert!(
                !self.node_to_level.contains_key(&node),
                "add_level: NodeId {node:?} already belongs to another level",
            );
            self.node_to_level.insert(node, level);
        }
        self.levels.insert(level, field);
        self.level_order.push(level);
        level
    }

    /// Removes `level` and returns its `Field`, or `None` if `level` doesn't exist. Clears every
    /// mapping entry for that level's nodes — the caller (GitHub issue #335) decides what to do
    /// with the returned `Field`'s nodes; this only guarantees the aggregator's own structure
    /// stays consistent afterwards.
    pub fn remove_level(&mut self, level: LevelId) -> Option<Field<T>> {
        let field = self.levels.remove(&level)?;
        self.level_order.retain(|&l| l != level);
        self.node_to_level.retain(|_, &mut l| l != level);
        Some(field)
    }

    /// Reorders the display/iteration order of levels. `new_order` must be a permutation of the
    /// current level set — panics otherwise, since that is a structural invariant violation, not
    /// a recoverable runtime condition.
    pub fn reorder_levels(&mut self, new_order: &[LevelId]) {
        let mut current: Vec<LevelId> = self.level_order.clone();
        current.sort_unstable();
        let mut given: Vec<LevelId> = new_order.to_vec();
        given.sort_unstable();
        assert_eq!(current, given, "reorder_levels: new_order must be a permutation of the current level set");
        self.level_order = new_order.to_vec();
    }

    /// The aggregator's first level (by `levels_ordered()` position) — panics only if there are
    /// no levels at all, which never happens for a live `MultiLevelField` (every constructor adds
    /// at least one). QC/repair/routing/analytics/post-edit are all multi-floor-aware as of the
    /// GitHub issue #333 epic; the only remaining caller is `io::render_ascii`, a debug/example
    /// tool that only ever renders one floor by design.
    pub fn single_level_id(&self) -> LevelId {
        self.level_order[0]
    }

    pub fn level_count(&self) -> usize {
        self.levels.len()
    }

    pub fn levels_ordered(&self) -> impl Iterator<Item = LevelId> + '_ {
        self.level_order.iter().copied()
    }

    /// Read-only access to one level's underlying `Field` — for callers that need the full
    /// `Field` contract without level bookkeeping (e.g. rendering, geometry). Never `&mut`: every
    /// mutation must go through this aggregator's own node-id-based/point-based methods so
    /// `node_to_level` never drifts out of sync.
    pub fn field_of(&self, level: LevelId) -> Option<&Field<T>> {
        self.levels.get(&level)
    }

    // --- Node-id-based API: level resolved internally, never required from the caller ---

    pub fn level_of(&self, node: NodeId) -> Option<LevelId> {
        self.node_to_level.get(&node).copied()
    }

    /// `node`'s 0-based position in `levels_ordered()` (GitHub issue #337) — the web client's
    /// `floors` array index, unlike the underlying `LevelId` (a stable minted id, never reused or
    /// renumbered — see `Specs/space.md` — so not usable as a UI-facing array index). `None` if
    /// `node` doesn't belong to any level.
    pub fn level_index_of(&self, node: NodeId) -> Option<usize> {
        let level = self.level_of(node)?;
        self.level_order.iter().position(|&l| l == level)
    }

    /// Geometric point of `node`, resolved on `node`'s own level. `None` if `node` doesn't
    /// belong to any level — node-id-based, mirrors `neighbors`/`level_of`.
    pub fn point_of(&self, node: NodeId) -> Option<T::Point> {
        let level = self.level_of(node)?;
        self.levels[&level].point_of(node)
    }

    /// Geometric neighbors of `node`, resolved on `node`'s own level. Empty `Vec` if `node`
    /// doesn't belong to any level — mirrors `Field::neighbors`'s existing behavior for an
    /// unknown node (not a panic).
    pub fn neighbors(&self, node: NodeId) -> Vec<NodeId> {
        let Some(level) = self.level_of(node) else { return Vec::new(); };
        self.levels[&level].neighbors(node)
    }

    /// `node`'s *potential* `VerticalPassage` partner nodes: whichever node(s) exist at `node`'s
    /// own x-y point on the floor(s) directly above and/or below its own (never both if `node` is
    /// on a boundary floor) — resolved purely from tessellation/level structure, regardless of
    /// whether a `VerticalPassage`/`Elevator` edge between them has actually been added yet. Not
    /// geometric in the `neighbors()` sense (no shared tessellation face — same x-y point on a
    /// different level entirely), and deliberately not `Graph`-backed either: `CustomVertexBased`'s
    /// reserve-populate step (GitHub issue #337 follow-up) needs to know a vertical partner is a
    /// *reachable candidate* before any edge to it exists, not just recognize one that already
    /// does — the whole point is giving an unlucky `vertical_chance` miss a second chance later,
    /// the same way a geometric free neighbor already gets via plain `reserve`. Only adjacent
    /// floors, not an `Elevator`'s full far-floor fan — same "one hop, not a long-distance bridge"
    /// scope reserve-bridging already uses for its ordinary geometric candidates. Deliberately a
    /// separate method rather than a parameter on `neighbors` itself — every other caller of
    /// `neighbors` (geometric growth, `is_straight`, repair/QC) must keep seeing geometric-only
    /// results unconditionally, and a boolean/enum parameter would require every one of those call
    /// sites to opt out explicitly instead of never being touched at all.
    pub fn vertical_neighbors(&self, node: NodeId) -> Vec<NodeId> {
        let Some(point) = self.point_of(node) else { return Vec::new(); };
        let Some(level) = self.level_of(node) else { return Vec::new(); };
        let Some(idx) = self.level_order.iter().position(|&l| l == level) else { return Vec::new(); };
        let mut result = Vec::new();
        if idx > 0 {
            result.extend(self.nodes_at(self.level_order[idx - 1], point));
        }
        if let Some(&above) = self.level_order.get(idx + 1) {
            result.extend(self.nodes_at(above, point));
        }
        result
    }

    /// `true` only if `from`/`via`/`to` all resolve to the same level and are geometrically
    /// straight on it. Cross-level triples are never straight — geometric straightness is
    /// undefined between levels (GitHub issue #337 will introduce a separate stairs/elevator
    /// notion, not through this method).
    pub fn is_straight(&self, from: NodeId, via: NodeId, to: NodeId) -> bool {
        let (Some(lf), Some(lv), Some(lt)) = (self.level_of(from), self.level_of(via), self.level_of(to)) else { return false; };
        if lf != lv || lv != lt { return false; }
        self.levels[&lf].is_straight(from, via, to)
    }

    /// Removes `node` from the aggregator entirely — resolves both its level and point
    /// internally, unlike `Field::remove_node_at` which takes the point explicitly (redundant
    /// once it's derivable from `node`). Panics if `node` doesn't belong to any level, mirroring
    /// `Field::remove_node_at`'s own panic-on-unknown-node contract — never a silent no-op.
    pub fn remove_node_at(&mut self, node: NodeId) {
        let level = self.level_of(node)
            .unwrap_or_else(|| panic!("remove_node_at: node does not belong to any level"));
        let field = self.levels.get_mut(&level).expect("level present in node_to_level must exist in levels");
        let point = field.point_of(node)
            .unwrap_or_else(|| panic!("remove_node_at: node does not belong to any level"));
        field.remove_node_at(point, node);
        self.node_to_level.remove(&node);
    }

    // --- Point-based API: level required, a bare point is ambiguous across levels ---

    pub fn node_at(&self, level: LevelId, point: T::Point) -> Option<NodeId> {
        self.levels.get(&level)?.nodes_at(point).first().copied()
    }

    pub fn nodes_at(&self, level: LevelId, point: T::Point) -> &[NodeId] {
        self.levels.get(&level).map_or(&[], |f| f.nodes_at(point))
    }

    /// Adds a node to `point` on `level` and registers it in `node_to_level`. Panics if `level`
    /// doesn't exist or `point` isn't already in that level's field — mirrors
    /// `Field::add_node_at`'s own panic contract.
    pub fn add_node_at(&mut self, level: LevelId, point: T::Point, ids: &mut IdGenerator) -> NodeId {
        let field = self.levels.get_mut(&level)
            .unwrap_or_else(|| panic!("add_node_at: level not in aggregator"));
        let node = field.add_node_at(point, ids);
        self.node_to_level.insert(node, level);
        node
    }

    /// Replaces every node at `point` on `level` with `new_ids`. Removes the mapping for every
    /// node currently at that point, then adds mapping for each of `new_ids` — after the call,
    /// any old id not in `new_ids` gives `level_of(old_id) == None`, and every id in `new_ids`
    /// gives `level_of(new_id) == Some(level)`.
    pub fn replace_nodes_at(&mut self, level: LevelId, point: T::Point, new_ids: Vec<NodeId>) {
        let field = self.levels.get_mut(&level)
            .unwrap_or_else(|| panic!("replace_nodes_at: level not in aggregator"));
        let old_nodes: Vec<NodeId> = field.nodes_at(point).to_vec();
        for old in &old_nodes {
            self.node_to_level.remove(old);
        }
        field.replace_nodes_at(point, new_ids.clone());
        for &new in &new_ids {
            self.node_to_level.insert(new, level);
        }
    }

    // --- Truly global aggregates: no LevelId required, span every level ---

    /// Every `NodeId` across every level, sorted — deterministic order matching
    /// `Field::all_node_ids()`'s own sorted-by-`NodeId` contract (for a single-level aggregator
    /// this is byte-for-byte identical to calling `all_node_ids()` on the wrapped `Field`
    /// directly, which generation's RNG consumption depends on).
    pub fn all_node_ids(&self) -> impl Iterator<Item = NodeId> + '_ {
        let mut ids: Vec<NodeId> = self.node_to_level.keys().copied().collect();
        ids.sort_unstable();
        ids.into_iter()
    }

    pub fn max_node_id(&self) -> Option<NodeId> {
        self.node_to_level.keys().copied().max()
    }

    pub fn node_count(&self) -> usize {
        self.node_to_level.len()
    }

    /// Total distinct field cells (points) across every level — the multi-level counterpart of
    /// `Field::point_count()`, summed. Ratio/density QC checks normalizing "per 100 field cells"
    /// across the whole maze use this, not `node_count()` (inflated by split tiles) and not any
    /// single level's own `point_count()`.
    pub fn point_count(&self) -> usize {
        self.levels.values().map(|f| f.point_count()).sum()
    }

    /// Every `(LevelId, Point)` pair across every level, grouped by level in `levels_ordered()`
    /// order, each level's own points in that level's `Field::all_points()` order. For
    /// single-level/level-agnostic callers, prefer `field_of(level).all_points()` instead — this
    /// is for genuinely level-aware code (future multi-level UI/QC).
    pub fn all_points_with_level(&self) -> impl Iterator<Item = (LevelId, T::Point)> + '_ {
        self.level_order.iter().flat_map(move |&level| {
            self.levels[&level].all_points().map(move |p| (level, p))
        })
    }
}


#[cfg(test)]
#[path = "multi_level_tests.rs"]
mod tests;
