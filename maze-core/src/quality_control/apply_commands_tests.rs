use rand::SeedableRng;
use crate::random::MazeRng;
use crate::space::{SquareTessellation, MultiLevelField, square_rect};
use crate::graph::{Graph, EdgeKind};
use crate::generation::PresetState;
use crate::repair::MutationCommand;
use crate::repair::command::{SplitNodeEdge, SplitNodeEdgeDirection};
use crate::event_log::{EventLog, DebugEvent};
use crate::quality_control::event::QcEvent;
use super::*;

fn maze_n(n: usize) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
    let mut ids = crate::IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(n, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    (Maze::new(field, g), nodes)
}

#[test]
fn add_directed_edge_applies_and_counts() {
    let (mut maze, nodes) = maze_n(2);
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::AddDirectedEdge { from: nodes[0], to: nodes[1] }], None, None);
    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
    assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_some());
}

#[test]
fn add_bidirectional_edge_applies_both_directions() {
    let (mut maze, nodes) = maze_n(2);
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::AddBidirectionalEdge { a: nodes[0], b: nodes[1] }], None, None);
    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
    assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_some());
    assert!(maze.graph.edge_between(nodes[1], nodes[0]).is_some());
}

#[test]
fn add_directed_teleport_applies() {
    let (mut maze, nodes) = maze_n(2);
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::AddDirectedTeleport { from: nodes[0], to: nodes[1] }], None, None);
    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
    let edge = maze.graph.edge_between(nodes[0], nodes[1]).and_then(|id| maze.graph.edge(id));
    assert_eq!(edge.map(|e| e.kind.clone()), Some(EdgeKind::Teleport));
}

#[test]
fn add_bidirectional_teleport_applies_both_directions() {
    let (mut maze, nodes) = maze_n(2);
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::AddBidirectionalTeleport { a: nodes[0], b: nodes[1] }], None, None);
    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
    assert!(maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).count() == 2);
}

#[test]
fn remove_edge_by_id_applies() {
    let (mut maze, nodes) = maze_n(2);
    let id = maze.graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::RemoveEdge { id }], None, None);
    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
    assert!(maze.graph.edge(id).is_none());
}

#[test]
fn remove_edge_between_applies() {
    let (mut maze, nodes) = maze_n(2);
    maze.graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::RemoveEdgeBetween { from: nodes[0], to: nodes[1] }], None, None);
    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
    assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_none());
}

#[test]
fn remove_teleport_with_reverse_removes_both_directions() {
    let (mut maze, nodes) = maze_n(2);
    let fwd = maze.graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let bwd = maze.graph.build_initial_edge(nodes[1], nodes[0], EdgeKind::Teleport);
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::RemoveTeleportWithReverse { id: fwd }], None, None);
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
    ], None, None);
    assert_eq!(outcome, ApplyOutcome { proposed: 2, applied: 2 });
    assert_eq!(maze.meta.start, Some(nodes[0]));
    assert_eq!(maze.meta.finish, Some(nodes[1]));

    // Idempotent: a second SetStart with a different node must not overwrite an already-set one.
    let outcome2 = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::SetStart(nodes[1])], None, None);
    assert_eq!(outcome2, ApplyOutcome { proposed: 1, applied: 1 }, "SetStart always reports applied, even when it's a no-op due to idempotency");
    assert_eq!(maze.meta.start, Some(nodes[0]), "already-set start must not be overwritten");
}

#[test]
fn preset_protected_edge_removal_is_dropped_silently() {
    let (mut maze, nodes) = maze_n(2);
    maze.graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((nodes[0], nodes[1]));

    let outcome = apply_commands(&mut maze, &preset_state, vec![MutationCommand::RemoveEdgeBetween { from: nodes[0], to: nodes[1] }], None, None);
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
    let outcome = apply_commands(&mut maze, &PresetState::empty(), commands, None, None);
    assert_eq!(outcome, ApplyOutcome { proposed: 3, applied: 2 }, "exactly the stale middle command must be dropped");
    assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_none());
    assert!(maze.graph.edge_between(nodes[1], nodes[2]).is_none());
}

/// Direct unit coverage for `qc_event_for_command`'s full match, not just the 2 command kinds
/// (`SetStart`/`SetFinish`/`AddBidirectionalEdge`) the real repair scenarios in
/// `quality_control_event_log_test.rs` happen to exercise through a real `EventLog` — every
/// integration test there passes `event_log: None` here, so this is the only place all 9
/// `MutationCommand` variants are proven to emit their correct mutating `QcEvent` mirror.
#[test]
fn event_log_emits_the_correct_mutating_variant_for_every_command_kind() {
    // Disjoint node pairs for every add/remove command, so none of them can collide with (and
    // get revalidation-dropped by) another command in the same batch -- this test's only concern
    // is that each command kind maps to its correct QcEvent variant, not revalidation itself
    // (see `stale_command_in_a_batch_is_dropped_without_blocking_the_rest` for that).
    let (mut maze, nodes) = maze_n(11);
    let teleport_fwd = maze.graph.build_initial_edge(nodes[7], nodes[8], EdgeKind::Teleport);
    maze.graph.build_initial_edge(nodes[8], nodes[7], EdgeKind::Teleport); // reverse leg for RemoveTeleportWithReverse
    let removable_id = maze.graph.build_initial_edge(nodes[5], nodes[6], EdgeKind::Basic);
    maze.graph.build_initial_edge(nodes[3], nodes[4], EdgeKind::Basic); // for RemoveEdgeBetween
    let bidir_fwd = maze.graph.build_initial_edge(nodes[9], nodes[10], EdgeKind::Basic);
    maze.graph.build_initial_edge(nodes[10], nodes[9], EdgeKind::Basic); // reverse leg for RemoveEdgeWithReverse

    let commands = vec![
        MutationCommand::AddDirectedEdge { from: nodes[0], to: nodes[1] },
        MutationCommand::AddBidirectionalEdge { a: nodes[1], b: nodes[2] },
        MutationCommand::AddDirectedTeleport { from: nodes[2], to: nodes[0] },
        MutationCommand::AddBidirectionalTeleport { a: nodes[0], b: nodes[3] },
        MutationCommand::RemoveEdge { id: removable_id },
        MutationCommand::RemoveEdgeBetween { from: nodes[3], to: nodes[4] },
        MutationCommand::RemoveEdgeWithReverse { id: bidir_fwd },
        MutationCommand::RemoveTeleportWithReverse { id: teleport_fwd },
        MutationCommand::SetStart(nodes[0]),
        MutationCommand::SetFinish(nodes[8]),
    ];

    let mut log = EventLog::new();
    let mut scope = log.enter("test scope");
    let outcome = apply_commands(&mut maze, &PresetState::empty(), commands, Some(&mut scope), None);
    drop(scope);
    let tape = log.finish();

    assert_eq!(outcome, ApplyOutcome { proposed: 10, applied: 10 }, "every command in this batch must apply cleanly");

    let events: Vec<&QcEvent> = tape.iter().collect();
    assert_eq!(events.len(), 10, "one QcEvent per command, in order");
    assert!(matches!(events[0], QcEvent::DirectedEdgeAdded { .. }));
    assert!(matches!(events[1], QcEvent::BidirectionalEdgeAdded { .. }));
    assert!(matches!(events[2], QcEvent::DirectedTeleportAdded { .. }));
    assert!(matches!(events[3], QcEvent::BidirectionalTeleportAdded { .. }));
    assert!(matches!(events[4], QcEvent::EdgeRemoved { .. }));
    assert!(matches!(events[5], QcEvent::EdgeRemovedBetween { .. }));
    // Both directions genuinely existed for both `WithReverse` commands, so `reverse_removed`
    // (GitHub issue #185's follow-up fix) must be computed `true` here, not just assumed from the
    // command's shape — this is the one place proving `rule.rs`'s `removed.len() > 1` computation
    // actually reaches the emitted `QcEvent`, not just that the enum variant can be constructed.
    assert!(matches!(events[6], QcEvent::EdgeRemovedWithReverse { reverse_removed: true, .. }),
        "both directions of the bidirectional passage existed, reverse_removed must be true: {:?}", events[6]);
    assert!(matches!(events[7], QcEvent::TeleportRemovedWithReverse { reverse_removed: true, .. }),
        "both directions of the two-way teleport existed, reverse_removed must be true: {:?}", events[7]);
    assert!(matches!(events[8], QcEvent::StartSet(_)));
    assert!(matches!(events[9], QcEvent::FinishSet(_)));
    for event in &events {
        assert!(event.is_mutating(), "every emitted event here must be the mutating mirror, not *Declined: {event:?}");
    }
}

/// Gap in `event_log_emits_the_correct_mutating_variant_for_every_command_kind`: that test only
/// proves `reverse_removed` is `true` when the reverse genuinely exists. This proves the opposite
/// side of `rule.rs`'s `removed.len() > 1` computation — a `RemoveEdgeWithReverse` command cutting
/// a one-way edge (no reverse direction ever built) must compute `reverse_removed: false`, not
/// `true`. Without this, an off-by-one or a "simplify to `!removed.is_empty()`" regression in
/// `rule.rs` would pass every other test in this file, since none of them exercise the one-way case
/// through a real `apply_commands` call (GitHub issue #185's follow-up fix).
#[test]
fn remove_edge_with_reverse_computes_reverse_removed_false_when_only_one_direction_exists() {
    let (mut maze, nodes) = maze_n(2);
    let one_way = maze.graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
    // Deliberately no (nodes[1], nodes[0]) edge -- this command must still succeed (primary
    // direction alone is enough), but must report reverse_removed: false.

    let mut log = EventLog::new();
    let mut scope = log.enter("test scope");
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::RemoveEdgeWithReverse { id: one_way }], Some(&mut scope), None);
    drop(scope);
    let tape = log.finish();

    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
    assert!(maze.graph.edge(one_way).is_none());

    let events: Vec<&QcEvent> = tape.iter().collect();
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], QcEvent::EdgeRemovedWithReverse { reverse_removed: false, .. }),
        "only the primary direction ever existed, reverse_removed must be false: {:?}", events[0]);
}

/// Mirrors `stale_command_in_a_batch_is_dropped_without_blocking_the_rest` for `RemoveEdgeWithReverse`
/// specifically (GitHub issue #185's follow-up fix): a batch built against one immutable snapshot
/// proposes cutting both directions of a bidirectional passage via two separate commands (as if two
/// different strategies each independently decided to cut one direction) -- by the time the second
/// command applies, the first has already removed the reverse leg it was also going to remove, so
/// the second command's own primary `id` no longer resolves. This is the same "stale id" case
/// `stale_edge_id_that_never_existed_emits_no_event_instead_of_fabricating_from_to` covers for
/// `RemoveEdge`: revalidation must still reject it (not applied) and, since `edge_endpoints`
/// resolution fails first, no event is emitted for the second command at all -- never a fabricated
/// `EdgeRemoveWithReverseDeclined { reverse_removed: false, .. }` with made-up endpoints.
#[test]
fn remove_edge_with_reverse_second_command_targeting_an_already_removed_reverse_leg_emits_no_event() {
    let (mut maze, nodes) = maze_n(2);
    let fwd = maze.graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let bwd = maze.graph.build_initial_edge(nodes[1], nodes[0], EdgeKind::Basic);

    let commands = vec![
        MutationCommand::RemoveEdgeWithReverse { id: fwd }, // removes both fwd and bwd
        MutationCommand::RemoveEdgeWithReverse { id: bwd }, // bwd already gone -- primary itself now stale
    ];
    let mut log = EventLog::new();
    let mut scope = log.enter("test scope");
    let outcome = apply_commands(&mut maze, &PresetState::empty(), commands, Some(&mut scope), None);
    drop(scope);
    let tape = log.finish();

    assert_eq!(outcome, ApplyOutcome { proposed: 2, applied: 1 }, "second command's primary id is already gone by commit time");
    assert!(maze.graph.edge(fwd).is_none());
    assert!(maze.graph.edge(bwd).is_none());

    let events: Vec<&QcEvent> = tape.iter().collect();
    assert_eq!(events.len(), 1, "second command's stale id fails endpoint resolution before revalidation -- no event, not a fabricated Declined");
    assert!(matches!(events[0], QcEvent::EdgeRemovedWithReverse { reverse_removed: true, .. }),
        "first command removes both directions: {:?}", events[0]);
}

/// Proves the `EdgeRemoveWithReverseDeclined` narration branch actually fires with correct
/// endpoints when revalidation rejects a `RemoveEdgeWithReverse` command for a reason *other* than
/// a stale id -- here, preset protection on the primary direction -- mirroring
/// `event_log_emits_declined_when_revalidation_rejects_a_command`'s coverage for `RemoveEdgeBetween`.
/// `reverse_removed` must be `false`: `try_remove_edge_with_reverse` never removed anything at all
/// (GitHub issue #185's follow-up fix).
#[test]
fn remove_edge_with_reverse_emits_declined_when_preset_protection_rejects_it() {
    let (mut maze, nodes) = maze_n(2);
    let mut preset_state = PresetState::empty();
    let id = maze.graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
    preset_state.preset_edges.insert((nodes[0], nodes[1]));

    let mut log = EventLog::new();
    let mut scope = log.enter("test scope");
    let outcome = apply_commands(&mut maze, &preset_state, vec![MutationCommand::RemoveEdgeWithReverse { id }], Some(&mut scope), None);
    drop(scope);
    let tape = log.finish();

    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 0 });
    assert!(maze.graph.edge(id).is_some(), "preset-protected edge must survive");

    let events: Vec<&QcEvent> = tape.iter().collect();
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], QcEvent::EdgeRemoveWithReverseDeclined { reverse_removed: false, .. }),
        "rejected command must emit its *Declined mirror with reverse_removed: false: {:?}", events[0]);
    assert!(!events[0].is_mutating(), "*Declined must never be classified as mutating");
}

/// Proves the `*Declined` narration branch actually fires when `apply_commands`' own
/// revalidation rejects a command — every real repair scenario in
/// `quality_control_event_log_test.rs` always succeeds (its strategy never proposes a stale
/// command), so this branch was previously only exercised at the `QcEvent`-encoding level
/// (`event.rs`'s own tests), never proven to actually fire from a real revalidation rejection.
#[test]
fn event_log_emits_declined_when_revalidation_rejects_a_command() {
    let (mut maze, nodes) = maze_n(2);
    let mut preset_state = PresetState::empty();
    maze.graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
    preset_state.preset_edges.insert((nodes[0], nodes[1]));

    let mut log = EventLog::new();
    let mut scope = log.enter("test scope");
    let outcome = apply_commands(
        &mut maze,
        &preset_state,
        vec![MutationCommand::RemoveEdgeBetween { from: nodes[0], to: nodes[1] }],
        Some(&mut scope),
        None,
    );
    drop(scope);
    let tape = log.finish();

    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 0 });
    let events: Vec<&QcEvent> = tape.iter().collect();
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], QcEvent::EdgeRemoveBetweenDeclined { .. }), "rejected command must emit its *Declined mirror: {:?}", events[0]);
    assert!(!events[0].is_mutating(), "*Declined must never be classified as mutating");
}

/// GitHub issue #171 review finding: `qc_event_for_command` used to fabricate a `(0, 0)`
/// self-loop via `unwrap_or_default()` whenever `RemoveEdge`/`RemoveTeleportWithReverse`'s
/// `EdgeId` couldn't be resolved to `(from, to)` — indistinguishable from a genuine edge since
/// node id 0 is real and valid. A stale `EdgeId` (never built into the graph) both fails
/// resolution (`edge_endpoints` is `None`) and fails revalidation (`try_remove_edge_by_id`
/// returns `false` for an unknown id), so `apply_commands` must emit no event at all for it —
/// not a fabricated `EdgeRemoveDeclined { from: 0, to: 0 }`.
#[test]
fn stale_edge_id_that_never_existed_emits_no_event_instead_of_fabricating_from_to() {
    let (mut maze, _) = maze_n(2);
    let never_built_id = 9999;

    let mut log = EventLog::new();
    let mut scope = log.enter("test scope");
    let outcome = apply_commands(
        &mut maze,
        &PresetState::empty(),
        vec![MutationCommand::RemoveEdge { id: never_built_id }],
        Some(&mut scope),
        None,
    );
    drop(scope);
    let tape = log.finish();

    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 0 }, "revalidation must still reject the stale id");
    assert_eq!(tape.iter().count(), 0, "no event may be emitted when EdgeId resolution fails -- never a fabricated (0, 0) pair");
}

/// Same fabrication-bug coverage as `stale_edge_id_that_never_existed_emits_no_event_instead_of_fabricating_from_to`,
/// but for the strategy-scope `*Proposed` narration path (`qc_event_proposed_for_command`),
/// called before `apply_commands`' own revalidation ever runs.
#[test]
fn proposed_narration_for_a_stale_edge_id_emits_nothing() {
    let (maze, _) = maze_n(2);
    let never_built_id = 9999;
    let cmd = MutationCommand::RemoveEdge { id: never_built_id };
    assert!(qc_event_proposed_for_command(&cmd, &maze).is_none(), "unresolved EdgeId must yield no proposed event, never a fabricated (0, 0) pair");
}

#[test]
fn empty_batch_is_a_no_op() {
    let (mut maze, _) = maze_n(2);
    let edges_before = maze.graph.edges().count();
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![], None, None);
    assert_eq!(outcome, ApplyOutcome { proposed: 0, applied: 0 });
    assert_eq!(maze.graph.edges().count(), edges_before);
}

/// Full integration path (GitHub issue #118): `strategy.apply` -> `(RepairResult,
/// Vec<MutationCommand>)` -> `Rule::check_and_repair_typed` -> `apply_commands` -> real `Maze`.
/// Proves the `Rule`-level commit point actually wires the pieces together correctly, not just
/// that `apply_commands` in isolation behaves — a strategy returning several commands must see
/// all of them land on the real maze after one `check_and_repair_typed` call, and the returned
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
fn check_and_repair_typed_applies_every_returned_command_to_the_real_maze() {
    use crate::quality_control::checks::MissingEndpointsCheck;

    let (mut maze, _nodes) = maze_n(2);
    let rule: Rule<SquareTessellation, crate::quality_control::MissingEndpointsIssue> = Rule::new(
        "r".to_string(),
        vec![("missing_endpoints".to_string(), Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() }))],
        Some(Box::new(MultiCommandStrategy)), HashMap::new(), vec![],
    );
    let mut rng = MazeRng::seed_from_u64(0);
    let mut per_check = HashMap::new();
    let mut per_strategy = HashMap::new();
    let outcome = rule.check_and_repair_typed(&mut maze, &mut rng, &PresetState::empty(), &mut per_check, &mut per_strategy, &|| 0.0, None, None);

    let crate::quality_control::RuleIterationOutcome::Repaired(repair_result, apply_outcome) = outcome else {
        panic!("rule found an issue and has a strategy, must return Repaired")
    };
    assert!(matches!(repair_result, RepairResult::Fixed { score: None }));
    assert_eq!(apply_outcome, ApplyOutcome { proposed: 3, applied: 3 });
    assert!(maze.meta.start.is_some());
    assert!(maze.meta.finish.is_some());
    assert!(maze.graph.edges().count() >= 2, "the bidirectional edge command must have landed too");
}

/// `replace_point_nodes_feasible`'s own doc comment (`node_ops.rs`) calls out `ReplacePointNodes`
/// as the one command in the crate that can invalidate another command's edge `target` mid-batch:
/// unlike every other command, it can remove a node an *earlier* command in the same batch already
/// referenced as a `target`. This is exactly the scenario the user reported this session (two
/// adjacent split tiles added in one repair call, where the second candidate's new node wires to
/// the first candidate's about-to-be-replaced node): the second `ReplacePointNodes` in a batch
/// targets a node the first one just replaced. It must be declined outright (all-or-nothing — no
/// partial replacement), not silently wire to the now-vanished id.
#[test]
fn replace_point_nodes_declines_when_a_prior_batch_command_already_replaced_its_target() {
    let (mut maze, nodes) = maze_n(3);
    // nodes[1] is the shared target: the first command replaces it, the second command's new node
    // tries to wire to it as if it were still live.
    let commands = vec![
        MutationCommand::ReplacePointNodes { at: nodes[1], nodes: vec![vec![]] },
        MutationCommand::ReplacePointNodes {
            at: nodes[0],
            nodes: vec![vec![SplitNodeEdge { target: nodes[1], direction: SplitNodeEdgeDirection::Passage, kind: EdgeKind::Basic }]],
        },
    ];

    let mut log = EventLog::new();
    let mut scope = log.enter("test scope");
    let outcome = apply_commands(&mut maze, &PresetState::empty(), commands, Some(&mut scope), None);
    drop(scope);
    let tape = log.finish();

    assert_eq!(outcome, ApplyOutcome { proposed: 2, applied: 1 }, "the second command must be declined, the first must still land");
    let point0 = maze.field.point_of(nodes[0]).expect("declined command must leave nodes[0]'s point untouched");
    assert_eq!(maze.field.nodes_at(maze.field.single_level_id(), point0), &[nodes[0]], "nodes[0]'s point must be untouched by the declined second command");
    assert!(maze.field.point_of(nodes[1]).is_none(), "nodes[1] must have been replaced by the first command");

    let events: Vec<&QcEvent> = tape.iter().collect();
    assert_eq!(events.len(), 2);
    assert!(matches!(events[0], QcEvent::PointNodesReplaced { .. }), "first command applied: {:?}", events[0]);
    assert!(matches!(events[1], QcEvent::PointNodesReplaceDeclined { .. }), "second command declined, its target already gone: {:?}", events[1]);
}

/// GitHub issue #271: `RemoveNode`/`ReplacePointNodes` must note the *old* node's coordinates into
/// the debug ledger before removing it — a node removed/replaced by QC/repair may never have been
/// minted mid-run at all (e.g. one of `Field`'s own original base nodes), so this is the only place
/// its coordinates ever get recorded before they're gone from both `Field` and the final snapshot.
#[test]
fn remove_node_notes_the_removed_nodes_coordinates_into_the_debug_ledger() {
    use crate::space::SquarePoint;
    use crate::generation::DebugGenerationState;

    let (mut maze, _nodes) = maze_n(1);
    let point = SquarePoint { x: 0, y: 0 };
    let _slot0 = maze.field.node_at(maze.field.single_level_id(), point).unwrap();
    let extra = maze.field.add_node_at(maze.field.single_level_id(), point, &mut maze.ids);
    maze.graph.add_node(extra);

    let mut debug_state: DebugGenerationState<SquareTessellation> = DebugGenerationState::new();
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::RemoveNode { node: extra }], None, Some(&mut debug_state));
    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
    assert!(maze.field.point_of(extra).is_none(), "the node must actually be gone from the field");

    let noted: Vec<_> = debug_state.all_node_points().collect();
    assert_eq!(noted, vec![(extra, point)], "the removed node's own coordinates, not slot0's");
}

/// Mirrors `remove_node_notes_the_removed_nodes_coordinates_into_the_debug_ledger` for
/// `ReplacePointNodes` — every *old* node at the replaced point (slot-0 included) must be noted,
/// not just the newly minted replacement (`try_replace_point_nodes` already notes that half).
#[test]
fn replace_point_nodes_notes_every_old_nodes_coordinates_into_the_debug_ledger() {
    use crate::space::SquarePoint;
    use crate::generation::DebugGenerationState;

    let (mut maze, nodes) = maze_n(1);
    let point = SquarePoint { x: 0, y: 0 };
    let slot0 = nodes[0];

    let mut debug_state: DebugGenerationState<SquareTessellation> = DebugGenerationState::new();
    let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::ReplacePointNodes { at: slot0, nodes: vec![vec![]] }], None, Some(&mut debug_state));
    assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
    assert!(maze.field.point_of(slot0).is_none(), "the old slot0 id must be gone from the field");

    let noted: std::collections::HashMap<_, _> = debug_state.all_node_points().collect();
    assert_eq!(noted.get(&slot0), Some(&point), "the replaced old node's own coordinates must be noted");
    let new_slot0 = maze.field.nodes_at(maze.field.single_level_id(), point)[0];
    assert_eq!(noted.get(&new_slot0), Some(&point), "the newly minted replacement is also noted (try_replace_point_nodes's own note())");
    assert_eq!(noted.len(), 2, "exactly the old node plus the one new node, no extras");
}
