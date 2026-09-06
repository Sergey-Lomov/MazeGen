use super::*;
use rand::SeedableRng;
use crate::{Graph, IdGenerator};
use crate::graph::EdgeKind;
use crate::ids::NodeId;
use crate::quality_control::cross_element::CrossElement;
use crate::repair::strategies::test_utils::apply_and_commit;
use crate::repair::strategies::{RemoveTeleportStrategy, OneWayToWallStrategy, RemoveVerticalPassageStrategy, RemoveElevatorStopStrategy, RemoveSplitStrategy};
use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};

fn rng() -> crate::random::MazeRng {
    crate::random::MazeRng::seed_from_u64(0)
}

fn no_params() -> StrategyParams {
    crate::repair::params::build_params(PARAMS, None)
}

fn nested_config(idx: usize, strategy: Box<dyn crate::repair::strategy::ErasedRepairStrategy<SquareTessellation>>) -> NestedStrategyConfig<SquareTessellation> {
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

/// Width-`w` single-floor corridor, teleport portal between x=0 and x=`w-1`, split tile at
/// `split_x` (extra node added there).
fn corridor_teleport_split(w: usize, split_x: i32) -> (Maze<SquareTessellation>, CrossElement, CrossElement) {
    let mut ids = IdGenerator::new();
    let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(w, 1), &mut ids).unwrap();
    let level = mf.single_level_id();
    mf.add_node_at(level, SquarePoint { x: split_x, y: 0 }, &mut ids);
    let mut g = Graph::new();
    for n in mf.all_node_ids() { g.add_node(n); }
    let p = |x: i32| mf.node_at(level, SquarePoint { x, y: 0 }).unwrap();
    for x in 0..w as i32 - 1 {
        g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
    }
    let (n0, nlast) = (p(0), p(w as i32 - 1));
    g.add_edge(n0, nlast, EdgeKind::Teleport);
    g.add_edge(nlast, n0, EdgeKind::Teleport);
    let split_nodes = mf.nodes_at(level, SquarePoint { x: split_x, y: 0 }).to_vec();
    let maze = Maze::new(mf, g);
    (
        maze,
        CrossElement::Teleport(tp_id(n0, nlast)),
        CrossElement::Split(SplitTileNodes::new(split_nodes)),
    )
}

fn issue_with_pair(a: &CrossElement, b: &CrossElement) -> InvalidCrossElementGroupIssue {
    InvalidCrossElementGroupIssue::new_from_check(
        "rule:cross",
        vec![(vec![a.clone(), b.clone()], 1)],
        std::collections::HashMap::new(),
    )
}

fn split_count(m: &Maze<SquareTessellation>, x: i32) -> usize {
    let l = m.field.single_level_id();
    m.field.nodes_at(l, SquarePoint { x, y: 0 }).len()
}

fn teleport_count(m: &Maze<SquareTessellation>) -> usize {
    m.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).count()
}

#[test]
fn apply_succeeds_on_empty_groups_without_touching_nested() {
    let (mut maze, _tp, _sp) = corridor_teleport_split(5, 1);
    let issue = InvalidCrossElementGroupIssue::new_from_check("rule:cross", vec![], std::collections::HashMap::new());
    let strat = CrossElementGroupSelectStrategy { protect_route: false };
    let result = apply_and_commit(&strat, &issue, &mut maze, &mut rng(), &no_params(), &PresetState::empty(), &all_slots());
    assert!(matches!(result, RepairResult::Fixed { .. }));
}

#[test]
fn teleport_and_split_pair_removes_exactly_one_side() {
    let (mut maze, tp, sp) = corridor_teleport_split(6, 1);
    let issue = issue_with_pair(&tp, &sp);
    let strat = CrossElementGroupSelectStrategy { protect_route: false };
    let (tp_before, sp_before) = (teleport_count(&maze), split_count(&maze, 1));
    let result = apply_and_commit(&strat, &issue, &mut maze, &mut rng(), &no_params(), &PresetState::empty(), &all_slots());
    assert!(matches!(result, RepairResult::Fixed { .. }));
    let teleport_gone = teleport_count(&maze) < tp_before;
    let split_gone = split_count(&maze, 1) < sp_before;
    assert!(teleport_gone ^ split_gone, "exactly one side removed (teleport_gone={teleport_gone}, split_gone={split_gone})");
}

#[test]
fn start_finish_pair_fails_and_keeps_the_issue() {
    let mut ids = IdGenerator::new();
    let mf: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
    let level = mf.single_level_id();
    let mut g = Graph::new();
    for n in mf.all_node_ids() { g.add_node(n); }
    let p = |x: i32| mf.node_at(level, SquarePoint { x, y: 0 }).unwrap();
    let (s, f) = (p(0), p(1));
    let mut maze = Maze::new(mf, g);
    maze.meta.start = Some(s);
    maze.meta.finish = Some(f);

    let issue = issue_with_pair(&CrossElement::Start(s), &CrossElement::Finish(f));
    let strat = CrossElementGroupSelectStrategy { protect_route: false };
    let result = apply_and_commit(&strat, &issue, &mut maze, &mut rng(), &no_params(), &PresetState::empty(), &all_slots());
    assert!(matches!(result, RepairResult::Failed), "neither Start nor Finish is removable -> Failed");
}

#[test]
fn teleport_and_finish_pair_removes_only_the_teleport() {
    let (mut maze, tp, _sp) = corridor_teleport_split(6, 4);
    let finish_node = {
        let l = maze.field.single_level_id();
        maze.field.nodes_at(l, SquarePoint { x: 2, y: 0 }).first().copied().unwrap()
    };
    maze.meta.finish = Some(finish_node);
    let issue = issue_with_pair(&tp, &CrossElement::Finish(finish_node));
    let strat = CrossElementGroupSelectStrategy { protect_route: false };
    let tp_before = teleport_count(&maze);
    let result = apply_and_commit(&strat, &issue, &mut maze, &mut rng(), &no_params(), &PresetState::empty(), &all_slots());
    assert!(matches!(result, RepairResult::Fixed { .. }));
    assert!(teleport_count(&maze) < tp_before, "teleport removed");
    assert_eq!(maze.meta.finish, Some(finish_node), "finish untouched");
}

#[test]
fn preset_locked_teleport_is_never_removed_and_the_issue_survives() {
    // Both directions of the teleport portal are preset edges (their exact `EdgeId`s are in
    // `preset_edge_ids`). Without the strategy-level skip the preset teleport would be offered as
    // a candidate; the pair's only other member is a preset-locked split, so there is no
    // actionable candidate -> Failed, teleport intact.
    let (mut maze, tp, sp) = corridor_teleport_split(6, 1);
    let (n0, nlast) = match &tp {
        CrossElement::Teleport((a, b)) => (*a, *b),
        _ => unreachable!(),
    };
    let mut preset_state = PresetState::empty();
    for &(from, to) in &[(n0, nlast), (nlast, n0)] {
        let id = maze.graph.edge_between_kind(from, to, &EdgeKind::Teleport).unwrap();
        preset_state.preset_edge_ids.insert(id);
    }
    // Lock the split tile's nodes too, so the split side is not an escape hatch.
    let split_nodes: Vec<NodeId> = {
        let l = maze.field.single_level_id();
        maze.field.nodes_at(l, SquarePoint { x: 1, y: 0 }).to_vec()
    };
    for w in split_nodes.windows(2) {
        preset_state.preset_edges.insert((w[0], w[1]));
        preset_state.preset_edges.insert((w[1], w[0]));
        preset_state.locked_out.insert(w[0]);
        preset_state.locked_out.insert(w[1]);
    }

    let issue = issue_with_pair(&tp, &sp);
    let strat = CrossElementGroupSelectStrategy { protect_route: false };
    let tp_before = teleport_count(&maze);
    let result = apply_and_commit(&strat, &issue, &mut maze, &mut rng(), &no_params(), &preset_state, &all_slots());
    assert!(matches!(result, RepairResult::Failed), "no removable candidate -> Failed");
    assert_eq!(teleport_count(&maze), tp_before, "preset teleport must survive");
}

#[test]
fn shared_element_across_two_groups_resolves_both_in_one_call() {
    // The same Teleport is the offending member of two independent pairs (with Split and with
    // Finish). Only the teleport slot is provided, so Split is not an actionable candidate --
    // fixing the shared teleport once must retire the budget of both groups in the same `apply()`
    // call (Finish is never removable either), reporting `Fixed` from this single nested fix.
    let (mut maze, tp, sp) = corridor_teleport_split(6, 1);
    let finish_node = {
        let l = maze.field.single_level_id();
        maze.field.nodes_at(l, SquarePoint { x: 3, y: 0 }).first().copied().unwrap()
    };
    maze.meta.finish = Some(finish_node);
    let finish = CrossElement::Finish(finish_node);
    let issue = InvalidCrossElementGroupIssue::new_from_check(
        "rule:cross",
        vec![(vec![tp.clone(), sp.clone()], 1), (vec![tp.clone(), finish.clone()], 1)],
        std::collections::HashMap::new(),
    );
    let strat = CrossElementGroupSelectStrategy { protect_route: false };
    let teleport_only = vec![nested_config(0, Box::new(RemoveTeleportStrategy))];
    let (tp_before, sp_before) = (teleport_count(&maze), split_count(&maze, 1));
    let result = apply_and_commit(&strat, &issue, &mut maze, &mut rng(), &no_params(), &PresetState::empty(), &teleport_only);
    assert!(matches!(result, RepairResult::Fixed { .. }));
    assert!(teleport_count(&maze) < tp_before, "the shared teleport must be removed");
    assert_eq!(split_count(&maze, 1), sp_before, "split untouched -- it had no slot, only the shared teleport was fixed");
    assert_eq!(maze.meta.finish, Some(finish_node), "finish untouched");
}

/// Single-floor corridor width `w`, split tile at x=`split_x`, plus a 3-floor elevator whose
/// bottom stop is x=`elev_x` on the ground floor. Returns the elevator's ground stop node and the
/// split `CrossElement`.
fn corridor_elevator_split(
    w: usize,
    elev_x: i32,
    split_x: i32,
) -> (Maze<SquareTessellation>, NodeId, CrossElement) {
    use crate::space::Field;
    let mut ids = IdGenerator::new();
    let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
    let g0 = mf.add_level(Field::<SquareTessellation>::new(square_rect(w, 1), &mut ids).unwrap());
    let g1 = mf.add_level(Field::<SquareTessellation>::new(square_rect(w, 1), &mut ids).unwrap());
    let g2 = mf.add_level(Field::<SquareTessellation>::new(square_rect(w, 1), &mut ids).unwrap());
    mf.add_node_at(g0, SquarePoint { x: split_x, y: 0 }, &mut ids);
    let mut g = Graph::new();
    for n in mf.all_node_ids() { g.add_node(n); }
    let ground = mf.node_at(g0, SquarePoint { x: elev_x, y: 0 }).unwrap();
    let stops = [
        ground,
        mf.node_at(g1, SquarePoint { x: elev_x, y: 0 }).unwrap(),
        mf.node_at(g2, SquarePoint { x: elev_x, y: 0 }).unwrap(),
    ];
    for i in 0..stops.len() {
        for j in (i + 1)..stops.len() {
            g.add_edge(stops[i], stops[j], EdgeKind::Elevator);
            g.add_edge(stops[j], stops[i], EdgeKind::Elevator);
        }
    }
    let split_nodes = mf.nodes_at(g0, SquarePoint { x: split_x, y: 0 }).to_vec();
    let maze = Maze::new(mf, g);
    (maze, ground, CrossElement::Split(SplitTileNodes::new(split_nodes)))
}

fn elevator_stop_count(m: &Maze<SquareTessellation>) -> usize {
    let mut nodes: Vec<NodeId> = m.graph.edges()
        .filter(|e| e.kind == EdgeKind::Elevator)
        .flat_map(|e| [e.from, e.to])
        .collect();
    nodes.sort_unstable();
    nodes.dedup();
    nodes.len()
}

#[test]
fn elevator_stop_and_split_pair_removes_only_the_one_stop() {
    // The problem element is a single elevator stop, not the whole elevator: fixing it removes that
    // one stop and leaves the other two connected.
    let (mut maze, ground_stop, sp) = corridor_elevator_split(4, 1, 2);
    let issue = issue_with_pair(&CrossElement::ElevatorStop(ground_stop), &sp);
    let strat = CrossElementGroupSelectStrategy { protect_route: false };
    let elevator_stop_only = vec![nested_config(3, Box::new(RemoveElevatorStopStrategy))];
    let (stops_before, sp_before) = (elevator_stop_count(&maze), split_count(&maze, 2));
    assert_eq!(stops_before, 3);
    let result = apply_and_commit(&strat, &issue, &mut maze, &mut rng(), &no_params(), &PresetState::empty(), &elevator_stop_only);
    assert!(matches!(result, RepairResult::Fixed { .. }));
    assert_eq!(elevator_stop_count(&maze), 2, "exactly the one flagged stop is gone, the elevator survives");
    assert_eq!(split_count(&maze, 2), sp_before, "split untouched");
}

/// Width-`w` corridor whose only start->finish path runs x=0 ->(teleport portal)-> x=`w-1`, so the
/// teleport lies on the route. A one-way x=1->x=2 hangs off x=0's neighbour (not on the route). A
/// split tile sits at `split_x`. Returns the teleport, one-way and split `CrossElement`s.
fn routed_teleport_one_way_split(
    w: usize,
    split_x: i32,
) -> (Maze<SquareTessellation>, CrossElement, CrossElement, CrossElement) {
    let mut ids = IdGenerator::new();
    let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(w, 1), &mut ids).unwrap();
    let level = mf.single_level_id();
    mf.add_node_at(level, SquarePoint { x: split_x, y: 0 }, &mut ids);
    let mut g = Graph::new();
    for n in mf.all_node_ids() { g.add_node(n); }
    let p = |x: i32| mf.node_at(level, SquarePoint { x, y: 0 }).unwrap();
    // Plain two-way passages between every adjacent pair EXCEPT x=1->x=2, which is forward-only
    // (a one-way). That one-way is not on the start->finish route (the route takes the teleport).
    for x in 0..w as i32 - 1 {
        g.add_edge(p(x), p(x + 1), EdgeKind::Basic);
        if x != 1 {
            g.add_edge(p(x + 1), p(x), EdgeKind::Basic);
        }
    }
    let (n0, nlast) = (p(0), p(w as i32 - 1));
    g.add_edge(n0, nlast, EdgeKind::Teleport);
    g.add_edge(nlast, n0, EdgeKind::Teleport);
    // The x=1->x=2 forward-only Basic edge is the one-way.
    let ow_edge = g.edge_between_kind(p(1), p(2), &EdgeKind::Basic).unwrap();
    let split_nodes = mf.nodes_at(level, SquarePoint { x: split_x, y: 0 }).to_vec();
    let mut maze = Maze::new(mf, g);
    maze.meta.start = Some(n0);
    maze.meta.finish = Some(nlast);
    (
        maze,
        CrossElement::Teleport(tp_id(n0, nlast)),
        CrossElement::OneWay(ow_edge),
        CrossElement::Split(SplitTileNodes::new(split_nodes)),
    )
}

#[test]
fn protect_route_blocks_the_route_critical_teleport_and_fixes_the_pair_through_its_free_side() {
    // The teleport is on the only start->finish route; with protect_route the strategy must not
    // offer it as a candidate. The pair's other member is a free split -> the pair is resolved by
    // collapsing the split, the teleport stays intact.
    let (mut maze, tp, _ow, sp) = routed_teleport_one_way_split(6, 1);
    let issue = issue_with_pair(&tp, &sp);
    let strat = CrossElementGroupSelectStrategy { protect_route: true };
    let (tp_before, sp_before) = (teleport_count(&maze), split_count(&maze, 1));
    let result = apply_and_commit(&strat, &issue, &mut maze, &mut rng(), &no_params(), &PresetState::empty(), &all_slots());
    assert!(matches!(result, RepairResult::Fixed { .. }));
    assert_eq!(teleport_count(&maze), tp_before, "route-critical teleport must survive protect_route");
    assert!(split_count(&maze, 1) < sp_before, "the pair is fixed through the free split side");
}

#[test]
fn protect_route_off_lets_the_route_critical_teleport_be_removed() {
    // Same maze, protect_route disabled: the teleport is now a valid candidate. Only the teleport
    // slot is offered, so the fix must go through the teleport even though it is on the route.
    let (mut maze, tp, _ow, sp) = routed_teleport_one_way_split(6, 1);
    let issue = issue_with_pair(&tp, &sp);
    let strat = CrossElementGroupSelectStrategy { protect_route: false };
    let teleport_only = vec![nested_config(0, Box::new(RemoveTeleportStrategy))];
    let tp_before = teleport_count(&maze);
    let result = apply_and_commit(&strat, &issue, &mut maze, &mut rng(), &no_params(), &PresetState::empty(), &teleport_only);
    assert!(matches!(result, RepairResult::Fixed { .. }));
    assert!(teleport_count(&maze) < tp_before, "without protect_route the route-critical teleport is removable");
}

#[test]
fn one_way_and_split_pair_is_fixed_through_the_one_way_slot() {
    // Exercises the OneWay arm of make_nested_issue / slot_for: a one-way next to a split tile,
    // only the one-way slot offered -> OneWayToWallStrategy walls the one-way edge.
    let (mut maze, _tp, ow, sp) = routed_teleport_one_way_split(6, 2);
    let issue = issue_with_pair(&ow, &sp);
    let strat = CrossElementGroupSelectStrategy { protect_route: false };
    let one_way_only = vec![nested_config(1, Box::new(OneWayToWallStrategy))];
    let ow_edge = match &ow { CrossElement::OneWay(id) => *id, _ => unreachable!() };
    assert!(maze.graph.edge(ow_edge).is_some(), "one-way edge present before repair");
    let result = apply_and_commit(&strat, &issue, &mut maze, &mut rng(), &no_params(), &PresetState::empty(), &one_way_only);
    assert!(matches!(result, RepairResult::Fixed { .. }));
    assert!(maze.graph.edge(ow_edge).is_none(), "the one-way edge is walled off");
}

#[test]
fn missing_slot_for_a_type_makes_that_candidate_unfixable() {
    // Only the split slot is provided; the teleport candidate has no slot -> the pair is
    // resolved through its split side.
    let (mut maze, tp, sp) = corridor_teleport_split(6, 1);
    let issue = issue_with_pair(&tp, &sp);
    let strat = CrossElementGroupSelectStrategy { protect_route: false };
    let split_only = vec![nested_config(4, Box::new(RemoveSplitStrategy))];
    let sp_before = split_count(&maze, 1);
    let tp_before = teleport_count(&maze);
    let result = apply_and_commit(&strat, &issue, &mut maze, &mut rng(), &no_params(), &PresetState::empty(), &split_only);
    assert!(matches!(result, RepairResult::Fixed { .. }));
    assert!(split_count(&maze, 1) < sp_before, "split side collapsed since the teleport had no slot");
    assert_eq!(teleport_count(&maze), tp_before, "teleport untouched");
}
