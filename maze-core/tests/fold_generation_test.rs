//! Early integration test for folds (GitHub issue #832): generation succeeds on a cylinder, a
//! torus and a Moebius strip whose topology is built through the core API.

use maze_core::generation::{GenerationConfig, PresetState, generate_maze};
use maze_core::graph::Graph;
use maze_core::ids::IdGenerator;
use maze_core::space::{
    Fold, FoldActivity, FoldEnd, FoldGroup, FoldGroupId, FoldId, MultiLevelField, SquarePoint,
    SquareTessellation, TessellationFingerprint, Topology, square_rect,
};
use std::collections::{HashSet, VecDeque};
use std::sync::Arc;

const E: usize = 0;
const N: usize = 1;
const W: usize = 2;
const S: usize = 3;

type End = FoldEnd<SquarePoint>;

fn fingerprint() -> TessellationFingerprint {
    TessellationFingerprint::new("square{}")
}

fn end(x: i32, y: i32, face_idx: usize) -> End {
    FoldEnd {
        cell: SquarePoint { x, y },
        face_idx,
    }
}

fn topology(folds: Vec<(End, End, bool)>) -> Topology<SquareTessellation> {
    let ids = (0..folds.len()).map(FoldId).collect();
    let folds = folds
        .into_iter()
        .map(|(a, b, twist)| Fold {
            a,
            b,
            twist,
            group: FoldGroupId(0),
        })
        .collect();
    Topology::new(
        fingerprint(),
        folds,
        vec![FoldGroup {
            id: FoldGroupId(0),
            folds: ids,
        }],
    )
}

fn generate_with(topology: Topology<SquareTessellation>, w: i32, h: i32) {
    let mut ids = IdGenerator::new();
    let mut field = MultiLevelField::<SquareTessellation>::single_level(
        Arc::default(),
        square_rect(w as usize, h as usize),
        &mut ids,
    )
    .unwrap();
    let level = field.single_level_id();
    let fold_count = topology.folds().len();
    field.set_topology(level, topology, &fingerprint()).unwrap();
    let activity = field.field_of(level).unwrap().fold_activity();
    assert_eq!(activity.len(), fold_count);
    assert!(activity.iter().all(|a| *a == FoldActivity::Active));

    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }
    let start = field
        .nodes_at(level, SquarePoint { x: 0, y: 0 })
        .first()
        .copied()
        .unwrap();
    generate_maze(
        &mut graph,
        &mut field,
        &mut ids,
        42,
        start,
        GenerationConfig::default(),
        &PresetState::empty(),
    );

    // Every edge follows effective adjacency, and the whole field is reachable.
    for edge in graph.edges() {
        assert!(
            field.neighbors(edge.from).contains(&edge.to),
            "edge {:?} -> {:?} is not an effective adjacency",
            edge.from,
            edge.to
        );
    }
    let mut seen: HashSet<_> = HashSet::from([start]);
    let mut queue = VecDeque::from([start]);
    while let Some(node) = queue.pop_front() {
        for next in graph.outgoing_neighbors(node) {
            if seen.insert(next) {
                queue.push_back(next);
            }
        }
    }
    assert_eq!(seen.len(), field.node_count());
}

fn cylinder_folds(w: i32, h: i32) -> Vec<(End, End, bool)> {
    (0..h)
        .map(|y| (end(w - 1, y, E), end(0, y, W), false))
        .collect()
}

#[test]
fn generation_succeeds_on_cylinder() {
    generate_with(topology(cylinder_folds(6, 5)), 6, 5);
}

#[test]
fn generation_succeeds_on_torus() {
    let (w, h) = (6, 5);
    let mut folds = cylinder_folds(w, h);
    folds.extend((0..w).map(|x| (end(x, h - 1, N), end(x, 0, S), false)));
    generate_with(topology(folds), w, h);
}

#[test]
fn generation_succeeds_on_mobius_strip() {
    let (w, h) = (6, 5);
    let folds = (0..h)
        .map(|y| (end(w - 1, y, E), end(0, h - 1 - y, W), true))
        .collect();
    generate_with(topology(folds), w, h);
}
