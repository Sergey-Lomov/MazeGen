use rand::SeedableRng;
use crate::random::MazeRng;
use crate::space::{SquareTessellation, Field, square_rect};
use crate::graph::{Graph, EdgeKind};
use crate::generation::PresetState;
use crate::repair::MutationCommand;
use super::*;

fn maze_n(n: usize) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
    let mut ids = crate::IdGenerator::new();
    let field = Field::new(square_rect(n, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    (Maze::new(field, g), nodes)
}

#[test]
fn add_directed_edge_applies_and_counts() {
    let (mut maze, nodes) = maze_n(2);
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::AddDirectedEdge { from: nodes[0], to: nodes[1] }], None);
    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
    assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_some());
}

#[test]
fn add_bidirectional_edge_applies_both_directions() {
    let (mut maze, nodes) = maze_n(2);
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::AddBidirectionalEdge { a: nodes[0], b: nodes[1] }], None);
    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
    assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_some());
    assert!(maze.graph.edge_between(nodes[1], nodes[0]).is_some());
}

#[test]
fn add_directed_teleport_applies() {
    let (mut maze, nodes) = maze_n(2);
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::AddDirectedTeleport { from: nodes[0], to: nodes[1] }], None);
    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
    let edge = maze.graph.edge_between(nodes[0], nodes[1]).and_then(|id| maze.graph.edge(id));
    assert_eq!(edge.map(|e| e.kind.clone()), Some(EdgeKind::Teleport));
}

#[test]
fn add_bidirectional_teleport_applies_both_directions() {
    let (mut maze, nodes) = maze_n(2);
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::AddBidirectionalTeleport { a: nodes[0], b: nodes[1] }], None);
    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
    assert!(maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).count() == 2);
}

#[test]
fn remove_edge_by_id_applies() {
    let (mut maze, nodes) = maze_n(2);
    let id = maze.graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::RemoveEdge { id }], None);
    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
    assert!(maze.graph.edge(id).is_none());
}

#[test]
fn remove_edge_between_applies() {
    let (mut maze, nodes) = maze_n(2);
    maze.graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::RemoveEdgeBetween { from: nodes[0], to: nodes[1] }], None);
    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
    assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_none());
}

#[test]
fn remove_teleport_with_reverse_removes_both_directions() {
    let (mut maze, nodes) = maze_n(2);
    let fwd = maze.graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let bwd = maze.graph.build_initial_edge(nodes[1], nodes[0], EdgeKind::Teleport);
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::RemoveTeleportWithReverse { id: fwd }], None);
    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
    assert!(maze.graph.edge(fwd).is_none());
    assert!(maze.graph.edge(bwd).is_none());
}

#[test]
fn set_start_and_finish_apply_and_are_idempotent() {
    let (mut maze, nodes) = maze_n(2);
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![
        MutationCommand::SetStart(nodes[0]),
        MutationCommand::SetFinish(nodes[1]),
    ], None);
    assert_eq!(outcome, ApplyOutcome { proposed: 2, applied: 2 });
    assert_eq!(maze.meta.start, Some(nodes[0]));
    assert_eq!(maze.meta.finish, Some(nodes[1]));

    // Idempotent: a second SetStart with a different node must not overwrite an already-set one.
    let outcome2 = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::SetStart(nodes[1])], None);
    assert_eq!(outcome2, ApplyOutcome { proposed: 1, applied: 1 }, "SetStart always reports applied, even when it's a no-op due to idempotency");
    assert_eq!(maze.meta.start, Some(nodes[0]), "already-set start must not be overwritten");
}

#[test]
fn preset_protected_edge_removal_is_dropped_silently() {
    let (mut maze, nodes) = maze_n(2);
    maze.graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((nodes[0], nodes[1]));

    let outcome = apply_commands(&mut maze, &preset_state, vec![MutationCommand::RemoveEdgeBetween { from: nodes[0], to: nodes[1] }], None);
    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 0 }, "preset-protected removal must be silently dropped, not panic or error");
    assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_some(), "protected edge must survive");
}

/// Core revalidate-and-drop scenario (GitHub issue #118): a batch built against one snapshot
/// contains a command that no longer holds by commit time (here, removing an edge that a
/// preceding command in the same batch already removed) — it must be dropped silently, and
/// the rest of the batch must still apply. This is the mechanism that structurally replaces
/// #98/#99's one-issue-per-item split: a batched issue's stale sub-command is simply skipped
/// instead of corrupting state or requiring the whole batch be rejected.
#[test]
fn stale_command_in_a_batch_is_dropped_without_blocking_the_rest() {
    let (mut maze, nodes) = maze_n(3);
    let id_01 = maze.graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
    maze.graph.build_initial_edge(nodes[1], nodes[2], EdgeKind::Basic);

    // Batch: remove (0,1) by id, then remove the same pair again by node pair (stale —
    // simulates a nested/weighted sub-strategy proposing an overlapping mutation against the
    // same immutable snapshot), then remove (1,2) — must still land despite the stale entry
    // in between.
    let commands = vec![
        MutationCommand::RemoveEdge { id: id_01 },
        MutationCommand::RemoveEdgeBetween { from: nodes[0], to: nodes[1] }, // stale: already gone
        MutationCommand::RemoveEdgeBetween { from: nodes[1], to: nodes[2] },
    ];
    let outcome = apply_commands(&mut maze, &PresetState::empty(), commands, None);
    assert_eq!(outcome, ApplyOutcome { proposed: 3, applied: 2 }, "exactly the stale middle command must be dropped");
    assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_none());
    assert!(maze.graph.edge_between(nodes[1], nodes[2]).is_none());
}

#[test]
fn empty_batch_is_a_no_op() {
    let (mut maze, _) = maze_n(2);
    let edges_before = maze.graph.edges().count();
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![], None);
    assert_eq!(outcome, ApplyOutcome { proposed: 0, applied: 0 });
    assert_eq!(maze.graph.edges().count(), edges_before);
}

/// Full integration path (GitHub issue #118): `strategy.apply` -> `(RepairResult,
/// Vec<MutationCommand>)` -> `Rule::dispatch_repair_typed` -> `apply_commands` -> real `Maze`.
/// Proves the `Rule`-level commit point actually wires the pieces together correctly, not just
/// that `apply_commands` in isolation behaves — a strategy returning several commands must see
/// all of them land on the real maze after one `dispatch_repair_typed` call, and the returned
/// `ApplyOutcome` must reflect that.
struct MultiCommandStrategy;
impl RepairStrategy<SquareTessellation, crate::quality_control::MissingEndpointsIssue> for MultiCommandStrategy {
    fn strategy_id(&self) -> &'static str { "test_multi_command" }
    fn apply(
        &self,
        _issue: &crate::quality_control::MissingEndpointsIssue,
        maze: &Maze<SquareTessellation>,
        _rng: &mut dyn RngCore,
        _params: &StrategyParams,
        _preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<SquareTessellation>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
        (
            RepairResult::Fixed { score: None },
            vec![
                MutationCommand::SetStart(nodes[0]),
                MutationCommand::SetFinish(nodes[1]),
                MutationCommand::AddBidirectionalEdge { a: nodes[0], b: nodes[1] },
            ],
        )
    }
}
#[test]
fn dispatch_repair_typed_applies_every_returned_command_to_the_real_maze() {
    let (mut maze, _nodes) = maze_n(2);
    let rule: Rule<SquareTessellation, crate::quality_control::MissingEndpointsIssue> = Rule::new(
        "r".to_string(), vec![], Some(Box::new(MultiCommandStrategy)), HashMap::new(), vec![],
    );
    let issue = crate::quality_control::MissingEndpointsIssue::default();
    let mut rng = MazeRng::seed_from_u64(0);
    let mut timing = HashMap::new();
    let result = rule.dispatch_repair_typed(&issue, &mut maze, &mut rng, &PresetState::empty(), &mut timing, &|| 0.0, None);

    let Some((repair_result, outcome)) = result else { panic!("rule has a strategy, must return Some") };
    assert!(matches!(repair_result, RepairResult::Fixed { score: None }));
    assert_eq!(outcome, ApplyOutcome { proposed: 3, applied: 3 });
    assert!(maze.meta.start.is_some());
    assert!(maze.meta.finish.is_some());
    assert!(maze.graph.edges().count() >= 2, "the bidirectional edge command must have landed too");
}
