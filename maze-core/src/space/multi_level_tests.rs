use super::*;
use crate::space::{SquarePoint, SquareTessellation, square_rect};

fn single(w: usize, h: usize) -> (MultiLevelField<SquareTessellation>, IdGenerator) {
    let mut ids = IdGenerator::new();
    let mf =
        MultiLevelField::<SquareTessellation>::single_level(square_rect(w, h), &mut ids).unwrap();
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
fn vertical_neighbors_unknown_node_is_empty() {
    let (mf, _ids) = single(2, 1);
    assert_eq!(mf.vertical_neighbors(999_999), Vec::<NodeId>::new());
}

#[test]
fn vertical_neighbors_on_boundary_floors_only_has_the_one_adjacent_side() {
    let mut ids = IdGenerator::new();
    let mut mf = MultiLevelField::<SquareTessellation>::new([]);
    let bottom =
        mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
    let middle =
        mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
    let top = mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
    let p = SquarePoint { x: 0, y: 0 };
    let bottom_node = mf.node_at(bottom, p).unwrap();
    let middle_node = mf.node_at(middle, p).unwrap();
    let top_node = mf.node_at(top, p).unwrap();

    assert_eq!(mf.vertical_neighbors(bottom_node), vec![middle_node]);
    assert_eq!(mf.vertical_neighbors(top_node), vec![middle_node]);
}

#[test]
fn vertical_neighbors_on_an_interior_floor_has_both_sides() {
    let mut ids = IdGenerator::new();
    let mut mf = MultiLevelField::<SquareTessellation>::new([]);
    let bottom =
        mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
    let middle =
        mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
    let top = mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
    let p = SquarePoint { x: 0, y: 0 };
    let bottom_node = mf.node_at(bottom, p).unwrap();
    let middle_node = mf.node_at(middle, p).unwrap();
    let top_node = mf.node_at(top, p).unwrap();

    let mut result = mf.vertical_neighbors(middle_node);
    result.sort();
    let mut expected = vec![bottom_node, top_node];
    expected.sort();
    assert_eq!(result, expected);
}

#[test]
fn vertical_neighbors_ignores_points_with_no_node_on_the_adjacent_floor() {
    // Two floors whose fields don't share the same shape at (1, 0) — the smaller field has no
    // node there at all, so the larger field's own node at that point has no vertical partner.
    let mut ids = IdGenerator::new();
    let mut mf = MultiLevelField::<SquareTessellation>::new([]);
    let small =
        mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
    let wide = mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap());
    let far_node = mf.node_at(wide, SquarePoint { x: 1, y: 0 }).unwrap();
    let _ = small;

    assert_eq!(mf.vertical_neighbors(far_node), Vec::<NodeId>::new());
}

#[test]
fn vertical_neighbors_returns_every_split_node_at_the_adjacent_point_not_just_the_first() {
    let mut ids = IdGenerator::new();
    let mut mf = MultiLevelField::<SquareTessellation>::new([]);
    let bottom =
        mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
    let top = mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
    let p = SquarePoint { x: 0, y: 0 };
    let bottom_node = mf.node_at(bottom, p).unwrap();
    // A split point on `top` at the same (x, y) — a second node co-located with the original.
    let extra_top_node = mf.add_node_at(top, p, &mut ids);
    let original_top_node = mf.node_at(top, p).unwrap();

    let mut result = mf.vertical_neighbors(bottom_node);
    result.sort();
    let mut expected = vec![original_top_node, extra_top_node];
    expected.sort();
    assert_eq!(result, expected);
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
    let l1 = mf_multi
        .add_level(Field::<SquareTessellation>::new(square_rect(3, 1), &mut shared_ids).unwrap());
    let l2 = mf_multi
        .add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut shared_ids).unwrap());
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
#[should_panic]
fn single_level_id_panics_on_an_empty_aggregator() {
    let mf = MultiLevelField::<SquareTessellation>::new([]);
    mf.single_level_id();
}

#[test]
fn single_level_id_returns_the_first_level_when_several_exist() {
    let mut ids = IdGenerator::new();
    let mut mf = MultiLevelField::<SquareTessellation>::new([]);
    let l0 = mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
    mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
    assert_eq!(mf.single_level_id(), l0);
}

#[test]
fn level_index_of_matches_levels_ordered_position() {
    let mut ids = IdGenerator::new();
    let mut mf = MultiLevelField::<SquareTessellation>::new([]);
    mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
    let l1 = mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
    let node_on_l1 = mf.node_at(l1, SquarePoint { x: 0, y: 0 }).unwrap();
    assert_eq!(mf.level_index_of(node_on_l1), Some(1));
}

#[test]
fn level_index_of_none_for_unknown_node() {
    let mf = MultiLevelField::<SquareTessellation>::new([]);
    assert_eq!(mf.level_index_of(999), None);
}

#[test]
fn level_index_of_tracks_reordering_not_the_original_insertion_position() {
    let mut ids = IdGenerator::new();
    let mut mf = MultiLevelField::<SquareTessellation>::new([]);
    let l0 = mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
    let l1 = mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
    let node_on_l0 = mf.node_at(l0, SquarePoint { x: 0, y: 0 }).unwrap();
    assert_eq!(mf.level_index_of(node_on_l0), Some(0));

    mf.reorder_levels(&[l1, l0]);
    assert_eq!(mf.level_index_of(node_on_l0), Some(1));
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
fn split_points_dedups_a_split_tile_and_skips_unsplit_points() {
    let (mut mf, mut ids) = single(3, 1);
    let level = mf.single_level_id();
    mf.add_node_at(level, SquarePoint { x: 1, y: 0 }, &mut ids);

    let points: Vec<_> = mf.split_points().collect();
    assert_eq!(
        points,
        vec![(level, SquarePoint { x: 1, y: 0 })],
        "the split point appears exactly once, unsplit points are excluded"
    );
}

#[test]
fn split_points_is_scoped_per_level() {
    let mut ids = IdGenerator::new();
    let field_a = Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap();
    let field_b = Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap();
    let mut mf = MultiLevelField::<SquareTessellation>::new([field_a]);
    let level_a = mf.single_level_id();
    let level_b = mf.add_level(field_b);
    mf.add_node_at(level_a, SquarePoint { x: 0, y: 0 }, &mut ids);
    mf.add_node_at(level_b, SquarePoint { x: 1, y: 0 }, &mut ids);

    let points: std::collections::HashSet<_> = mf.split_points().collect();
    assert_eq!(
        points,
        std::collections::HashSet::from([
            (level_a, SquarePoint { x: 0, y: 0 }),
            (level_b, SquarePoint { x: 1, y: 0 }),
        ]),
        "each level's own split tile is reported against its own level"
    );
}

#[test]
fn is_split_point_matches_split_points() {
    let (mut mf, mut ids) = single(2, 1);
    let level = mf.single_level_id();
    let split = SquarePoint { x: 0, y: 0 };
    let plain = SquarePoint { x: 1, y: 0 };
    mf.add_node_at(level, split, &mut ids);

    assert!(mf.is_split_point(level, split));
    assert!(!mf.is_split_point(level, plain));
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

    let mf =
        MultiLevelField::<SquareTessellation>::single_level(square_rect(4, 3), &mut ids_b).unwrap();
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
    let level =
        mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 2), &mut ids).unwrap());
    mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());

    // 4 points on the first level + 1 on the second = 5, regardless of extra split nodes added below.
    assert_eq!(mf.point_count(), 5);

    // A split (extra node on an existing point) grows node_count but not point_count.
    mf.add_node_at(level, SquarePoint { x: 0, y: 0 }, &mut ids);
    assert_eq!(
        mf.point_count(),
        5,
        "point_count must not grow when a point gains an extra split node"
    );
    assert_ne!(
        mf.point_count(),
        mf.node_count(),
        "split node makes node_count diverge from point_count"
    );
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
    let extra_level =
        cloned.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap());
    cloned.remove_level(extra_level);
    let removed_from_clone = cloned.levels_ordered().next().unwrap();
    cloned.remove_level(removed_from_clone);

    assert_eq!(
        mf.level_count(),
        2,
        "original's levels must be untouched by mutating the clone"
    );
    assert_eq!(cloned.level_count(), 1);
}
