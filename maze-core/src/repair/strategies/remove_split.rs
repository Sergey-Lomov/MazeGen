use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::graph::EdgeKind;
use crate::quality_control::InvalidSplitTileIssue;
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;

pub const PARAM_REDISTRIBUTE: &str = "redistribute";

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_REDISTRIBUTE,
        label: "Redistribute connections to the original node",
        kind: StrategyParamKind::Bool { default: true },
    },
];

/// Handles `INVALID_SPLIT_TILE` — see GitHub issue #248, epic #246. Collapses each flagged extra
/// split node (never a point's slot-0 original — the producing check never flags slot-0, see
/// `SplitDistanceFromWaypointCheck`) back into a single node by removing it entirely
/// (`MutationCommand::RemoveNode`).
///
/// `redistribute` (default `true`): what happens to the removed node's own connections.
/// - `false`: the node's edges simply disappear along with it (`RemoveNode` already clears every
///   incident edge, both directions) — the point may end up with fewer connections overall.
/// - `true`: before removing the node, this strategy first proposes an equivalent edge/teleport
///   from/to the point's slot-0 node for every one of the removed node's incident edges (same
///   `EdgeKind`, same direction) — so the point's total connectivity is preserved, just
///   consolidated onto slot-0. An edge that would connect slot-0 to itself (the sibling edge
///   between the removed node and slot-0, if any) is skipped — a self-loop is never proposed. Each
///   redistribution command is independently revalidated by `apply_commands` same as any other
///   (e.g. dropped if it duplicates an edge slot-0 already has), so this is "best-effort
///   preservation," not a guarantee.
pub struct RemoveSplitStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidSplitTileIssue> for RemoveSplitStrategy {
    fn strategy_id(&self) -> &'static str { "remove_split" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &InvalidSplitTileIssue,
        maze: &Maze<T>,
        _rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let redistribute = matches!(params.get(PARAM_REDISTRIBUTE), Some(StrategyParamValue::Bool(true)));

        let mut commands = Vec::new();
        let mut any_removable = false;
        for &node in &issue.invalid {
            // `remove_node_feasible` is the exact predicate `try_remove_node` uses at apply time
            // (preset locks/edges, never slot-0) — checked here up front so this strategy's own
            // `Fixed`/`Failed` verdict agrees with whether `RemoveNode` will actually be applied,
            // rather than always reporting `Fixed` and letting a preset-protected node re-flag
            // forever (GitHub issue #230's same "declined command must not silently count as
            // fixed" rationale).
            if !crate::generation::remove_node_feasible(&maze.field, preset_state, node) {
                continue;
            }
            let point = maze.field.point_of(node).expect("remove_node_feasible confirmed this node exists");
            let slot0 = maze.field.nodes_at(point).first().copied().expect("remove_node_feasible confirmed this point has an original node");
            any_removable = true;

            if redistribute {
                for edge in maze.graph.edges().filter(|e| e.from == node || e.to == node) {
                    let (from, to) = if edge.from == node { (slot0, edge.to) } else { (edge.from, slot0) };
                    if from == to { continue; } // the sibling edge to/from slot-0 itself
                    commands.push(match edge.kind {
                        EdgeKind::Basic => MutationCommand::AddDirectedEdge { from, to },
                        EdgeKind::Teleport => MutationCommand::AddDirectedTeleport { from, to },
                    });
                }
            }
            commands.push(MutationCommand::RemoveNode { node });
        }

        // Every flagged node failed remove_node_feasible (already removed by an earlier command in
        // this same batch, a stale issue, or -- the common real-world case -- preset-protected)
        // -- nothing could be fixed, same "Failed if nothing could be fixed" rationale as
        // OneWayToWallStrategy (GitHub issue #230). Without this, a preset-protected split node
        // would report Fixed every iteration despite RemoveNode always being declined by
        // apply_commands, spinning the repair fixpoint loop until the iteration/time budget is
        // exhausted instead of failing fast.
        let result = if issue.invalid.is_empty() || any_removable {
            RepairResult::Fixed { score: None }
        } else {
            RepairResult::Failed
        };
        (result, commands)
    }
}

crate::impl_erased_repair_strategy!(RemoveSplitStrategy, InvalidSplitTileIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;

    fn no_params() -> StrategyParams {
        build_params(<RemoveSplitStrategy as RepairStrategy<SquareTessellation, InvalidSplitTileIssue>>::params(&RemoveSplitStrategy), None)
    }

    fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
        let mut map = std::collections::HashMap::new();
        for &(k, v) in overrides {
            map.insert(k.to_string(), v.to_string());
        }
        build_params(<RemoveSplitStrategy as RepairStrategy<SquareTessellation, InvalidSplitTileIssue>>::params(&RemoveSplitStrategy), Some(&map))
    }

    fn maze_with_split_node() -> (Maze<SquareTessellation>, crate::ids::NodeId, crate::ids::NodeId) {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let p = SquarePoint { x: 1, y: 0 };
        let slot0 = field.node_at(p).unwrap();
        let extra = field.add_node_at(p, &mut ids);
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let left = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let right = field.node_at(SquarePoint { x: 2, y: 0 }).unwrap();
        g.add_bidirectional_edge(slot0, left, EdgeKind::Basic);
        g.add_bidirectional_edge(extra, right, EdgeKind::Basic);
        let maze = Maze::new(field, g);
        (maze, slot0, extra)
    }

    #[test]
    fn apply_without_redistribute_removes_the_node_and_its_edges() {
        let (mut maze, _slot0, extra) = maze_with_split_node();
        let issue = InvalidSplitTileIssue::new_from_check("test", vec![extra]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveSplitStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.field.point_of(extra).is_none(), "extra node must be gone from the field");
        assert!(!maze.graph.edges().any(|e| e.from == extra || e.to == extra), "extra node's edges must be gone");
    }

    #[test]
    fn apply_never_removes_slot0() {
        let (mut maze, slot0, _extra) = maze_with_split_node();
        // Even if a (buggy) caller flagged slot0 directly, this strategy's RemoveNode command
        // must be declined by try_remove_node's own feasibility check.
        let issue = InvalidSplitTileIssue::new_from_check("test", vec![slot0]);
        let mut rng = MazeRng::seed_from_u64(1);
        apply_and_commit(&RemoveSplitStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);

        assert!(maze.field.point_of(slot0).is_some(), "slot-0 must never be removed");
    }

    #[test]
    fn apply_with_redistribute_reconnects_the_removed_nodes_neighbor_to_slot0() {
        let (mut maze, slot0, extra) = maze_with_split_node();
        let right = maze.field.node_at(SquarePoint { x: 2, y: 0 }).unwrap();
        let issue = InvalidSplitTileIssue::new_from_check("test", vec![extra]);
        let params = params_with(&[(PARAM_REDISTRIBUTE, "true")]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveSplitStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.field.point_of(extra).is_none());
        assert!(maze.graph.edge_between(slot0, right).is_some(), "slot0 must inherit the removed node's connection to its neighbor");
        assert!(maze.graph.edge_between(right, slot0).is_some(), "both directions of the redistributed bidirectional edge must land");
    }

    #[test]
    fn apply_with_redistribute_skips_the_sibling_edge_to_slot0_itself() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let p = SquarePoint { x: 1, y: 0 };
        let slot0 = field.node_at(p).unwrap();
        let extra = field.add_node_at(p, &mut ids);
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        // The only edge on `extra` is its sibling edge to slot0 -- redistributing it would be a
        // self-loop on slot0, which must never be proposed.
        g.add_bidirectional_edge(slot0, extra, EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidSplitTileIssue::new_from_check("test", vec![extra]);
        let params = params_with(&[(PARAM_REDISTRIBUTE, "true")]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveSplitStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.field.point_of(extra).is_none());
        assert!(maze.graph.edge_between(slot0, slot0).is_none(), "must never create a self-loop on slot0");
    }

    #[test]
    fn apply_with_redistribute_preserves_teleport_kind() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let p = SquarePoint { x: 1, y: 0 };
        let slot0 = field.node_at(p).unwrap();
        let extra = field.add_node_at(p, &mut ids);
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let far = field.node_at(SquarePoint { x: 2, y: 0 }).unwrap();
        g.add_edge(extra, far, EdgeKind::Teleport);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidSplitTileIssue::new_from_check("test", vec![extra]);
        let params = params_with(&[(PARAM_REDISTRIBUTE, "true")]);
        let mut rng = MazeRng::seed_from_u64(1);
        apply_and_commit(&RemoveSplitStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);

        assert!(maze.graph.edges().any(|e| e.from == slot0 && e.to == far && e.kind == EdgeKind::Teleport),
            "redistributed edge must keep the Teleport kind, not silently downgrade to Basic");
    }

    #[test]
    fn apply_reports_failed_when_the_only_flagged_node_is_preset_protected() {
        // Regression for GitHub issue #248: a preset-protected split node must not be reported
        // Fixed when RemoveNode will always be declined -- the fixpoint loop would otherwise spin
        // on this rule until the repair budget is exhausted instead of surfacing the issue.
        let (mut maze, slot0, extra) = maze_with_split_node();
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((slot0, extra));
        let issue = InvalidSplitTileIssue::new_from_check("test", vec![extra]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveSplitStrategy, &issue, &mut maze, &mut rng, &no_params(), &preset_state, &[]);
        assert!(matches!(result, RepairResult::Failed));
        assert!(maze.field.point_of(extra).is_some(), "preset-protected node must survive");
    }

    #[test]
    fn apply_succeeds_on_empty_invalid_list() {
        let (mut maze, _slot0, _extra) = maze_with_split_node();
        let issue = InvalidSplitTileIssue::new_from_check("test", vec![]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveSplitStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }
}
