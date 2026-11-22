use super::*;
use crate::graph::EdgeKind;
use crate::ids::NodeId;
use crate::quality_control::SplitTileNodes;
use crate::quality_control::issue_kinds::CrossElementCellViolation;
use crate::repair::strategies::test_utils::apply_and_commit;
use crate::repair::strategies::{
    OneWayToWallStrategy, RemoveElevatorStopStrategy, RemoveSplitStrategy, RemoveTeleportStrategy,
    RemoveVerticalPassageStrategy,
};
use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use crate::{Graph, IdGenerator};
use rand::SeedableRng;
use std::collections::HashMap;
use std::sync::Arc;

fn rng() -> crate::random::MazeRng {
    crate::random::MazeRng::seed_from_u64(0)
}

fn nested_config(
    idx: usize,
    strategy: Box<dyn crate::repair::strategy::ErasedRepairStrategy<SquareTessellation>>,
) -> NestedStrategyConfig<SquareTessellation> {
    NestedStrategyConfig {
        slot: &NESTED_SLOTS[idx],
        strategy,
        param_overrides: HashMap::new(),
        nested: vec![],
    }
}

fn all_slots() -> Vec<NestedStrategyConfig<SquareTessellation>> {
    vec![
        nested_config(0, Box::new(RemoveTeleportStrategy)),
        nested_config(1, Box::new(OneWayToWallStrategy)),
        nested_config(2, Box::new(RemoveVerticalPassageStrategy)),
        nested_config(3, Box::new(RemoveElevatorStopStrategy)),
        nested_config(4, Box::new(RemoveSplitStrategy)),
    ]
}

fn tp_id(a: NodeId, b: NodeId) -> (NodeId, NodeId) {
    if a <= b { (a, b) } else { (b, a) }
}

fn violation(element: &CrossElement, node: NodeId) -> CrossElementCellViolation {
    CrossElementCellViolation {
        element: element.clone(),
        node,
        cell_type: "square",
    }
}

fn issue_of(violations: Vec<CrossElementCellViolation>) -> InvalidCrossElementIssue {
    InvalidCrossElementIssue::new_from_check("rule:cell_type", violations)
}

/// Width-6 corridor with a teleport between x=0 and x=5 and a split tile at x=2.
fn corridor() -> (Maze<SquareTessellation>, CrossElement, CrossElement, NodeId) {
    corridor_with_gap(None)
}

/// [`corridor`] without the passage x=`gap`..x=`gap+1`, start at x=0 and finish at x=5: with a
/// gap the teleport is the only start->finish route.
fn corridor_with_gap(
    gap: Option<i32>,
) -> (Maze<SquareTessellation>, CrossElement, CrossElement, NodeId) {
    let mut ids = IdGenerator::new();
    let mut mf: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(6, 1), &mut ids).unwrap();
    let level = mf.single_level_id();
    mf.add_node_at(level, SquarePoint { x: 2, y: 0 }, &mut ids);
    let mut g = Graph::new();
    for n in mf.all_node_ids() {
        g.add_node(n);
    }
    let p = |x: i32| mf.node_at(level, SquarePoint { x, y: 0 }).unwrap();
    for x in (0..5).filter(|&x| Some(x) != gap) {
        g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
    }
    let (n0, n5) = (p(0), p(5));
    g.add_edge(n0, n5, EdgeKind::Teleport);
    g.add_edge(n5, n0, EdgeKind::Teleport);
    let split_nodes = mf.nodes_at(level, SquarePoint { x: 2, y: 0 }).to_vec();
    let mut maze = Maze::new(mf, g);
    maze.meta.start = Some(n0);
    maze.meta.finish = Some(n5);
    (
        maze,
        CrossElement::Teleport(tp_id(n0, n5)),
        CrossElement::Split(SplitTileNodes::new(split_nodes)),
        n0,
    )
}

fn strategy(protect_route: bool) -> CrossElementRemoveStrategy {
    CrossElementRemoveStrategy { protect_route }
}

fn run(
    maze: &mut Maze<SquareTessellation>,
    issue: &InvalidCrossElementIssue,
    protect_route: bool,
    preset: &PresetState,
) -> RepairResult {
    apply_and_commit(
        &strategy(protect_route),
        issue,
        maze,
        &mut rng(),
        &StrategyParams::new(),
        preset,
        &all_slots(),
    )
}

fn teleport_count(m: &Maze<SquareTessellation>) -> usize {
    m.graph
        .edges()
        .filter(|e| e.kind == EdgeKind::Teleport)
        .count()
}

fn split_count(m: &Maze<SquareTessellation>) -> usize {
    let l = m.field.single_level_id();
    m.field.nodes_at(l, SquarePoint { x: 2, y: 0 }).len()
}

#[test]
fn empty_issue_is_fixed_without_touching_nested() {
    let (mut maze, ..) = corridor();
    let result = run(&mut maze, &issue_of(vec![]), false, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { .. }));
}

#[test]
fn removes_every_flagged_element_of_every_kind() {
    let (mut maze, tp, sp, n0) = corridor();
    let issue = issue_of(vec![violation(&tp, n0), violation(&sp, 0)]);
    let result = run(&mut maze, &issue, false, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { .. }));
    assert_eq!(teleport_count(&maze), 0);
    assert_eq!(split_count(&maze), 1);
}

#[test]
fn element_with_several_violating_ends_is_removed_once() {
    let (mut maze, tp, _sp, n0) = corridor();
    let CrossElement::Teleport((a, b)) = tp else {
        unreachable!()
    };
    let issue = issue_of(vec![violation(&tp, a), violation(&tp, b)]);
    let _ = n0;
    let result = run(&mut maze, &issue, false, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { .. }));
    assert_eq!(teleport_count(&maze), 0);
    assert_eq!(split_count(&maze), 2, "unflagged split stays");
}

#[test]
fn start_and_finish_are_never_removed_and_fail_the_call() {
    let (mut maze, _tp, _sp, n0) = corridor();
    let issue = issue_of(vec![
        violation(&CrossElement::Start(n0), n0),
        violation(&CrossElement::Finish(n0), n0),
    ]);
    let result = run(&mut maze, &issue, false, &PresetState::empty());
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(teleport_count(&maze), 2);
}

#[test]
fn unremovable_element_does_not_block_the_removable_one() {
    let (mut maze, tp, _sp, n0) = corridor();
    let issue = issue_of(vec![
        violation(&CrossElement::Start(n0), n0),
        violation(&tp, n0),
    ]);
    let result = run(&mut maze, &issue, false, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { .. }));
    assert_eq!(teleport_count(&maze), 0);
}

#[test]
fn missing_nested_slot_leaves_element_and_fails() {
    let (mut maze, tp, _sp, n0) = corridor();
    let issue = issue_of(vec![violation(&tp, n0)]);
    let result = apply_and_commit(
        &strategy(false),
        &issue,
        &mut maze,
        &mut rng(),
        &StrategyParams::new(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(teleport_count(&maze), 2);
}

#[test]
fn preset_locked_teleport_is_skipped_and_fails_the_call() {
    let (mut maze, tp, _sp, n0) = corridor();
    let CrossElement::Teleport((a, b)) = tp else {
        unreachable!()
    };
    let mut preset = PresetState::empty();
    for &(from, to) in &[(a, b), (b, a)] {
        let id = maze
            .graph
            .edge_between_kind(from, to, &EdgeKind::Teleport)
            .unwrap();
        preset.preset_edge_ids.insert(id);
    }
    let issue = issue_of(vec![violation(&tp, n0)]);
    let result = run(&mut maze, &issue, false, &preset);
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(teleport_count(&maze), 2);
}

#[test]
fn protect_route_keeps_the_route_critical_teleport_and_off_lets_it_go() {
    let issue_for = |tp: &CrossElement, n0| issue_of(vec![violation(tp, n0)]);

    let (mut maze, tp, _sp, n0) = corridor_with_gap(Some(2));
    let result = run(&mut maze, &issue_for(&tp, n0), true, &PresetState::empty());
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(teleport_count(&maze), 2, "route-critical teleport survives");

    let (mut maze, tp, _sp, n0) = corridor_with_gap(Some(2));
    let result = run(&mut maze, &issue_for(&tp, n0), false, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { .. }));
    assert_eq!(teleport_count(&maze), 0);
}
