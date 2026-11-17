use super::*;
use maze_core::graph::{EdgeKind, Graph};
use maze_core::ids::IdGenerator;
use maze_core::quality_control::CYCLE_ANALYSIS_OVERFLOWED;
use maze_core::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use std::sync::Arc;

#[test]
fn pushes_cycle_analysis_overflowed_issue_on_overflow() {
    // Same 6x6 fully-bidirectional grid as the cycles.rs/min_loop_length.rs regression
    // tests for issue #22 (2,444,782 simple cycles — far past MAX_SIMPLE_CYCLES).
    const SIDE: i32 = 6;
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(
        Arc::default(),
        square_rect(SIDE as usize, SIDE as usize),
        &mut ids,
    )
    .unwrap();
    let level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    for y in 0..SIDE {
        for x in 0..SIDE {
            let here = field
                .nodes_at(level, SquarePoint { x, y })
                .first()
                .copied()
                .unwrap();
            if x + 1 < SIDE {
                let right = field
                    .nodes_at(level, SquarePoint { x: x + 1, y })
                    .first()
                    .copied()
                    .unwrap();
                g.build_initial_bidirectional_edge(here, right, EdgeKind::Basic);
            }
            if y + 1 < SIDE {
                let up = field
                    .nodes_at(level, SquarePoint { x, y: y + 1 })
                    .first()
                    .copied()
                    .unwrap();
                g.build_initial_bidirectional_edge(here, up, EdgeKind::Basic);
            }
        }
    }
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let snapshot = build_analytics_snapshot(
        &mut maze,
        None,
        Some(vec![]),
        &HashMap::new(),
        &PresetState::empty(),
        |p| (p.x, p.y),
        |_, _, pos| pos as u32,
        None,
    )
    .unwrap();

    assert!(snapshot.statistics.graph_stats.cycle_analysis_overflowed);
    assert!(
        snapshot
            .issues
            .iter()
            .any(|i| i.kind == CYCLE_ANALYSIS_OVERFLOWED.to_string())
    );
}

#[test]
fn no_overflow_issue_on_sparse_graph() {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let a = field
        .nodes_at(level, SquarePoint { x: 0, y: 0 })
        .first()
        .copied()
        .unwrap();
    let b = field
        .nodes_at(level, SquarePoint { x: 1, y: 0 })
        .first()
        .copied()
        .unwrap();
    g.build_initial_bidirectional_edge(a, b, EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let snapshot = build_analytics_snapshot(
        &mut maze,
        None,
        Some(vec![]),
        &HashMap::new(),
        &PresetState::empty(),
        |p| (p.x, p.y),
        |_, _, pos| pos as u32,
        None,
    )
    .unwrap();

    assert!(!snapshot.statistics.graph_stats.cycle_analysis_overflowed);
    assert!(
        !snapshot
            .issues
            .iter()
            .any(|i| i.kind == CYCLE_ANALYSIS_OVERFLOWED.to_string())
    );
}

#[test]
fn statistics_dto_reflects_cells_passages_and_elements() {
    // 3x1 line: a-b bidirectional (open passage), b-c wall (no edge at all).
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let a = field
        .nodes_at(level, SquarePoint { x: 0, y: 0 })
        .first()
        .copied()
        .unwrap();
    let b = field
        .nodes_at(level, SquarePoint { x: 1, y: 0 })
        .first()
        .copied()
        .unwrap();
    g.build_initial_bidirectional_edge(a, b, EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let snapshot = build_analytics_snapshot(
        &mut maze,
        None,
        Some(vec![]),
        &HashMap::new(),
        &PresetState::empty(),
        |p| (p.x, p.y),
        |_, _, pos| pos as u32,
        None,
    )
    .unwrap();
    let stats = &snapshot.statistics;

    assert_eq!(stats.cell_count.total, 3);
    assert_eq!(
        stats.cell_stats.total.dead_ends, 3,
        "b-c is a wall, so b has only one shape neighbor (a) and is also a dead end"
    );
    assert_eq!(stats.cell_stats.total.straight, 0);
    assert_eq!(
        stats.passage_stats.total.total_pairs, 2,
        "3x1 field has 2 adjacent pairs"
    );
    assert_eq!(stats.passage_stats.total.bidirectional, 1);
    assert_eq!(stats.passage_stats.total.walls, 1);
    assert_eq!(stats.elements_stats.total.one_way_passages, 0);
    assert_eq!(stats.elements_stats.total.two_way_teleports, 0);
    assert_eq!(stats.elements_stats.total.split_tile_count, 0);

    assert_eq!(
        stats.cell_count.by_floor.get("0"),
        Some(&3),
        "single-floor maze mirrors the total in by_floor[\"0\"]"
    );
    assert_eq!(
        stats.passage_stats.by_floor.get("0").map(|s| s.total_pairs),
        Some(2)
    );
}

#[test]
fn snapshot_nodes_lists_a_split_points_nodes_exactly_once_each() {
    // GitHub issue #223 regression: `Field::all_cells()` yields one entry per NodeId, so a
    // split point (2+ NodeIds at the same coordinate) used to make `nodes` list that point's
    // node pair once per its own node count — a 2-node split point appeared 2x (4 entries
    // instead of 2), a 3-node split point 3x, etc.
    let mut ids = IdGenerator::new();
    let mut field =
        MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let p = SquarePoint { x: 1, y: 0 };
    let extra = field.add_node_at(level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    g.add_node(extra);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let snapshot = build_analytics_snapshot(
        &mut maze,
        None,
        Some(vec![]),
        &HashMap::new(),
        &PresetState::empty(),
        |p| (p.x, p.y),
        |_, _, pos| pos as u32,
        None,
    )
    .unwrap();

    let at_split_point: Vec<_> = snapshot
        .nodes
        .iter()
        .filter(|n| n.x == 1 && n.y == 0)
        .collect();
    assert_eq!(
        at_split_point.len(),
        2,
        "split point's node list must appear exactly once, not once per its own node count"
    );
    let mut ids_seen: Vec<u32> = at_split_point.iter().map(|n| n.id).collect();
    ids_seen.sort_unstable();
    ids_seen.dedup();
    assert_eq!(
        ids_seen.len(),
        2,
        "no duplicate NodeIds within the split point's entries"
    );
}

#[test]
fn statistics_dto_reflects_elevator_stop_count_by_floor() {
    // GitHub issue #436: a 3-floor field with one elevator group spanning floors 0 and 2
    // (floor 1 has no stop) — checks `elevator_stop_count.by_floor` wiring end-to-end through
    // `build_analytics_snapshot`, not just `compute_elevator_stop_count_scoped` in isolation.
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
    let level0 = field.single_level_id();
    let _level1 = field.add_level(Field::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap());
    let level2 = field.add_level(Field::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap());
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let a0 = field
        .nodes_at(level0, SquarePoint { x: 0, y: 0 })
        .first()
        .copied()
        .unwrap();
    let a2 = field
        .nodes_at(level2, SquarePoint { x: 0, y: 0 })
        .first()
        .copied()
        .unwrap();
    g.build_initial_bidirectional_edge(a0, a2, EdgeKind::Elevator);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let snapshot = build_analytics_snapshot(
        &mut maze,
        None,
        Some(vec![]),
        &HashMap::new(),
        &PresetState::empty(),
        |p| (p.x, p.y),
        |_, _, pos| pos as u32,
        None,
    )
    .unwrap();
    let stats = &snapshot.statistics;

    assert_eq!(stats.vertical_stats.elevator_groups, 1);
    assert_eq!(stats.vertical_stats.elevator_stop_count, 2);
    assert_eq!(stats.vertical_stats.average_elevator_stops, 2.0);
    assert_eq!(stats.elevator_stop_count.total, 2);
    assert_eq!(
        stats.elevator_stop_count.by_floor.get("0"),
        Some(&1),
        "level0's own stop"
    );
    assert_eq!(
        stats.elevator_stop_count.by_floor.get("1"),
        Some(&0),
        "middle floor has no stop"
    );
    assert_eq!(
        stats.elevator_stop_count.by_floor.get("2"),
        Some(&1),
        "level2's own stop"
    );
}

#[test]
fn region_classes_empty_when_start_or_finish_unset() {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let a = field
        .nodes_at(level, SquarePoint { x: 0, y: 0 })
        .first()
        .copied()
        .unwrap();
    let b = field
        .nodes_at(level, SquarePoint { x: 1, y: 0 })
        .first()
        .copied()
        .unwrap();
    g.build_initial_bidirectional_edge(a, b, EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    // Neither start nor finish set.

    let snapshot = build_analytics_snapshot(
        &mut maze,
        None,
        Some(vec![]),
        &HashMap::new(),
        &PresetState::empty(),
        |p| (p.x, p.y),
        |_, _, pos| pos as u32,
        None,
    )
    .unwrap();

    assert!(snapshot.statistics.graph_stats.region_classes.is_empty());
}

#[test]
fn region_classes_populated_when_start_and_finish_set() {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let a = field
        .nodes_at(level, SquarePoint { x: 0, y: 0 })
        .first()
        .copied()
        .unwrap();
    let b = field
        .nodes_at(level, SquarePoint { x: 1, y: 0 })
        .first()
        .copied()
        .unwrap();
    let c = field
        .nodes_at(level, SquarePoint { x: 2, y: 0 })
        .first()
        .copied()
        .unwrap();
    g.build_initial_bidirectional_edge(a, b, EdgeKind::Basic);
    g.build_initial_bidirectional_edge(b, c, EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(a);
    maze.meta.finish = Some(c);

    let snapshot = build_analytics_snapshot(
        &mut maze,
        None,
        Some(vec![]),
        &HashMap::new(),
        &PresetState::empty(),
        |p| (p.x, p.y),
        |_, _, pos| pos as u32,
        None,
    )
    .unwrap();

    // Fully bidirectional 3-node line collapses into a single SCC — start and finish share
    // a region, which is always "path" by definition.
    assert!(!snapshot.statistics.graph_stats.region_classes.is_empty());
    assert!(
        snapshot
            .statistics
            .graph_stats
            .region_classes
            .values()
            .all(|c| c == "path")
    );
}
