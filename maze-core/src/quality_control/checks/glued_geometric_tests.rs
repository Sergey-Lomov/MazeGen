//! Geometric QC checks on a cylinder (GitHub issue #838): the distance is measured along the
//! surface, so two elements on opposite sides of the seam count as close.

use super::*;
use crate::graph::EdgeKind;
use crate::quality_control::IndeterminateReason;
use crate::quality_control::check::Check;
use crate::space::{
    Fold, FoldEnd, FoldGroup, FoldGroupId, FoldId, MultiLevelField, SquarePoint,
    SquareTessellation, TessellationFingerprint, Topology, square_rect,
};
use crate::{Graph, IdGenerator, Maze};
use rand::SeedableRng;
use std::sync::Arc;

const WIDTH: i32 = 6;

fn p(x: i32) -> SquarePoint {
    SquarePoint { x, y: 0 }
}

/// A `WIDTH` x 1 strip; with `glued` its last cell's east face meets the first cell's west face.
fn strip(glued: bool) -> (MultiLevelField<SquareTessellation>, Graph) {
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(WIDTH as usize, 1), &mut ids)
            .unwrap();
    let level = field.single_level_id();
    if glued {
        let fingerprint = TessellationFingerprint::new("square{}");
        let fold = Fold {
            a: FoldEnd {
                cell: p(WIDTH - 1),
                face_idx: 0,
            },
            b: FoldEnd {
                cell: p(0),
                face_idx: 2,
            },
            twist: false,
            group: FoldGroupId(0),
        };
        let group = FoldGroup {
            id: FoldGroupId(0),
            folds: vec![FoldId(0)],
        };
        field
            .set_topology(
                level,
                Topology::new(fingerprint.clone(), vec![fold], vec![group]),
                &fingerprint,
            )
            .unwrap();
    }
    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }
    (field, graph)
}

fn rng() -> crate::random::MazeRng {
    crate::random::MazeRng::seed_from_u64(0)
}

fn teleport_flagged(glued: bool, length: f64) -> bool {
    let (field, mut graph) = strip(glued);
    let level = field.single_level_id();
    let at = |x: i32| field.node_at(level, p(x)).unwrap();
    graph.add_edge(at(0), at(WIDTH - 1), EdgeKind::Teleport);
    let maze = Maze::new(field, graph);
    let check = TeleportGeometricLengthCheck {
        instance_id: "teleport_geometric_length".to_string(),
        comparison: crate::comparison::Comparison::Lt,
        length,
        protect_route: false,
        floor_mode: crate::quality_control::GeometricFloorMode::Ignore,
        approximate_topology: false,
    };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    !issues.is_empty()
}

#[test]
fn teleport_length_is_measured_across_the_seam() {
    // Cell centers 0 and 5 are 5.0 apart in the plane but 1.0 apart on the cylinder.
    assert!(!teleport_flagged(false, 2.0));
    assert!(teleport_flagged(true, 2.0));
    assert!(!teleport_flagged(true, 0.5));
}

fn split_pair_flagged(glued: bool, distance: f64) -> bool {
    let (mut field, graph) = strip(glued);
    let level = field.single_level_id();
    let mut ids = IdGenerator::resume_after(&field);
    field.add_node_at(level, p(0), &mut ids);
    field.add_node_at(level, p(WIDTH - 1), &mut ids);
    let mut graph = graph;
    for node in field.all_node_ids() {
        graph.add_node(node);
    }
    let maze = Maze::new(field, graph);
    let check = SplitGroupGeometricProximityCheck {
        instance_id: "split_group_geometric_proximity".to_string(),
        distance,
        floor_mode: crate::quality_control::GeometricFloorMode::Ignore,
        approximate_topology: false,
    };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    !issues.is_empty()
}

#[test]
fn split_tiles_are_close_across_the_seam() {
    assert!(!split_pair_flagged(false, 2.0));
    assert!(split_pair_flagged(true, 2.0));
}

fn one_way_pair_flagged(glued: bool, distance: f64) -> bool {
    let (field, mut graph) = strip(glued);
    let level = field.single_level_id();
    let at = |x: i32| field.node_at(level, p(x)).unwrap();
    // Positions 0.5 and 4.5: 4.0 apart in the plane, 2.0 on the cylinder of circumference 6.
    graph.add_edge(at(0), at(1), EdgeKind::Basic);
    graph.add_edge(at(4), at(5), EdgeKind::Basic);
    let maze = Maze::new(field, graph);
    let check = OneWayGroupGeometricProximityCheck {
        instance_id: "one_way_group_geometric_proximity".to_string(),
        distance,
        protect_route: false,
        floor_mode: crate::quality_control::GeometricFloorMode::Ignore,
        approximate_topology: false,
    };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    !issues.is_empty()
}

#[test]
fn one_way_edges_are_close_across_the_seam() {
    assert!(!one_way_pair_flagged(false, 3.0));
    assert!(one_way_pair_flagged(true, 3.0));
    assert!(!one_way_pair_flagged(true, 1.5));
}

/// A 4 x 2 Möbius strip (east edge glued to the west edge with a twist): the distance between the
/// cells at (0, 0) and (3, 1) has a bracket [1.0, sqrt 2] that is not exact.
fn mobius() -> (MultiLevelField<SquareTessellation>, Graph) {
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(4, 2), &mut ids).unwrap();
    let level = field.single_level_id();
    let fingerprint = TessellationFingerprint::new("square{}");
    let folds = [(0, 1), (1, 0)].map(|(y, partner)| Fold {
        a: FoldEnd {
            cell: SquarePoint { x: 3, y },
            face_idx: 0,
        },
        b: FoldEnd {
            cell: SquarePoint { x: 0, y: partner },
            face_idx: 2,
        },
        twist: true,
        group: FoldGroupId(0),
    });
    let group = FoldGroup {
        id: FoldGroupId(0),
        folds: vec![FoldId(0), FoldId(1)],
    };
    field
        .set_topology(
            level,
            Topology::new(fingerprint.clone(), folds.to_vec(), vec![group]),
            &fingerprint,
        )
        .unwrap();
    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }
    (field, graph)
}

#[test]
fn an_undecidable_teleport_is_recorded_and_neither_flagged_nor_cleared() {
    let (field, mut graph) = mobius();
    let level = field.single_level_id();
    let at = |x: i32, y: i32| field.node_at(level, SquarePoint { x, y }).unwrap();
    let (from, to) = (at(0, 0), at(3, 0));
    graph.add_edge(from, to, EdgeKind::Teleport);
    let maze = Maze::new(field, graph);
    let check = |length: f64| TeleportGeometricLengthCheck {
        instance_id: "teleport_geometric_length".to_string(),
        comparison: crate::comparison::Comparison::Lt,
        length,
        protect_route: false,
        floor_mode: crate::quality_control::GeometricFloorMode::Ignore,
        approximate_topology: false,
    };
    let run = |length: f64| {
        let mut issues = Vec::new();
        check(length).repair_check(&maze, &mut issues, &mut rng(), ());
        (issues.len(), maze.distance_diagnostics.take())
    };
    let (flagged, pairs) = run(0.9);
    assert_eq!((flagged, pairs.len()), (0, 0));
    let (flagged, pairs) = run(1.2);
    assert_eq!(flagged, 0);
    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0].reason, IndeterminateReason::DistanceUnknown);
    assert_eq!((pairs[0].a, pairs[0].b), (from.min(to), from.max(to)));
    let (flagged, pairs) = run(1.5);
    assert_eq!((flagged, pairs.len()), (1, 0));
}
