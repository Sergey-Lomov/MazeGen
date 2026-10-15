use super::*;
use crate::graph::EdgeKind;
use crate::quality_control::Issue;
use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use crate::{Graph, IdGenerator};
use rand::SeedableRng;
use std::sync::Arc;

const TEST_ID: &str = "max_one_way_count";

fn rng() -> crate::random::MazeRng {
    crate::random::MazeRng::seed_from_u64(0)
}

/// 4-tile corridor with two one-way edges (0->1, 1->2) and one bidirectional passage (2<->3).
fn maze_with_two_one_ways() -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(4, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(p(0), p(1), EdgeKind::Basic);
    g.add_edge(p(1), p(2), EdgeKind::Basic);
    g.add_bidirectional_edge(p(2), p(3), EdgeKind::Basic);
    Maze::new(field, g)
}

#[test]
fn silent_when_count_meets_maximum() {
    let maze = maze_with_two_one_ways();
    let check = MaxOneWayCountCheck {
        instance_id: TEST_ID.to_string(),
        max_one_ways: 2,
        floor_scope: FloorScope::WholeMaze,
    };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert!(issues.is_empty());
}

#[test]
fn fires_with_all_one_ways_as_single_group_when_above_maximum() {
    let maze = maze_with_two_one_ways();
    let check = MaxOneWayCountCheck {
        instance_id: TEST_ID.to_string(),
        max_one_ways: 1,
        floor_scope: FloorScope::WholeMaze,
    };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert_eq!(issues.len(), 1);
    assert_eq!(
        issues[0].groups.len(),
        1,
        "excess must be reported as a single group"
    );
    assert_eq!(
        issues[0].groups[0].0.len(),
        2,
        "the group must contain every one-way edge, not just the excess"
    );
    assert_eq!(
        issues[0].groups[0].1, 1,
        "2 one-ways over a max of 1 -- excess is 1"
    );
    assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
    assert_eq!(
        issues[0]
            .details()
            .get(TEST_ID)
            .and_then(|kv| kv.get("max_one_ways")),
        Some(&"1".to_string()),
    );
}

#[test]
fn does_not_count_bidirectional_passage_as_one_way() {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let check = MaxOneWayCountCheck {
        instance_id: TEST_ID.to_string(),
        max_one_ways: 0,
        floor_scope: FloorScope::WholeMaze,
    };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert!(
        issues.is_empty(),
        "bidirectional passage must not count toward the one-way total"
    );
}

#[test]
fn does_not_count_a_teleport_edge() {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(p(0), p(1), EdgeKind::Teleport);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let check = MaxOneWayCountCheck {
        instance_id: TEST_ID.to_string(),
        max_one_ways: 0,
        floor_scope: FloorScope::WholeMaze,
    };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert!(
        issues.is_empty(),
        "a Teleport edge must not count toward the Basic one-way total"
    );
}

#[test]
fn flags_a_basic_one_way_paired_with_a_parallel_reverse_teleport() {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(p(0), p(1), EdgeKind::Basic);
    g.add_edge(p(1), p(0), EdgeKind::Teleport);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let check = MaxOneWayCountCheck {
        instance_id: TEST_ID.to_string(),
        max_one_ways: 0,
        floor_scope: FloorScope::WholeMaze,
    };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert_eq!(
        issues.len(),
        1,
        "the parallel reverse Teleport must not mask the Basic one-way"
    );
}

/// Bottom floor: 3 one-ways (0->1, 1->2, 2->3). Top floor: 2 one-ways (0->1, 1->2).
fn maze_with_one_ways_on_two_floors() -> Maze<SquareTessellation> {
    use crate::space::Field;
    let mut ids = IdGenerator::new();
    let mut mf: MultiLevelField<SquareTessellation> =
        MultiLevelField::new(Arc::default(), std::iter::empty());
    let bottom = mf.add_level(
        Field::<SquareTessellation>::new(Arc::default(), square_rect(4, 1), &mut ids).unwrap(),
    );
    let top = mf.add_level(
        Field::<SquareTessellation>::new(Arc::default(), square_rect(3, 1), &mut ids).unwrap(),
    );
    let mut g = Graph::new();
    for node in mf.all_node_ids() {
        g.add_node(node);
    }
    let pb = |x: i32| mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
    let pt = |x: i32| mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(pb(0), pb(1), EdgeKind::Basic);
    g.add_edge(pb(1), pb(2), EdgeKind::Basic);
    g.add_edge(pb(2), pb(3), EdgeKind::Basic);
    g.add_edge(pt(0), pt(1), EdgeKind::Basic);
    g.add_edge(pt(1), pt(2), EdgeKind::Basic);
    Maze::new(mf, g)
}

#[test]
fn per_floor_flags_each_over_budget_floor_with_its_own_group_and_excess() {
    let maze = maze_with_one_ways_on_two_floors();
    let check = MaxOneWayCountCheck {
        instance_id: TEST_ID.to_string(),
        max_one_ways: 1,
        floor_scope: FloorScope::PerFloor,
    };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert_eq!(issues.len(), 1);
    let mut groups = issues[0].groups.clone();
    groups.sort_by_key(|(g, _)| g.len());
    assert_eq!(
        groups.len(),
        2,
        "each over-budget floor must get its own independent group"
    );
    assert_eq!(groups[0].0.len(), 2, "top floor's own one-ways only");
    assert_eq!(
        groups[0].1, 1,
        "top floor's own excess (2 - 1), not the max across floors"
    );
    assert_eq!(groups[1].0.len(), 3, "bottom floor's own one-ways only");
    assert_eq!(
        groups[1].1, 2,
        "bottom floor's own excess (3 - 1), not the max across floors"
    );
}
