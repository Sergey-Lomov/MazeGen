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

    /// The aggregator's single level's id — panics if the level count isn't exactly one. Only
    /// meaningful right after `single_level`, or on an aggregator otherwise known to hold exactly
    /// one level; not a general-purpose accessor.
    pub fn single_level_id(&self) -> LevelId {
        assert_eq!(self.levels.len(), 1, "single_level_id: aggregator does not hold exactly one level");
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
mod tests {
    use super::*;
    use crate::space::{SquareTessellation, SquarePoint, square_rect};

    fn single(w: usize, h: usize) -> (MultiLevelField<SquareTessellation>, IdGenerator) {
        let mut ids = IdGenerator::new();
        let mf = MultiLevelField::<SquareTessellation>::single_level(square_rect(w, h), &mut ids).unwrap();
        (mf, ids)
    }

    #[test]
    fn single_level_builds_one_level_with_all_nodes_mapped() {
        let (mf, _ids) = single(2, 2);
        assert_eq!(mf.level_count(), 1);
        let level = mf.single_level_id();
        for node in mf.all_node_ids() {
            assert_eq!(mf.level_of(node), Some(level));
        }
    }

    #[test]
    fn node_at_and_nodes_at_resolve_within_the_given_level() {
        let (mf, _ids) = single(2, 1);
        let level = mf.single_level_id();
        let p = SquarePoint { x: 0, y: 0 };
        let node = mf.node_at(level, p).unwrap();
        assert_eq!(mf.nodes_at(level, p), &[node]);
        assert_eq!(mf.level_of(node), Some(level));
    }

    #[test]
    fn add_node_at_registers_new_node_in_node_to_level() {
        let (mut mf, mut ids) = single(2, 1);
        let level = mf.single_level_id();
        let p = SquarePoint { x: 0, y: 0 };
        let extra = mf.add_node_at(level, p, &mut ids);
        assert_eq!(mf.level_of(extra), Some(level));
        assert!(mf.nodes_at(level, p).contains(&extra));
    }

    #[test]
    fn remove_node_at_resolves_level_and_point_and_clears_mapping() {
        let (mut mf, mut ids) = single(2, 1);
        let level = mf.single_level_id();
        let p = SquarePoint { x: 0, y: 0 };
        let extra = mf.add_node_at(level, p, &mut ids);

        mf.remove_node_at(extra);

        assert_eq!(mf.level_of(extra), None);
        assert!(!mf.nodes_at(level, p).contains(&extra));
    }

    #[test]
    #[should_panic(expected = "node does not belong to any level")]
    fn remove_node_at_panics_on_unknown_node() {
        let (mut mf, _ids) = single(1, 1);
        mf.remove_node_at(999_999);
    }

    #[test]
    fn replace_nodes_at_unmaps_old_nodes_and_maps_new_ones() {
        let (mut mf, mut ids) = single(1, 1);
        let level = mf.single_level_id();
        let p = SquarePoint { x: 0, y: 0 };
        let original = mf.node_at(level, p).unwrap();
        let extra = mf.add_node_at(level, p, &mut ids);

        let new_id = ids.next_id();
        mf.replace_nodes_at(level, p, vec![new_id]);

        assert_eq!(mf.level_of(original), None);
        assert_eq!(mf.level_of(extra), None);
        assert_eq!(mf.level_of(new_id), Some(level));
        assert_eq!(mf.nodes_at(level, p), &[new_id]);
    }

    #[test]
    fn neighbors_resolves_via_node_level_and_is_empty_for_unknown_node() {
        let (mf, _ids) = single(2, 1);
        let level = mf.single_level_id();
        let a = mf.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let b = mf.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
        assert!(mf.neighbors(a).contains(&b));
        assert_eq!(mf.neighbors(999_999), Vec::<NodeId>::new());
    }

    #[test]
    fn is_straight_true_on_same_level_false_across_levels() {
        let (mf, _ids) = single(3, 1);
        let level = mf.single_level_id();
        let a = mf.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let b = mf.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
        let c = mf.node_at(level, SquarePoint { x: 2, y: 0 }).unwrap();
        assert!(mf.is_straight(a, b, c));

        // Build a second, disjoint level sharing one IdGenerator so ids never collide; a node
        // from it makes the triple non-straight (and, more fundamentally, unresolved to a single
        // level at all).
        let mut shared_ids = IdGenerator::new();
        let mut mf_multi = MultiLevelField::<SquareTessellation>::new([]);
        let l1 = mf_multi.add_level(Field::<SquareTessellation>::new(square_rect(3, 1), &mut shared_ids).unwrap());
        let l2 = mf_multi.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut shared_ids).unwrap());
        let x = mf_multi.node_at(l1, SquarePoint { x: 0, y: 0 }).unwrap();
        let y = mf_multi.node_at(l1, SquarePoint { x: 1, y: 0 }).unwrap();
        let z = mf_multi.node_at(l2, SquarePoint { x: 0, y: 0 }).unwrap();
        assert!(!mf_multi.is_straight(x, y, z));
    }

    #[test]
    fn add_level_remove_level_reorder_levels_lifecycle() {
        let mut ids = IdGenerator::new();
        let mut mf = MultiLevelField::<SquareTessellation>::new([]);
        let f0 = Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap();
        let f1 = Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap();
        let l0 = mf.add_level(f0);
        let l1 = mf.add_level(f1);
        assert_eq!(mf.level_count(), 2);
        assert_eq!(mf.levels_ordered().collect::<Vec<_>>(), vec![l0, l1]);

        mf.reorder_levels(&[l1, l0]);
        assert_eq!(mf.levels_ordered().collect::<Vec<_>>(), vec![l1, l0]);

        let removed = mf.remove_level(l0).unwrap();
        assert_eq!(mf.level_count(), 1);
        assert_eq!(mf.levels_ordered().collect::<Vec<_>>(), vec![l1]);
        for node in removed.all_node_ids() {
            assert_eq!(mf.level_of(node), None);
        }
    }

    #[test]
    #[should_panic(expected = "must be a permutation")]
    fn reorder_levels_panics_on_non_permutation() {
        let mut ids = IdGenerator::new();
        let mut mf = MultiLevelField::<SquareTessellation>::new([]);
        let l0 = mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
        mf.reorder_levels(&[l0, LevelId(999)]);
    }

    #[test]
    #[should_panic(expected = "exactly one level")]
    fn single_level_id_panics_when_not_exactly_one_level() {
        let mf = MultiLevelField::<SquareTessellation>::new([]);
        mf.single_level_id();
    }

    #[test]
    fn clone_is_independent_of_the_original() {
        let (mf, mut ids) = single(2, 1);
        let mut cloned = mf.clone();
        let level = cloned.single_level_id();
        cloned.add_node_at(level, SquarePoint { x: 0, y: 0 }, &mut ids);

        assert_eq!(mf.node_count(), 2);
        assert_eq!(cloned.node_count(), 3);
    }

    #[test]
    fn all_points_with_level_covers_every_level_in_order() {
        let mut ids = IdGenerator::new();
        let mut mf = MultiLevelField::<SquareTessellation>::new([]);
        let f0 = Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap();
        let f1 = Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap();
        let l0 = mf.add_level(f0);
        let l1 = mf.add_level(f1);

        let pairs: Vec<(LevelId, SquarePoint)> = mf.all_points_with_level().collect();
        assert_eq!(pairs.len(), 3);
        assert!(pairs.iter().take(2).all(|(l, _)| *l == l0));
        assert!(pairs.iter().skip(2).all(|(l, _)| *l == l1));
    }

    #[test]
    fn single_level_all_node_ids_matches_plain_field_all_node_ids_order() {
        let mut ids_a = IdGenerator::new();
        let mut ids_b = IdGenerator::new();
        let field = Field::<SquareTessellation>::new(square_rect(4, 3), &mut ids_a).unwrap();
        let expected: Vec<NodeId> = field.all_node_ids().collect();

        let mf = MultiLevelField::<SquareTessellation>::single_level(square_rect(4, 3), &mut ids_b).unwrap();
        let actual: Vec<NodeId> = mf.all_node_ids().collect();

        assert_eq!(actual, expected);
    }

    #[test]
    fn field_of_gives_read_only_access_to_the_wrapped_field() {
        let (mf, _ids) = single(2, 2);
        let level = mf.single_level_id();
        let field = mf.field_of(level).unwrap();
        assert_eq!(field.point_count(), 4);
    }

    #[test]
    fn field_of_unknown_level_is_none() {
        let (mf, _ids) = single(1, 1);
        assert!(mf.field_of(LevelId(999)).is_none());
    }

    #[test]
    #[should_panic(expected = "already belongs to another level")]
    fn add_level_panics_on_node_id_collision_across_levels() {
        // Two independent IdGenerators both start at 0, so the second Field's nodes collide with
        // the first level's — add_level's debug_assert must catch this, not silently overwrite
        // node_to_level.
        let mut ids_a = IdGenerator::new();
        let mut ids_b = IdGenerator::new();
        let mut mf = MultiLevelField::<SquareTessellation>::new([]);
        mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids_a).unwrap());
        mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids_b).unwrap());
    }

    #[test]
    fn point_based_lookups_on_unknown_level() {
        let (mf, _ids) = single(1, 1);
        let unknown = LevelId(999);
        let p = SquarePoint { x: 0, y: 0 };

        assert_eq!(mf.node_at(unknown, p), None);
        assert_eq!(mf.nodes_at(unknown, p), &[] as &[NodeId]);
    }

    #[test]
    #[should_panic(expected = "add_node_at: level not in aggregator")]
    fn add_node_at_panics_on_unknown_level() {
        let (mut mf, mut ids) = single(1, 1);
        mf.add_node_at(LevelId(999), SquarePoint { x: 0, y: 0 }, &mut ids);
    }

    #[test]
    #[should_panic(expected = "replace_nodes_at: level not in aggregator")]
    fn replace_nodes_at_panics_on_unknown_level() {
        let (mut mf, mut ids) = single(1, 1);
        let fresh = ids.next_id();
        mf.replace_nodes_at(LevelId(999), SquarePoint { x: 0, y: 0 }, vec![fresh]);
    }

    #[test]
    fn remove_level_on_unknown_level_is_none() {
        let (mut mf, _ids) = single(1, 1);
        assert!(mf.remove_level(LevelId(999)).is_none());
        // Structure must stay untouched by the no-op.
        assert_eq!(mf.level_count(), 1);
    }

    #[test]
    fn remove_level_returns_the_same_field_that_was_added() {
        let mut ids = IdGenerator::new();
        let mut mf = MultiLevelField::<SquareTessellation>::new([]);
        let field = Field::<SquareTessellation>::new(square_rect(2, 2), &mut ids).unwrap();
        let expected_points: Vec<SquarePoint> = field.all_points().collect();
        let expected_nodes: Vec<NodeId> = field.all_node_ids().collect();
        let level = mf.add_level(field);

        let removed = mf.remove_level(level).unwrap();

        assert_eq!(removed.all_points().collect::<Vec<_>>(), expected_points);
        assert_eq!(removed.all_node_ids().collect::<Vec<_>>(), expected_nodes);
    }

    #[test]
    fn level_ids_are_never_reused_after_remove_and_re_add() {
        let mut ids = IdGenerator::new();
        let mut mf = MultiLevelField::<SquareTessellation>::new([]);
        let l0 = mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
        let l1 = mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
        mf.remove_level(l0);
        let l2 = mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());

        assert_ne!(l2, l0, "a removed level's id must never be reused");
        assert_ne!(l2, l1);
    }

    #[test]
    fn three_level_lifecycle_mid_removal_and_rotation() {
        let mut ids = IdGenerator::new();
        let mut mf = MultiLevelField::<SquareTessellation>::new([]);
        let l0 = mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
        let l1 = mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
        let l2 = mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
        assert_eq!(mf.levels_ordered().collect::<Vec<_>>(), vec![l0, l1, l2]);

        // Cyclic rotation exercises reorder_levels beyond the only-nontrivial-2-permutation case.
        mf.reorder_levels(&[l2, l0, l1]);
        assert_eq!(mf.levels_ordered().collect::<Vec<_>>(), vec![l2, l0, l1]);

        // Removing the middle-of-display-order level must leave the other two intact and in order.
        mf.remove_level(l0);
        assert_eq!(mf.levels_ordered().collect::<Vec<_>>(), vec![l2, l1]);
        assert_eq!(mf.level_count(), 2);

        // max_node_id must reflect the surviving levels' nodes, spanning more than one level.
        let expected_max = mf.node_to_level.keys().copied().max();
        assert_eq!(mf.max_node_id(), expected_max);
    }

    #[test]
    fn max_node_id_spans_multiple_levels() {
        let mut ids = IdGenerator::new();
        let mut mf = MultiLevelField::<SquareTessellation>::new([]);
        mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap());
        mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap());

        let expected = mf.all_node_ids().max();
        assert!(expected.is_some());
        assert_eq!(mf.max_node_id(), expected);
    }

    #[test]
    fn point_count_sums_across_levels_and_differs_from_node_count_with_splits() {
        let mut ids = IdGenerator::new();
        let mut mf = MultiLevelField::<SquareTessellation>::new([]);
        let level = mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 2), &mut ids).unwrap());
        mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());

        // 4 points on the first level + 1 on the second = 5, regardless of extra split nodes added below.
        assert_eq!(mf.point_count(), 5);

        // A split (extra node on an existing point) grows node_count but not point_count.
        mf.add_node_at(level, SquarePoint { x: 0, y: 0 }, &mut ids);
        assert_eq!(mf.point_count(), 5, "point_count must not grow when a point gains an extra split node");
        assert_ne!(mf.point_count(), mf.node_count(), "split node makes node_count diverge from point_count");
    }

    #[test]
    fn point_of_resolves_on_the_nodes_own_level_and_is_none_for_unknown_node() {
        let (mf, _ids) = single(2, 1);
        let level = mf.single_level_id();
        let p = SquarePoint { x: 1, y: 0 };
        let node = mf.node_at(level, p).unwrap();

        assert_eq!(mf.point_of(node), Some(p));
        assert_eq!(mf.point_of(999_999), None);
    }

    #[test]
    fn clone_of_a_multi_level_field_keeps_levels_and_level_order_independent() {
        let mut ids = IdGenerator::new();
        let mut mf = MultiLevelField::<SquareTessellation>::new([]);
        mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
        mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());

        let mut cloned = mf.clone();
        let extra_level = cloned.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
        cloned.remove_level(extra_level);
        let removed_from_clone = cloned.levels_ordered().next().unwrap();
        cloned.remove_level(removed_from_clone);

        assert_eq!(mf.level_count(), 2, "original's levels must be untouched by mutating the clone");
        assert_eq!(cloned.level_count(), 1);
    }
}
