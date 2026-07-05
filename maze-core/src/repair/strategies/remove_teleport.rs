use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::{Issue, IssueData, INVALID_TELEPORT, IssueKind};
use crate::generation::{PresetState, try_remove_edge_by_id};
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::snapshot::SnapshotStack;

/// Handles `INVALID_TELEPORT` — see GitHub issue #74. The single, fixed fix strategy for every
/// per-teleport validation check: remove each flagged teleport edge outright. No configurable
/// parameters, no alternative strategy — unlike `INVALID_LOOP` (which has both a random and a
/// scored cut strategy), a teleport is a single edge, not a cycle with multiple candidate edges
/// to choose from, so there is nothing to pick between.
pub struct RemoveTeleportStrategy;

impl<T: Tessellation> RepairStrategy<T> for RemoveTeleportStrategy {
    fn strategy_id(&self) -> &'static str { "remove_teleport" }
    fn handles(&self) -> IssueKind { INVALID_TELEPORT }

    fn apply(
        &self,
        issue: &Issue,
        maze: &mut Maze<T>,
        _snapshots: &mut SnapshotStack,
        _rng: &mut dyn RngCore,
        _params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> RepairResult {
        debug_assert_eq!(issue.kind, <Self as RepairStrategy<T>>::handles(self));
        // INVALID_TELEPORT always carries InvalidTeleports data in a well-formed pipeline run —
        // the producing check already found exactly which teleport edges to remove, there is no
        // other channel to learn them. Missing/wrong-type data means this was called outside the
        // normal pipeline (malformed) — Failed, not "already fixed". An empty `invalid` means the
        // check found nothing to remove.
        let Some(IssueData::InvalidTeleports { invalid }) = &issue.data else {
            return RepairResult::Failed;
        };
        for &edge_id in invalid {
            try_remove_edge_by_id(&mut maze.graph, edge_id, preset_state);
        }
        RepairResult::Fixed { score: None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{SquareTessellation, square_rect};
    use crate::quality_control::check::Check;
    use crate::quality_control::checks::TeleportDuplicatesConnectionCheck;
    use crate::repair::params::build_params;

    fn maze_with_duplicate_teleport() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = crate::space::Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[2], EdgeKind::Teleport);
        g.add_edge(nodes[0], nodes[2], EdgeKind::Basic);
        Maze::new(field, g)
    }

    fn no_params() -> StrategyParams {
        build_params(<RemoveTeleportStrategy as RepairStrategy<SquareTessellation>>::params(&RemoveTeleportStrategy), None)
    }

    #[test]
    fn apply_removes_flagged_teleport_but_keeps_the_basic_edge() {
        let mut maze = maze_with_duplicate_teleport();
        let check = TeleportDuplicatesConnectionCheck { instance_id: "teleport_duplicates_connection".to_string() };
        let mut issues = Vec::new();
        let mut check_rng = MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut check_rng);
        let issue = issues.into_iter().next().unwrap();

        let mut rng = MazeRng::seed_from_u64(1);
        let result = RemoveTeleportStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(!maze.graph.edges().any(|e| e.kind == EdgeKind::Teleport));
        assert!(maze.graph.edges().any(|e| e.kind == EdgeKind::Basic));
    }

    #[test]
    fn apply_removes_both_directions_of_a_two_way_duplicate_teleport() {
        let mut ids = IdGenerator::new();
        let field = crate::space::Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[2], EdgeKind::Teleport);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Teleport);
        g.add_edge(nodes[0], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = TeleportDuplicatesConnectionCheck { instance_id: "teleport_duplicates_connection".to_string() };
        let mut issues = Vec::new();
        let mut check_rng = MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut check_rng);
        let issue = issues.into_iter().next().unwrap();

        let mut rng = MazeRng::seed_from_u64(1);
        let result = RemoveTeleportStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(!maze.graph.edges().any(|e| e.kind == EdgeKind::Teleport), "both teleport directions must be removed");
        assert_eq!(maze.graph.edges().filter(|e| e.kind == EdgeKind::Basic).count(), 2, "both basic directions must survive");
    }

    #[test]
    fn apply_fails_when_data_is_missing() {
        let mut maze = maze_with_duplicate_teleport();
        let issue = Issue::new(INVALID_TELEPORT); // no data attached
        let mut rng = MazeRng::seed_from_u64(1);
        let result = RemoveTeleportStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_succeeds_on_empty_invalid_list() {
        let mut maze = maze_with_duplicate_teleport();
        let issue = Issue::with_data(INVALID_TELEPORT, IssueData::InvalidTeleports { invalid: vec![] });
        let mut rng = MazeRng::seed_from_u64(1);
        let result = RemoveTeleportStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    #[test]
    fn apply_removes_a_teleport_duplicating_a_preset_protected_basic_connection() {
        // A Teleport edge can never itself be a preset connection (only Passage/OneWay presets
        // exist, and those always build EdgeKind::Basic — see `try_remove_edge_by_id`'s doc
        // comment). If the Basic edge it duplicates happens to be preset-protected, that
        // protection must not leak onto the Teleport: the Teleport is still removable.
        let mut maze = maze_with_duplicate_teleport();
        let check = TeleportDuplicatesConnectionCheck { instance_id: "teleport_duplicates_connection".to_string() };
        let mut issues = Vec::new();
        let mut check_rng = MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut check_rng);
        let issue = issues.into_iter().next().unwrap();

        let basic_edge = maze.graph.edges().find(|e| e.kind == EdgeKind::Basic).unwrap();
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((basic_edge.from, basic_edge.to));

        let mut rng = MazeRng::seed_from_u64(1);
        let result = RemoveTeleportStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &preset_state, &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(!maze.graph.edges().any(|e| e.kind == EdgeKind::Teleport), "teleport must be removed even though the duplicated Basic pair is preset-protected");
        assert!(maze.graph.edges().any(|e| e.kind == EdgeKind::Basic), "the preset-protected Basic edge itself must survive");
    }
}
