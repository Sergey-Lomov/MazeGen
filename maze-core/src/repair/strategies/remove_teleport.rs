use crate::Maze;
use crate::generation::PresetState;
use crate::quality_control::InvalidTeleportIssue;
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::RngCore;

pub const PARAM_ALLOW_REVERSE: &str = "allow_reverse";

static PARAMS: &[StrategyParam] = &[StrategyParam {
    id: PARAM_ALLOW_REVERSE,
    label: "Allow teleport to become one-way",
    kind: StrategyParamKind::Bool { default: false },
}];

/// Handles `INVALID_TELEPORT` — see GitHub issue #74 and #190. The fix strategy for every
/// per-teleport validation check: removes each flagged teleport edge. Unlike `INVALID_LOOP`
/// (which has both a random and a scored cut strategy), a teleport is a single edge, not a cycle
/// with multiple candidate edges to choose from, so there is no strategy to pick between — only
/// one configurable parameter, `allow_reverse`.
///
/// Route protection (GitHub issue #78) lives entirely on the producing checks' side, not here:
/// each per-teleport check has its own `protect_route` param and simply never includes a
/// route-critical teleport in `invalid` to begin with, so `issue.data` never contains an edge
/// this strategy shouldn't remove. This strategy stays a pure "remove everything flagged"
/// executor, same as before #78.
///
/// `allow_reverse` (default `false`, GitHub issue #190) controls what happens to a flagged
/// direction's opposite-direction `Teleport` counterpart, if any:
/// - `false` (default): removes the whole teleport, same as before #190 —
///   `RemoveTeleportWithReverse` also removes the opposite direction, so a two-way teleport is
///   never left silently downgraded to one-way just because a check's edge selector (e.g.
///   `EntryOnly`) only inspected one direction and flagged only that `EdgeId`.
/// - `true`: removes only the flagged direction (`RemoveEdge`), leaving the opposite direction
///   (if any) intact — downgrading a two-way teleport to one-way instead of removing it
///   entirely.
pub struct RemoveTeleportStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidTeleportIssue> for RemoveTeleportStrategy {
    fn strategy_id(&self) -> &'static str {
        "remove_teleport"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &InvalidTeleportIssue,
        _maze: &Maze<T>,
        _rng: &mut dyn RngCore,
        params: &StrategyParams,
        _preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let allow_reverse = matches!(
            params.get(PARAM_ALLOW_REVERSE),
            Some(StrategyParamValue::Bool(true))
        );
        let commands = issue
            .invalid
            .iter()
            .map(|&id| {
                if allow_reverse {
                    MutationCommand::RemoveEdge { id }
                } else {
                    MutationCommand::RemoveTeleportWithReverse { id }
                }
            })
            .collect();
        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(RemoveTeleportStrategy, InvalidTeleportIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::quality_control::check::Check;
    use crate::quality_control::checks::TeleportDuplicatesConnectionCheck;
    use crate::random::MazeRng;
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;
    use crate::space::{SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    fn maze_with_duplicate_teleport() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = crate::space::MultiLevelField::single_level(
            Arc::default(),
            square_rect(3, 1),
            &mut ids,
        )
        .unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        g.add_edge(nodes[0], nodes[2], EdgeKind::Teleport);
        g.add_edge(nodes[0], nodes[2], EdgeKind::Basic);
        Maze::new(field, g)
    }

    fn no_params() -> StrategyParams {
        build_params(<RemoveTeleportStrategy as RepairStrategy<SquareTessellation, InvalidTeleportIssue>>::params(&RemoveTeleportStrategy), None)
    }

    fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
        let mut map = std::collections::HashMap::new();
        for &(k, v) in overrides {
            map.insert(k.to_string(), v.to_string());
        }
        build_params(<RemoveTeleportStrategy as RepairStrategy<SquareTessellation, InvalidTeleportIssue>>::params(&RemoveTeleportStrategy), Some(&map))
    }

    #[test]
    fn apply_removes_flagged_teleport_but_keeps_the_basic_edge() {
        let mut maze = maze_with_duplicate_teleport();
        let check = TeleportDuplicatesConnectionCheck {
            instance_id: "teleport_duplicates_connection".to_string(),
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut check_rng = MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, ());
        let issue = issues.into_iter().next().unwrap();

        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &RemoveTeleportStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(!maze.graph.edges().any(|e| e.kind == EdgeKind::Teleport));
        assert!(maze.graph.edges().any(|e| e.kind == EdgeKind::Basic));
    }

    #[test]
    fn apply_removes_both_directions_of_a_two_way_duplicate_teleport() {
        let mut ids = IdGenerator::new();
        let field = crate::space::MultiLevelField::single_level(
            Arc::default(),
            square_rect(3, 1),
            &mut ids,
        )
        .unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        g.add_edge(nodes[0], nodes[2], EdgeKind::Teleport);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Teleport);
        g.add_edge(nodes[0], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = TeleportDuplicatesConnectionCheck {
            instance_id: "teleport_duplicates_connection".to_string(),
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut check_rng = MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, ());
        let issue = issues.into_iter().next().unwrap();

        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &RemoveTeleportStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(
            !maze.graph.edges().any(|e| e.kind == EdgeKind::Teleport),
            "both teleport directions must be removed"
        );
        assert_eq!(
            maze.graph
                .edges()
                .filter(|e| e.kind == EdgeKind::Basic)
                .count(),
            2,
            "both basic directions must survive"
        );
    }

    #[test]
    fn apply_removes_the_reverse_direction_even_when_only_the_forward_id_is_flagged() {
        // Only the forward direction is in `invalid` (simulating an edge selector like EntryOnly
        // that only ever inspects/flags one end) -- the strategy must still remove the backward
        // Teleport counterpart so a two-way teleport is never left downgraded to one-way.
        let mut ids = IdGenerator::new();
        let field = crate::space::MultiLevelField::single_level(
            Arc::default(),
            square_rect(3, 1),
            &mut ids,
        )
        .unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        let forward_id = g.add_edge(nodes[0], nodes[2], EdgeKind::Teleport);
        let backward_id = g.add_edge(nodes[2], nodes[0], EdgeKind::Teleport);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidTeleportIssue::new_from_check("test", vec![forward_id]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &RemoveTeleportStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(
            maze.graph.edge(forward_id).is_none(),
            "the flagged forward direction must be removed"
        );
        assert!(
            maze.graph.edge(backward_id).is_none(),
            "the unflagged backward direction must also be removed"
        );
    }

    #[test]
    fn apply_does_not_remove_a_reverse_basic_edge_mistaken_for_a_teleport_reverse() {
        // A Basic edge in the reverse direction must not be treated as the flagged Teleport's
        // "reverse" -- only a Teleport-kind reverse counts. Regression guard for
        // `Graph::teleport_reverse`'s kind check.
        let mut ids = IdGenerator::new();
        let field = crate::space::MultiLevelField::single_level(
            Arc::default(),
            square_rect(3, 1),
            &mut ids,
        )
        .unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        let teleport_id = g.add_edge(nodes[0], nodes[2], EdgeKind::Teleport);
        let reverse_basic_id = g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidTeleportIssue::new_from_check("test", vec![teleport_id]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &RemoveTeleportStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.graph.edge(teleport_id).is_none());
        assert!(
            maze.graph.edge(reverse_basic_id).is_some(),
            "a reverse Basic edge must survive -- it is not a teleport reverse"
        );
    }

    #[test]
    fn apply_with_allow_reverse_removes_only_the_flagged_direction() {
        let mut ids = IdGenerator::new();
        let field = crate::space::MultiLevelField::single_level(
            Arc::default(),
            square_rect(3, 1),
            &mut ids,
        )
        .unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        let forward_id = g.add_edge(nodes[0], nodes[2], EdgeKind::Teleport);
        let backward_id = g.add_edge(nodes[2], nodes[0], EdgeKind::Teleport);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidTeleportIssue::new_from_check("test", vec![forward_id]);
        let params = params_with(&[(PARAM_ALLOW_REVERSE, "true")]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &RemoveTeleportStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(
            maze.graph.edge(forward_id).is_none(),
            "the flagged forward direction must be removed"
        );
        assert!(
            maze.graph.edge(backward_id).is_some(),
            "allow_reverse must leave the unflagged backward direction intact"
        );
    }

    #[test]
    fn apply_default_still_removes_the_reverse_direction() {
        let mut ids = IdGenerator::new();
        let field = crate::space::MultiLevelField::single_level(
            Arc::default(),
            square_rect(3, 1),
            &mut ids,
        )
        .unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        let forward_id = g.add_edge(nodes[0], nodes[2], EdgeKind::Teleport);
        let backward_id = g.add_edge(nodes[2], nodes[0], EdgeKind::Teleport);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidTeleportIssue::new_from_check("test", vec![forward_id]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &RemoveTeleportStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.graph.edge(forward_id).is_none());
        assert!(
            maze.graph.edge(backward_id).is_none(),
            "default (allow_reverse=false) must still remove the reverse direction"
        );
    }

    #[test]
    fn apply_succeeds_on_empty_invalid_list() {
        let mut maze = maze_with_duplicate_teleport();
        let issue = InvalidTeleportIssue::new_from_check("test", vec![]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &RemoveTeleportStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    #[test]
    fn apply_removes_a_teleport_duplicating_a_preset_protected_basic_connection() {
        // A Teleport edge can never itself be a preset connection (only Passage/OneWay presets
        // exist, and those always build EdgeKind::Basic — see `try_remove_edge_by_id`'s doc
        // comment). If the Basic edge it duplicates happens to be preset-protected, that
        // protection must not leak onto the Teleport: the Teleport is still removable.
        let mut maze = maze_with_duplicate_teleport();
        let check = TeleportDuplicatesConnectionCheck {
            instance_id: "teleport_duplicates_connection".to_string(),
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut check_rng = MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, ());
        let issue = issues.into_iter().next().unwrap();

        let basic_edge = maze
            .graph
            .edges()
            .find(|e| e.kind == EdgeKind::Basic)
            .unwrap();
        let mut preset_state = PresetState::empty();
        preset_state
            .preset_edges
            .insert((basic_edge.from, basic_edge.to));

        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &RemoveTeleportStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &preset_state,
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(
            !maze.graph.edges().any(|e| e.kind == EdgeKind::Teleport),
            "teleport must be removed even though the duplicated Basic pair is preset-protected"
        );
        assert!(
            maze.graph.edges().any(|e| e.kind == EdgeKind::Basic),
            "the preset-protected Basic edge itself must survive"
        );
    }
}
