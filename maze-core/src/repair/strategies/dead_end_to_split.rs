use super::split_core::{
    RequiredConnection, pick_weighted_pattern, plan_pattern_split, plan_unconstrained_split,
};
use crate::Maze;
use crate::generation::{PresetState, SplitGenerationConfig};
use crate::ids::NodeId;
use crate::quality_control::InvalidDeadEndIssue;
use crate::repair::command::{MutationCommand, SplitNodeEdge, SplitNodeEdgeDirection};
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::RngCore;
use rand::seq::SliceRandom;
use std::collections::HashSet;

/// Repairs one selected `INVALID_DEAD_END` node by replacing a geometrically adjacent, walled-off
/// cell with a split tile. One node of that tile is required to connect back to the dead end, and
/// the shared split planner rejects a candidate unless that same node also has another edge.
///
/// The construction-time split configuration deliberately matches `MissingLoopsSplitStrategy`:
/// an empty pattern list permits unrestricted generation, while configured weighted patterns are
/// picked and transformed until one can carry the required bridge.
pub struct DeadEndToSplitStrategy {
    pub config: SplitGenerationConfig,
}

impl<T: Tessellation> RepairStrategy<T, InvalidDeadEndIssue> for DeadEndToSplitStrategy {
    fn strategy_id(&self) -> &'static str {
        "dead_end_to_split"
    }

    fn apply(
        &self,
        issue: &InvalidDeadEndIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        _params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let [dead_end] = issue.invalid.as_slice() else {
            return (RepairResult::Failed, vec![]);
        };

        let mut targets = maze.field.neighbors(*dead_end);
        targets.shuffle(rng);
        for target in targets {
            // A passage in either direction means this is not the wall the strategy is intended
            // to cross. A pre-existing split tile or a locked target cannot be atomically replaced.
            if maze.graph.edge_between(*dead_end, target).is_some()
                || maze.graph.edge_between(target, *dead_end).is_some()
                || !crate::generation::split_is_eligible(&maze.field, preset_state, target)
            {
                continue;
            }

            let required = RequiredConnection {
                neighbor: *dead_end,
                direction: SplitNodeEdgeDirection::Passage,
            };
            if let Some(nodes) = self.plan_split(maze, target, &required, rng) {
                // `plan_split` can propose a new edge to the selected dead end or another free
                // neighbor. Those targets may have directional preset locks even though `target`
                // itself is split-eligible; reject the plan here so `Fixed` never accompanies a
                // `ReplacePointNodes` command that apply-time revalidation will decline.
                if !crate::generation::replace_point_nodes_feasible(
                    &maze.field,
                    preset_state,
                    target,
                    &nodes,
                ) {
                    continue;
                }
                return (
                    RepairResult::Fixed { score: None },
                    vec![MutationCommand::ReplacePointNodes { at: target, nodes }],
                );
            }
        }

        (RepairResult::Failed, vec![])
    }
}

impl DeadEndToSplitStrategy {
    fn plan_split<T: Tessellation>(
        &self,
        maze: &Maze<T>,
        at: NodeId,
        required: &RequiredConnection,
        rng: &mut dyn RngCore,
    ) -> Option<Vec<Vec<SplitNodeEdge>>> {
        let excluded = HashSet::new();
        if self.config.patterns.is_empty() {
            plan_unconstrained_split(
                maze,
                at,
                self.config.max_split_nodes.max(2) as usize,
                Some(required),
                &excluded,
                rng,
            )
        } else {
            let pattern_idx = pick_weighted_pattern(&self.config.patterns, rng);
            plan_pattern_split(
                maze,
                at,
                &self.config.patterns[pattern_idx],
                Some(required),
                &excluded,
                rng,
                true,
                true,
            )
        }
    }
}

crate::impl_erased_repair_strategy!(DeadEndToSplitStrategy, InvalidDeadEndIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::generation::{SplitFaceRequirement, SplitPattern, SplitPatternFace};
    use crate::graph::{EdgeKind, Graph};
    use crate::random::MazeRng;
    use crate::repair::strategies::test_utils::apply_and_commit;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use rand::SeedableRng;
    use std::sync::Arc;

    fn strategy() -> DeadEndToSplitStrategy {
        DeadEndToSplitStrategy {
            config: SplitGenerationConfig {
                pattern_mode: false,
                max_split_nodes: 2,
                patterns: vec![],
            },
        }
    }

    fn maze() -> (Maze<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 2), &mut ids).unwrap();
        let level = field.single_level_id();
        let nodes: Vec<NodeId> = (0..2)
            .flat_map(|y| (0..3).map(move |x| SquarePoint { x, y }))
            .map(|point| field.node_at(level, point).unwrap())
            .collect();
        let mut graph = Graph::new();
        for node in field.all_node_ids() {
            graph.add_node(node);
        }
        // (0,0) is the selected dead end; (1,0) is separated by its east wall.
        graph.add_bidirectional_edge(nodes[0], nodes[3], EdgeKind::Basic);
        (Maze::new(field, graph), nodes)
    }

    fn issue(node: NodeId) -> InvalidDeadEndIssue {
        InvalidDeadEndIssue::new_from_check("group_select", vec![node])
    }

    #[test]
    fn replaces_the_walled_neighbor_and_connects_it_to_the_dead_end() {
        let (mut maze, nodes) = maze();
        let target = nodes[1];
        let mut rng = MazeRng::seed_from_u64(4);
        let result = apply_and_commit(
            &strategy(),
            &issue(nodes[0]),
            &mut maze,
            &mut rng,
            &StrategyParams::new(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        let split_nodes = maze
            .field
            .nodes_at(maze.field.single_level_id(), SquarePoint { x: 1, y: 0 });
        assert_eq!(split_nodes.len(), 2);
        let bridge_node = split_nodes
            .iter()
            .copied()
            .find(|&node| maze.graph.edge_between(node, nodes[0]).is_some())
            .expect("one split node must connect to the selected dead end");
        assert!(
            maze.graph.outgoing_neighbors(bridge_node).count() >= 2,
            "the bridge-carrying node must have another edge"
        );
        assert!(
            maze.field.cell_of(target).is_none(),
            "the original target node is replaced"
        );
    }

    #[test]
    fn rotates_a_pattern_to_face_the_dead_end() {
        let (mut maze, nodes) = maze();
        let pattern = SplitPattern {
            shape: "regular:4".to_string(),
            node_count: 2,
            faces: vec![
                vec![],
                vec![
                    SplitPatternFace {
                        face_index: 0,
                        requirement: SplitFaceRequirement::Passage,
                        sibling_target: None,
                    },
                    SplitPatternFace {
                        face_index: 1,
                        requirement: SplitFaceRequirement::Passage,
                        sibling_target: None,
                    },
                ],
            ],
            weight: 1.0,
        };
        let strategy = DeadEndToSplitStrategy {
            config: SplitGenerationConfig {
                pattern_mode: true,
                max_split_nodes: 2,
                patterns: vec![pattern],
            },
        };
        let mut rng = MazeRng::seed_from_u64(9);
        let result = apply_and_commit(
            &strategy,
            &issue(nodes[0]),
            &mut maze,
            &mut rng,
            &StrategyParams::new(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert!(
            maze.field
                .nodes_at(maze.field.single_level_id(), SquarePoint { x: 1, y: 0 })
                .iter()
                .any(|&node| maze.graph.edge_between(node, nodes[0]).is_some())
        );
    }

    #[test]
    fn rejects_non_singleton_nested_issues() {
        let (maze, nodes) = maze();
        let mut rng = MazeRng::seed_from_u64(1);
        let (result, commands) = strategy().apply(
            &InvalidDeadEndIssue::new_from_check("group_select", vec![nodes[0], nodes[3]]),
            &maze,
            &mut rng,
            &StrategyParams::new(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Failed));
        assert!(commands.is_empty());
    }

    #[test]
    fn fails_instead_of_proposing_a_bridge_blocked_by_a_preset_lock() {
        let (maze, nodes) = maze();
        let mut presets = PresetState::empty();
        // The dead end is the required target of the new bidirectional bridge. Locking incoming
        // edges at that target makes the eventual ReplacePointNodes command infeasible.
        presets.locked_in.insert(nodes[0]);
        let mut rng = MazeRng::seed_from_u64(4);
        let (result, commands) = strategy().apply(
            &issue(nodes[0]),
            &maze,
            &mut rng,
            &StrategyParams::new(),
            &presets,
            &[],
        );
        assert!(matches!(result, RepairResult::Failed));
        assert!(commands.is_empty());
    }
}
