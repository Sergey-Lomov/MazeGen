use crate::Maze;
use crate::generation::PresetState;
use crate::generation::{cmd_add_bidirectional_edge, cmd_add_directed_edge};
use crate::quality_control::InvalidDeadEndIssue;
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::seq::SliceRandom;
use rand::{Rng, RngCore};

pub const PARAM_ONE_WAY_CHANCE: &str = "dead_end_one_way_chance";

static PARAMS: [StrategyParam; 1] = [StrategyParam {
    id: PARAM_ONE_WAY_CHANCE,
    label: "Dead-end one-way chance",
    kind: StrategyParamKind::Float {
        default: 0.0,
        min: 0.0,
        max: 100.0,
    },
}];

/// Repairs exactly one selected `INVALID_DEAD_END` node by adding one geometric `Basic` passage.
/// Group membership, quotas, and selection are owned by `DeadEndGroupSelectStrategy`.
pub struct DeadEndToPassageStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidDeadEndIssue> for DeadEndToPassageStrategy {
    fn strategy_id(&self) -> &'static str {
        "dead_end_to_passage"
    }

    fn params(&self) -> &'static [StrategyParam] {
        &PARAMS
    }

    fn apply(
        &self,
        issue: &InvalidDeadEndIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let [src] = issue.invalid.as_slice() else {
            return (RepairResult::Failed, vec![]);
        };
        let one_way_chance = params
            .get(PARAM_ONE_WAY_CHANCE)
            .and_then(|value| value.as_float())
            .unwrap_or(0.0)
            / 100.0;
        let mut neighbors = maze.field.neighbors(*src);
        neighbors.shuffle(rng);

        for dst in neighbors {
            if maze.graph.edge_between(*src, dst).is_some()
                || maze.graph.edge_between(dst, *src).is_some()
            {
                continue;
            }
            let commands = if rng.random::<f64>() < one_way_chance {
                cmd_add_directed_edge(*src, dst, preset_state)
            } else {
                cmd_add_bidirectional_edge(*src, dst, preset_state)
            };
            if !commands.is_empty() {
                return (RepairResult::Fixed { score: None }, commands);
            }
        }

        (RepairResult::Failed, vec![])
    }
}

crate::impl_erased_repair_strategy!(DeadEndToPassageStrategy, InvalidDeadEndIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::{EdgeKind, Graph};
    use crate::random::MazeRng;
    use crate::repair::params::build_params;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use rand::SeedableRng;
    use std::collections::HashMap;
    use std::sync::Arc;

    fn maze() -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(2, 2), &mut ids).unwrap();
        let level = field.single_level_id();
        let mut nodes = Vec::new();
        for y in 0..2 {
            for x in 0..2 {
                nodes.push(field.node_at(level, SquarePoint { x, y }).unwrap());
            }
        }
        let mut graph = Graph::new();
        for &node in &nodes {
            graph.add_node(node);
        }
        graph.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        graph.add_edge(nodes[1], nodes[0], EdgeKind::Basic);
        (Maze::new(field, graph), nodes)
    }

    fn params(overrides: Option<&HashMap<String, String>>) -> StrategyParams {
        build_params(
            <DeadEndToPassageStrategy as RepairStrategy<
                SquareTessellation,
                InvalidDeadEndIssue,
            >>::params(&DeadEndToPassageStrategy),
            overrides,
        )
    }

    #[test]
    fn repairs_exactly_one_selected_dead_end() {
        let (maze, nodes) = maze();
        let mut rng = MazeRng::seed_from_u64(1);
        let (result, commands) = DeadEndToPassageStrategy.apply(
            &InvalidDeadEndIssue::new_from_check("group_select", vec![nodes[0]]),
            &maze,
            &mut rng,
            &params(None),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert_eq!(commands.len(), 1);
    }

    #[test]
    fn rejects_a_non_singleton_nested_issue() {
        let (maze, nodes) = maze();
        let mut rng = MazeRng::seed_from_u64(1);
        let (result, commands) = DeadEndToPassageStrategy.apply(
            &InvalidDeadEndIssue::new_from_check("group_select", vec![nodes[0], nodes[1]]),
            &maze,
            &mut rng,
            &params(None),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Failed));
        assert!(commands.is_empty());
    }

    #[test]
    fn one_way_passage_always_points_outward_from_the_selected_dead_end() {
        let (maze, nodes) = maze();
        let mut overrides = HashMap::new();
        overrides.insert(PARAM_ONE_WAY_CHANCE.to_string(), "100".to_string());
        let mut rng = MazeRng::seed_from_u64(7);
        let (result, commands) = DeadEndToPassageStrategy.apply(
            &InvalidDeadEndIssue::new_from_check("group_select", vec![nodes[0]]),
            &maze,
            &mut rng,
            &params(Some(&overrides)),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert!(matches!(
            commands.as_slice(),
            [MutationCommand::AddDirectedEdge { from, .. }] if *from == nodes[0]
        ));
    }

    #[test]
    fn fails_when_every_new_passage_is_preset_blocked() {
        let (maze, nodes) = maze();
        let mut preset = PresetState::empty();
        preset.blocked.insert((nodes[0], nodes[2]));
        preset.blocked.insert((nodes[2], nodes[0]));
        let mut rng = MazeRng::seed_from_u64(2);
        let (result, commands) = DeadEndToPassageStrategy.apply(
            &InvalidDeadEndIssue::new_from_check("group_select", vec![nodes[0]]),
            &maze,
            &mut rng,
            &params(None),
            &preset,
            &[],
        );
        assert!(matches!(result, RepairResult::Failed));
        assert!(commands.is_empty());
    }
}
