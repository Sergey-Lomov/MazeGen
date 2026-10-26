use super::dead_end_to_passage::PARAM_ONE_WAY_CHANCE;
use super::vertical_target::{DirectionConstraint, resolve_vertical_target};
use crate::Maze;
use crate::generation::PresetState;
use crate::quality_control::InvalidDeadEndIssue;
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::{Rng, RngCore};

static PARAMS: [StrategyParam; 1] = [StrategyParam {
    id: PARAM_ONE_WAY_CHANCE,
    label: "One-way chance",
    kind: StrategyParamKind::Float {
        default: 0.0,
        min: 0.0,
        max: 100.0,
    },
}];

/// Repairs exactly one selected `INVALID_DEAD_END` node by adding one vertical passage to the
/// same field point on an adjacent floor. Group membership, quotas, and selection are owned by
/// `DeadEndGroupSelectStrategy`.
pub struct DeadEndToVerticalPassageStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidDeadEndIssue> for DeadEndToVerticalPassageStrategy {
    fn strategy_id(&self) -> &'static str {
        "dead_end_to_vertical_passage"
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
        let Some((from, to)) =
            resolve_vertical_target(maze, *src, rng, &DirectionConstraint::Either, 0.5)
        else {
            return (RepairResult::Failed, vec![]);
        };
        if maze.graph.edge_between(from, to).is_some()
            || maze.graph.edge_between(to, from).is_some()
        {
            return (RepairResult::Failed, vec![]);
        }

        let command = if rng.random::<f64>() < one_way_chance {
            // A directed connection must point out of the selected dead end. An incoming-only
            // passage would leave it with the same number of usable exits.
            if !crate::generation::directed_edge_feasible(preset_state, from, to) {
                return (RepairResult::Failed, vec![]);
            }
            MutationCommand::AddDirectedVerticalPassage { from, to }
        } else {
            if !crate::generation::bidirectional_edge_feasible(preset_state, from, to) {
                return (RepairResult::Failed, vec![]);
            }
            MutationCommand::AddBidirectionalVerticalPassage { a: from, b: to }
        };

        (RepairResult::Fixed { score: None }, vec![command])
    }
}

crate::impl_erased_repair_strategy!(DeadEndToVerticalPassageStrategy, InvalidDeadEndIssue);

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

    fn maze() -> (Maze<SquareTessellation>, crate::ids::NodeId) {
        let mut ids = IdGenerator::new();
        let bottom = crate::space::Field::new(Arc::default(), square_rect(2, 2), &mut ids).unwrap();
        let top = crate::space::Field::new(Arc::default(), square_rect(2, 2), &mut ids).unwrap();
        let field = MultiLevelField::new(Arc::default(), [bottom, top]);
        let bottom_level = field.levels_ordered().next().unwrap();
        let src = field
            .node_at(bottom_level, SquarePoint { x: 0, y: 0 })
            .unwrap();
        let neighbor = field
            .node_at(bottom_level, SquarePoint { x: 1, y: 0 })
            .unwrap();
        let mut graph = Graph::new();
        for node in field.all_node_ids() {
            graph.add_node(node);
        }
        graph.add_bidirectional_edge(src, neighbor, EdgeKind::Basic);
        (Maze::new(field, graph), src)
    }

    fn params(overrides: Option<&HashMap<String, String>>) -> StrategyParams {
        build_params(
            <DeadEndToVerticalPassageStrategy as RepairStrategy<
                SquareTessellation,
                InvalidDeadEndIssue,
            >>::params(&DeadEndToVerticalPassageStrategy),
            overrides,
        )
    }

    fn vertical_target(
        maze: &Maze<SquareTessellation>,
        src: crate::ids::NodeId,
    ) -> crate::ids::NodeId {
        let top_level = maze.field.levels_ordered().last().unwrap();
        maze.field
            .node_at(top_level, maze.field.cell_of(src).unwrap())
            .unwrap()
    }

    #[test]
    fn adds_a_bidirectional_vertical_passage_from_the_selected_dead_end() {
        let (maze, src) = maze();
        let mut rng = MazeRng::seed_from_u64(1);
        let (result, commands) = DeadEndToVerticalPassageStrategy.apply(
            &InvalidDeadEndIssue::new_from_check("group_select", vec![src]),
            &maze,
            &mut rng,
            &params(None),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert!(matches!(
            commands.as_slice(),
            [MutationCommand::AddBidirectionalVerticalPassage { a, b }]
                if *a == src && maze.field.cell_of(*a) == maze.field.cell_of(*b)
        ));
    }

    #[test]
    fn one_way_vertical_passage_always_points_outward_from_the_selected_dead_end() {
        let (maze, src) = maze();
        let mut overrides = HashMap::new();
        overrides.insert(PARAM_ONE_WAY_CHANCE.to_string(), "100".to_string());
        let mut rng = MazeRng::seed_from_u64(1);
        let (result, commands) = DeadEndToVerticalPassageStrategy.apply(
            &InvalidDeadEndIssue::new_from_check("group_select", vec![src]),
            &maze,
            &mut rng,
            &params(Some(&overrides)),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert!(matches!(
            commands.as_slice(),
            [MutationCommand::AddDirectedVerticalPassage { from, .. }] if *from == src
        ));
    }

    #[test]
    fn fails_on_a_single_level_field() {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::<SquareTessellation>::single_level(
            Arc::default(),
            square_rect(2, 2),
            &mut ids,
        )
        .unwrap();
        let src = field
            .node_at(field.single_level_id(), SquarePoint { x: 0, y: 0 })
            .unwrap();
        let mut graph = Graph::new();
        for node in field.all_node_ids() {
            graph.add_node(node);
        }
        let maze = Maze::new(field, graph);
        let mut rng = MazeRng::seed_from_u64(1);
        let (result, commands) = DeadEndToVerticalPassageStrategy.apply(
            &InvalidDeadEndIssue::new_from_check("group_select", vec![src]),
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
    fn fails_when_the_vertical_target_is_already_connected() {
        let (mut maze, src) = maze();
        let target = vertical_target(&maze, src);
        maze.graph.add_edge(src, target, EdgeKind::VerticalPassage);
        let mut rng = MazeRng::seed_from_u64(1);
        let (result, commands) = DeadEndToVerticalPassageStrategy.apply(
            &InvalidDeadEndIssue::new_from_check("group_select", vec![src]),
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
    fn fails_when_a_preset_blocks_the_new_vertical_passage() {
        let (maze, src) = maze();
        let target = vertical_target(&maze, src);
        let mut preset = PresetState::empty();
        preset.blocked.insert((src, target));
        let mut rng = MazeRng::seed_from_u64(1);
        let (result, commands) = DeadEndToVerticalPassageStrategy.apply(
            &InvalidDeadEndIssue::new_from_check("group_select", vec![src]),
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
