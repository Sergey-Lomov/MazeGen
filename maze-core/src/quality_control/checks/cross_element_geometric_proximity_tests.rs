use super::*;
use crate::graph::EdgeKind;
use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use crate::{Graph, IdGenerator};
use rand::SeedableRng;
use std::sync::Arc;

const TEST_ID: &str = "cross_element_geometric_proximity";

fn rng() -> crate::random::MazeRng {
    crate::random::MazeRng::seed_from_u64(0)
}

fn set_of(
    teleport: bool,
    one_way: bool,
    split: bool,
    start: bool,
    finish: bool,
) -> CrossElementSet {
    CrossElementSet {
        teleport,
        one_way,
        vertical_passage: false,
        elevator_stop: false,
        split,
        start,
        finish,
    }
}

fn check(distance: f64, set: CrossElementSet) -> CrossElementGeometricProximityCheck {
    CrossElementGeometricProximityCheck {
        instance_id: TEST_ID.to_string(),
        distance,
        set,
        floor_mode: GeometricFloorMode::AsCoordinate,
        approximate_topology: false,
        protect_route: false,
    }
}

fn p_of(maze: &Maze<SquareTessellation>, x: i32) -> crate::ids::NodeId {
    let level = maze.field.single_level_id();
    maze.field.node_at(level, SquarePoint { x, y: 0 }).unwrap()
}

/// Single floor, width `w`. Teleport portal between x=0 and x=`tp_far`, a split tile at
/// `split_x` (a second node added at that point).
fn maze_with_teleport_and_split(w: usize, tp_far: i32, split_x: i32) -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let mut mf: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(w, 1), &mut ids).unwrap();
    let level = mf.single_level_id();
    mf.add_node_at(level, SquarePoint { x: split_x, y: 0 }, &mut ids);
    let mut g = Graph::new();
    for n in mf.all_node_ids() {
        g.add_node(n);
    }
    let p = |x: i32| mf.node_at(level, SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(p(0), p(tp_far), EdgeKind::Teleport);
    g.add_edge(p(tp_far), p(0), EdgeKind::Teleport);
    Maze::new(mf, g)
}

#[test]
fn fires_when_a_teleport_end_and_a_split_are_closer_than_threshold() {
    // teleport ends at x=0 and x=8; split at x=1 -> one end is 1 tile from the split.
    let maze = maze_with_teleport_and_split(9, 8, 1);
    let mut issues = Vec::new();
    check(3.0, set_of(true, false, true, false, false)).repair_check(
        &maze,
        &mut issues,
        &mut rng(),
        (),
    );
    assert_eq!(issues.len(), 1);
    assert_eq!(
        issues[0].groups().len(),
        1,
        "one logical pair despite the teleport having two ends"
    );
    assert_eq!(issues[0].groups()[0].1, 1);
}

#[test]
fn silent_when_farther_than_threshold() {
    let maze = maze_with_teleport_and_split(20, 8, 15);
    let mut issues = Vec::new();
    check(3.0, set_of(true, false, true, false, false)).repair_check(
        &maze,
        &mut issues,
        &mut rng(),
        (),
    );
    assert!(issues.is_empty());
}

#[test]
fn silent_when_no_type_is_enabled() {
    let maze = maze_with_teleport_and_split(9, 8, 1);
    let mut issues = Vec::new();
    check(1000.0, set_of(false, false, false, false, false)).repair_check(
        &maze,
        &mut issues,
        &mut rng(),
        (),
    );
    assert!(issues.is_empty());
}

#[test]
fn a_single_enabled_type_runs_a_same_type_scan() {
    // Two separate teleport portals with near ends; only `teleport` enabled. A single type is
    // a valid same-type scan (this subsumes the old per-type `*_group_geometric_proximity`).
    let mut ids = IdGenerator::new();
    let mf: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(8, 1), &mut ids).unwrap();
    let level = mf.single_level_id();
    let mut g = Graph::new();
    for n in mf.all_node_ids() {
        g.add_node(n);
    }
    let p = |x: i32| mf.node_at(level, SquarePoint { x, y: 0 }).unwrap();
    // Portal A: x=0 <-> x=6. Portal B: x=1 <-> x=7. Near ends x=0 and x=1 are 1.0 apart.
    g.add_edge(p(0), p(6), EdgeKind::Teleport);
    g.add_edge(p(6), p(0), EdgeKind::Teleport);
    g.add_edge(p(1), p(7), EdgeKind::Teleport);
    g.add_edge(p(7), p(1), EdgeKind::Teleport);
    let maze = Maze::new(mf, g);

    let mut issues = Vec::new();
    check(1.5, set_of(true, false, false, false, false)).repair_check(
        &maze,
        &mut issues,
        &mut rng(),
        (),
    );
    assert_eq!(
        issues.len(),
        1,
        "two distinct teleports with near ends -> one same-type pair"
    );
    assert_eq!(issues[0].groups().len(), 1);
}

#[test]
fn disabled_type_is_excluded_from_the_scan() {
    // teleport + split are close, but split is disabled -> only the teleport remains, and its
    // two ends are excluded as same-element -> nothing.
    let maze = maze_with_teleport_and_split(9, 8, 1);
    let mut issues = Vec::new();
    check(1000.0, set_of(true, true, false, false, false)).repair_check(
        &maze,
        &mut issues,
        &mut rng(),
        (),
    );
    assert!(
        issues.is_empty(),
        "no one-ways, split disabled, teleport self-pair excluded"
    );
}

#[test]
fn close_nodes_records_only_the_near_teleport_end() {
    // teleport ends at x=0 and x=8; split at x=1 -> only the x=0 end is within 3 tiles.
    let maze = maze_with_teleport_and_split(9, 8, 1);
    let level = maze.field.single_level_id();
    let near_end = maze
        .field
        .node_at(level, SquarePoint { x: 0, y: 0 })
        .unwrap();
    let far_end = maze
        .field
        .node_at(level, SquarePoint { x: 8, y: 0 })
        .unwrap();

    let mut issues = Vec::new();
    check(3.0, set_of(true, false, true, false, false)).repair_check(
        &maze,
        &mut issues,
        &mut rng(),
        (),
    );
    assert_eq!(issues.len(), 1);

    let key = &issues[0].groups()[0].0;
    let mut canonical = key.clone();
    canonical.sort_unstable();
    canonical.dedup();
    let per_element = &issues[0].close_nodes[&canonical];
    let teleport_el = key
        .iter()
        .find(|e| matches!(e, CrossElement::Teleport(_)))
        .unwrap();
    let close = &per_element[teleport_el];
    assert!(close.contains(&near_end), "the near end must be recorded");
    assert!(
        !close.contains(&far_end),
        "the far end must NOT be recorded"
    );
}

#[test]
fn boundary_distance_equal_to_threshold_does_not_fire() {
    // teleport end at x=0, split at x=3, threshold exactly 3.0 -> strict `<`, no fire.
    let maze = maze_with_teleport_and_split(9, 8, 3);
    let mut issues = Vec::new();
    check(3.0, set_of(true, false, true, false, false)).repair_check(
        &maze,
        &mut issues,
        &mut rng(),
        (),
    );
    assert!(
        issues.is_empty(),
        "distance == threshold must not fire (strict <)"
    );
}

#[test]
fn start_and_finish_pair_is_flagged() {
    let mut ids = IdGenerator::new();
    let mf: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
    let level = mf.single_level_id();
    let mut g = Graph::new();
    for n in mf.all_node_ids() {
        g.add_node(n);
    }
    let s = mf.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
    let f = mf.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
    let mut maze = Maze::new(mf, g);
    maze.meta.start = Some(s);
    maze.meta.finish = Some(f);

    let mut issues = Vec::new();
    check(3.0, set_of(false, false, false, true, true)).repair_check(
        &maze,
        &mut issues,
        &mut rng(),
        (),
    );
    assert_eq!(issues.len(), 1);
    let group = &issues[0].groups()[0].0;
    assert!(group.iter().any(|e| matches!(e, CrossElement::Start(_))));
    assert!(group.iter().any(|e| matches!(e, CrossElement::Finish(_))));
}

#[test]
fn one_way_distance_is_measured_from_its_edge_position_not_its_endpoint_nodes() {
    // One-way edge x=0->x=1 (no reverse edge). Its edge_position (midpoint) is x=0.5. A split
    // at x=3 is 2.0 from the nearer endpoint node (x=1) but 2.5 from the edge midpoint.
    // Threshold 2.2 sits strictly between: endpoint-based measurement would wrongly fire,
    // edge-position measurement must not.
    let mut ids = IdGenerator::new();
    let mut mf: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(4, 1), &mut ids).unwrap();
    let level = mf.single_level_id();
    mf.add_node_at(level, SquarePoint { x: 3, y: 0 }, &mut ids); // split tile
    let mut g = Graph::new();
    for n in mf.all_node_ids() {
        g.add_node(n);
    }
    let p = |x: i32| mf.node_at(level, SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(p(0), p(1), EdgeKind::Basic);
    let maze = Maze::new(mf, g);

    let mut issues = Vec::new();
    check(2.2, set_of(false, true, true, false, false)).repair_check(
        &maze,
        &mut issues,
        &mut rng(),
        (),
    );
    assert!(
        issues.is_empty(),
        "must measure from the edge's own edge_position, not the nearer endpoint node"
    );
}

/// Width-6 corridor. start=x=0, finish=x=5. The only route is x=0 ->(one-way) x=1 -> x=2
/// ->(teleport) x=5, so both the one-way (x=1->x=2) and the teleport (portal x=2<->x=5) sit
/// on it. x=3, x=4 hang off with plain two-way passages (not on the route).
fn route_with_one_way_then_teleport() -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let mf: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(6, 1), &mut ids).unwrap();
    let level = mf.single_level_id();
    let mut g = Graph::new();
    for n in mf.all_node_ids() {
        g.add_node(n);
    }
    let p = |x: i32| mf.node_at(level, SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(p(0), p(1), EdgeKind::Basic); // one-way, forward only
    g.add_edge(p(1), p(2), EdgeKind::Basic);
    g.add_edge(p(2), p(1), EdgeKind::Basic);
    g.add_edge(p(2), p(3), EdgeKind::Basic);
    g.add_edge(p(3), p(2), EdgeKind::Basic);
    g.add_edge(p(3), p(4), EdgeKind::Basic);
    g.add_edge(p(4), p(3), EdgeKind::Basic);
    g.add_edge(p(2), p(5), EdgeKind::Teleport);
    g.add_edge(p(5), p(2), EdgeKind::Teleport);
    let (s, f) = (p(0), p(5));
    let mut maze = Maze::new(mf, g);
    maze.meta.start = Some(s);
    maze.meta.finish = Some(f);
    maze
}

#[test]
fn protect_route_excludes_a_pair_with_both_elements_on_the_route() {
    // one-way x=0->x=1 and teleport portal x=2<->x=5 both lie on the only start->finish route.
    // Their close occurrences (one-way edge midpoint x=0.5, teleport end x=2) are 1.5 apart.
    let maze = route_with_one_way_then_teleport();
    let set = set_of(true, true, false, false, false);

    let mut c = check(5.0, set);
    c.protect_route = true;
    let mut issues = Vec::new();
    c.repair_check(&maze, &mut issues, &mut rng(), ());
    assert!(
        issues.is_empty(),
        "both elements sit on the protected route -> pair excluded"
    );

    let mut c = check(5.0, set);
    c.protect_route = false;
    let mut issues = Vec::new();
    c.repair_check(&maze, &mut issues, &mut rng(), ());
    assert_eq!(issues.len(), 1, "without protection the close pair fires");
}

#[test]
fn protect_route_still_flags_a_pair_with_only_one_element_on_the_route() {
    // One-way x=1->x=2 on the route, plus a split tile at x=2 (never route-protected — owns no
    // edge). protect_route must NOT exclude this pair.
    let mut ids = IdGenerator::new();
    let mut mf: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(5, 1), &mut ids).unwrap();
    let level = mf.single_level_id();
    mf.add_node_at(level, SquarePoint { x: 2, y: 0 }, &mut ids); // split
    let mut g = Graph::new();
    for n in mf.all_node_ids() {
        g.add_node(n);
    }
    let p = |x: i32| mf.node_at(level, SquarePoint { x, y: 0 }).unwrap();
    for x in 0..4 {
        g.add_edge(p(x), p(x + 1), EdgeKind::Basic);
        if x != 1 {
            g.add_edge(p(x + 1), p(x), EdgeKind::Basic);
        }
    }
    let mut maze = Maze::new(mf, g);
    maze.meta.start = Some(p_of(&maze, 0));
    maze.meta.finish = Some(p_of(&maze, 4));

    let mut c = check(5.0, set_of(false, true, true, false, false));
    c.protect_route = true;
    let mut issues = Vec::new();
    c.repair_check(&maze, &mut issues, &mut rng(), ());
    assert_eq!(
        issues.len(),
        1,
        "split is not route-protected -> pair still flagged"
    );
}

/// `n_elevators` 3-floor elevators spaced 1 tile apart along x (x=0, x=1, ...), all spanning
/// the same 3 floors. Matching-floor stops of adjacent elevators are 1 tile apart.
fn elevators(n_elevators: usize) -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let mut mf: MultiLevelField<SquareTessellation> =
        MultiLevelField::new(Arc::default(), std::iter::empty());
    let floors: Vec<_> = (0..3)
        .map(|_| {
            mf.add_level(
                Field::<SquareTessellation>::new(
                    Arc::default(),
                    square_rect(n_elevators.max(1), 1),
                    &mut ids,
                )
                .unwrap(),
            )
        })
        .collect();
    let mut g = Graph::new();
    for n in mf.all_node_ids() {
        g.add_node(n);
    }
    let mut fan = |x: i32| {
        let stops: Vec<crate::ids::NodeId> = floors
            .iter()
            .map(|&l| mf.node_at(l, SquarePoint { x, y: 0 }).unwrap())
            .collect();
        for i in 0..stops.len() {
            for j in (i + 1)..stops.len() {
                g.add_edge(stops[i], stops[j], EdgeKind::Elevator);
                g.add_edge(stops[j], stops[i], EdgeKind::Elevator);
            }
        }
    };
    for x in 0..n_elevators as i32 {
        fan(x);
    }
    Maze::new(mf, g)
}

fn elevator_stop_set() -> CrossElementSet {
    CrossElementSet {
        teleport: false,
        one_way: false,
        vertical_passage: false,
        elevator_stop: true,
        split: true,
        start: false,
        finish: false,
    }
}

#[test]
fn two_stops_of_the_same_elevator_are_never_a_pair() {
    // A single 3-floor elevator: its stops are stacked one floor apart. With AsCoordinate the
    // floor delta counts as distance, so a large threshold would otherwise pair them.
    let maze = elevators(1);
    let mut issues = Vec::new();
    let mut c = check(1000.0, elevator_stop_set());
    c.floor_mode = GeometricFloorMode::AsCoordinate;
    c.repair_check(&maze, &mut issues, &mut rng(), ());
    assert!(
        issues.is_empty(),
        "stops of one elevator are connected by design, never flagged"
    );
}

#[test]
fn close_stops_of_two_different_elevators_are_flagged() {
    let maze = elevators(2);
    let mut issues = Vec::new();
    let mut c = check(1.5, elevator_stop_set());
    c.floor_mode = GeometricFloorMode::SameFloorOnly;
    c.repair_check(&maze, &mut issues, &mut rng(), ());
    assert!(
        !issues.is_empty(),
        "a stop of one elevator 1 tile from a stop of another must fire"
    );
    assert!(
        issues[0]
            .groups()
            .iter()
            .all(|(g, _)| g.iter().all(|e| matches!(e, CrossElement::ElevatorStop(_))))
    );
}

#[test]
fn same_floor_only_ignores_a_cross_floor_pair() {
    let mut ids = IdGenerator::new();
    let mut mf: MultiLevelField<SquareTessellation> =
        MultiLevelField::new(Arc::default(), std::iter::empty());
    let bottom = mf.add_level(
        Field::<SquareTessellation>::new(Arc::default(), square_rect(3, 1), &mut ids).unwrap(),
    );
    let top = mf.add_level(
        Field::<SquareTessellation>::new(Arc::default(), square_rect(3, 1), &mut ids).unwrap(),
    );
    mf.add_node_at(top, SquarePoint { x: 0, y: 0 }, &mut ids); // split tile on top floor
    let mut g = Graph::new();
    for n in mf.all_node_ids() {
        g.add_node(n);
    }
    let b = |x: i32| mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
    // Teleport on the bottom floor, split on the top floor, same x.
    g.add_edge(b(0), b(2), EdgeKind::Teleport);
    g.add_edge(b(2), b(0), EdgeKind::Teleport);
    let maze = Maze::new(mf, g);

    let mut issues = Vec::new();
    let mut c = check(5.0, set_of(true, false, true, false, false));
    c.floor_mode = GeometricFloorMode::SameFloorOnly;
    c.repair_check(&maze, &mut issues, &mut rng(), ());
    assert!(
        issues.is_empty(),
        "SameFloorOnly must never pair occurrences on different floors"
    );
}
