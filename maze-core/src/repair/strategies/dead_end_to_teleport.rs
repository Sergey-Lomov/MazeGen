use crate::Maze;
use crate::generation::PresetState;
use crate::generation::{cmd_add_bidirectional_teleport, cmd_add_directed_teleport};
use crate::graph::pathfinding::bfs_distances;
use crate::ids::NodeId;
use crate::quality_control::InvalidDeadEndIssue;
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategies::standard_add_params::{ATTEMPTS_LIMIT_PARAM, attempts_limit};
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::seq::SliceRandom;
use rand::{Rng, RngCore};
use std::collections::HashSet;

pub const PARAM_ONE_WAY_CHANCE: &str = "one_way_chance";
pub const PARAM_ALLOW_CROSS_FLOOR: &str = "allow_cross_floor";
pub const PARAM_DESIRED_LENGTH: &str = "desired_length";
pub const PARAM_ALLOW_OUT_OF_INTERVAL: &str = "allow_out_of_interval";
pub const PARAM_EXIT_PICK: &str = "exit_pick";

pub const EXIT_RANDOM: &str = "random";
pub const EXIT_DEAD_END_PRIORITY: &str = "dead_end_priority";
const EXIT_OPTIONS: &[&str] = &[EXIT_RANDOM, EXIT_DEAD_END_PRIORITY];

const ONE_WAY_CHANCE_PARAM: StrategyParam = StrategyParam {
    id: PARAM_ONE_WAY_CHANCE,
    label: "One-way chance",
    kind: StrategyParamKind::Float {
        default: 50.0,
        min: 0.0,
        max: 100.0,
    },
};
const ALLOW_CROSS_FLOOR_PARAM: StrategyParam = StrategyParam {
    id: PARAM_ALLOW_CROSS_FLOOR,
    label: "Allow cross-floor exit",
    kind: StrategyParamKind::Bool { default: false },
};
const DESIRED_LENGTH_PARAM: StrategyParam = StrategyParam {
    id: PARAM_DESIRED_LENGTH,
    label: "Desired graph length",
    kind: StrategyParamKind::Interval {
        default_min: 5.0,
        default_max: 1000.0,
        min: 0.0,
        max: 100_000.0,
    },
};
const ALLOW_OUT_OF_INTERVAL_PARAM: StrategyParam = StrategyParam {
    id: PARAM_ALLOW_OUT_OF_INTERVAL,
    label: "Allow out-of-interval teleport",
    kind: StrategyParamKind::Bool { default: true },
};
const EXIT_PICK_PARAM: StrategyParam = StrategyParam {
    id: PARAM_EXIT_PICK,
    label: "Exit pick",
    kind: StrategyParamKind::Enum {
        options: EXIT_OPTIONS,
        default: EXIT_DEAD_END_PRIORITY,
    },
};

static PARAMS: [StrategyParam; 6] = [
    ONE_WAY_CHANCE_PARAM,
    ALLOW_CROSS_FLOOR_PARAM,
    DESIRED_LENGTH_PARAM,
    ALLOW_OUT_OF_INTERVAL_PARAM,
    EXIT_PICK_PARAM,
    ATTEMPTS_LIMIT_PARAM,
];

/// Repairs one selected `INVALID_DEAD_END` node by adding a directed or bidirectional teleport.
/// Candidate/group selection and quota accounting remain the responsibility of
/// `DeadEndGroupSelectStrategy`.
pub struct DeadEndToTeleportStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidDeadEndIssue> for DeadEndToTeleportStrategy {
    fn strategy_id(&self) -> &'static str {
        "dead_end_to_teleport"
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
        let [source] = issue.invalid.as_slice() else {
            return (RepairResult::Failed, vec![]);
        };
        let (desired_min, desired_max) = params
            .get(PARAM_DESIRED_LENGTH)
            .and_then(|value| value.as_interval())
            .unwrap_or((5.0, 1000.0));
        let desired_min = desired_min.max(0.0) as usize;
        let desired_max = desired_max.max(0.0) as usize;
        let allow_out_of_interval = matches!(
            params.get(PARAM_ALLOW_OUT_OF_INTERVAL),
            Some(StrategyParamValue::Bool(true))
        );
        let allow_cross_floor = matches!(
            params.get(PARAM_ALLOW_CROSS_FLOOR),
            Some(StrategyParamValue::Bool(true))
        );
        let exit_pick = match params.get(PARAM_EXIT_PICK) {
            Some(StrategyParamValue::Enum(value)) => value.as_str(),
            _ => EXIT_DEAD_END_PRIORITY,
        };
        let one_way_chance = params
            .get(PARAM_ONE_WAY_CHANCE)
            .and_then(|value| value.as_float())
            .unwrap_or(50.0)
            .clamp(0.0, 100.0);

        let distances = bfs_distances(&maze.graph, *source);
        let source_level = maze.field.level_of(*source);
        let mut in_interval = Vec::new();
        let mut out_of_interval = Vec::new();
        for exit in maze.field.all_node_ids() {
            if exit == *source
                || maze.graph.edge_between(*source, exit).is_some()
                || !crate::generation::directed_edge_feasible(preset_state, *source, exit)
                || (!allow_cross_floor && maze.field.level_of(exit) != source_level)
            {
                continue;
            }
            if matches!(distances.get(&exit), Some(&distance) if distance >= desired_min && distance <= desired_max)
            {
                in_interval.push(exit);
            } else {
                out_of_interval.push(exit);
            }
        }
        let candidates = if !in_interval.is_empty() {
            in_interval
        } else if allow_out_of_interval {
            out_of_interval
        } else {
            Vec::new()
        };
        let reported_dead_ends: HashSet<NodeId> =
            issue.reported_candidates.iter().copied().collect();
        let mut candidates = order_candidates(candidates, exit_pick, &reported_dead_ends, rng);

        for _ in 0..attempts_limit(params) {
            let Some(exit) = candidates.pop() else {
                break;
            };
            let commands = if rng.random_bool(one_way_chance / 100.0) {
                cmd_add_directed_teleport(*source, exit, preset_state)
            } else {
                // A two-way teleport is preferred for this roll, but a blocked reverse direction
                // must not discard the feasible source -> exit repair.
                let bidirectional = cmd_add_bidirectional_teleport(*source, exit, preset_state);
                if bidirectional.is_empty() {
                    cmd_add_directed_teleport(*source, exit, preset_state)
                } else {
                    bidirectional
                }
            };
            if !commands.is_empty() {
                return (RepairResult::Fixed { score: None }, commands);
            }
        }
        (RepairResult::Failed, vec![])
    }
}

crate::impl_erased_repair_strategy!(DeadEndToTeleportStrategy, InvalidDeadEndIssue);

fn order_candidates(
    mut candidates: Vec<NodeId>,
    exit_pick: &str,
    reported_dead_ends: &HashSet<NodeId>,
    rng: &mut dyn RngCore,
) -> Vec<NodeId> {
    candidates.shuffle(rng);
    if exit_pick == EXIT_DEAD_END_PRIORITY {
        let (other, dead_ends): (Vec<_>, Vec<_>) = candidates
            .into_iter()
            .partition(|candidate| !reported_dead_ends.contains(candidate));
        // `pop()` consumes the tail first, so keep prioritized candidates at the end.
        return other.into_iter().chain(dead_ends).collect();
    }
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::{EdgeKind, Graph};
    use crate::random::MazeRng;
    use crate::repair::params::build_params;
    use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use rand::SeedableRng;
    use std::sync::Arc;

    fn maze_line(length: usize) -> (Maze<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(Arc::default(), square_rect(length, 1), &mut ids)
            .unwrap();
        let level = field.single_level_id();
        let nodes = (0..length)
            .map(|x| {
                field
                    .node_at(level, SquarePoint { x: x as i32, y: 0 })
                    .unwrap()
            })
            .collect();
        let mut graph = Graph::new();
        for node in field.all_node_ids() {
            graph.add_node(node);
        }
        (Maze::new(field, graph), nodes)
    }

    fn params(overrides: &[(&str, &str)]) -> StrategyParams {
        let overrides = overrides
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        build_params(
            <DeadEndToTeleportStrategy as RepairStrategy<
                SquareTessellation,
                InvalidDeadEndIssue,
            >>::params(&DeadEndToTeleportStrategy),
            Some(&overrides),
        )
    }

    fn apply(
        maze: &Maze<SquareTessellation>,
        source: NodeId,
        params: &StrategyParams,
    ) -> (RepairResult, Vec<MutationCommand>) {
        let mut rng = MazeRng::seed_from_u64(3);
        DeadEndToTeleportStrategy.apply(
            &InvalidDeadEndIssue::new_from_check("max_dead_end_count", vec![source]),
            maze,
            &mut rng,
            params,
            &PresetState::empty(),
            &[],
        )
    }

    #[test]
    fn is_a_single_entity_nested_strategy_without_a_reserve_percent() {
        let (maze, nodes) = maze_line(2);
        let mut rng = MazeRng::seed_from_u64(1);
        let (result, commands) = DeadEndToTeleportStrategy.apply(
            &InvalidDeadEndIssue::new_from_check("group", vec![nodes[0], nodes[1]]),
            &maze,
            &mut rng,
            &params(&[]),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Failed));
        assert!(commands.is_empty());
        assert!(
            !<DeadEndToTeleportStrategy as RepairStrategy<
                SquareTessellation,
                InvalidDeadEndIssue,
            >>::params(&DeadEndToTeleportStrategy)
            .iter()
            .any(|param| param.id == "reserve_percent")
        );
    }

    #[test]
    fn directed_teleport_repairs_only_its_supplied_source() {
        let (mut maze, nodes) = maze_line(3);
        maze.graph
            .add_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let (result, commands) = apply(
            &maze,
            nodes[0],
            &params(&[
                (PARAM_ONE_WAY_CHANCE, "100"),
                (PARAM_DESIRED_LENGTH, "0,1000"),
            ]),
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert!(
            matches!(commands.as_slice(), [MutationCommand::AddDirectedTeleport { from, .. }] if *from == nodes[0])
        );
    }

    #[test]
    fn bidirectional_teleport_can_repair_both_dead_end_candidates() {
        let (mut maze, nodes) = maze_line(4);
        maze.graph
            .add_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
        maze.graph
            .add_bidirectional_edge(nodes[2], nodes[3], EdgeKind::Basic);
        let (result, commands) = apply(
            &maze,
            nodes[0],
            &params(&[
                (PARAM_ONE_WAY_CHANCE, "0"),
                (PARAM_DESIRED_LENGTH, "0,1000"),
                (PARAM_EXIT_PICK, EXIT_DEAD_END_PRIORITY),
            ]),
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert!(
            matches!(commands.as_slice(), [MutationCommand::AddBidirectionalTeleport { a, b }] if *a == nodes[0] && (*b == nodes[2] || *b == nodes[3]))
        );
    }

    #[test]
    fn priority_prefers_dead_end_and_random_falls_back_when_none_exists() {
        let (mut maze, nodes) = maze_line(4);
        maze.graph
            .add_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
        maze.graph
            .add_bidirectional_edge(nodes[2], nodes[3], EdgeKind::Basic);
        let mut rng = MazeRng::seed_from_u64(3);
        let (_, priority) = DeadEndToTeleportStrategy.apply(
            &InvalidDeadEndIssue::new_from_group_select("group", nodes[0], &[nodes[2]]),
            &maze,
            &mut rng,
            &params(&[
                (PARAM_ONE_WAY_CHANCE, "100"),
                (PARAM_DESIRED_LENGTH, "0,1000"),
            ]),
            &PresetState::empty(),
            &[],
        );
        assert!(
            matches!(priority.as_slice(), [MutationCommand::AddDirectedTeleport { to, .. }] if *to == nodes[2])
        );

        let (empty, nodes) = maze_line(3);
        let (result, commands) = apply(
            &empty,
            nodes[0],
            &params(&[
                (PARAM_ONE_WAY_CHANCE, "100"),
                (PARAM_DESIRED_LENGTH, "0,1000"),
            ]),
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert!(matches!(
            commands.as_slice(),
            [MutationCommand::AddDirectedTeleport { .. }]
        ));
    }

    #[test]
    fn respects_distance_fallback_and_preset_feasibility() {
        let (mut maze, nodes) = maze_line(4);
        for pair in nodes.windows(2) {
            maze.graph
                .add_bidirectional_edge(pair[0], pair[1], EdgeKind::Basic);
        }
        let strict = params(&[
            (PARAM_ONE_WAY_CHANCE, "100"),
            (PARAM_DESIRED_LENGTH, "9,9"),
            (PARAM_ALLOW_OUT_OF_INTERVAL, "false"),
        ]);
        assert!(matches!(
            apply(&maze, nodes[0], &strict).0,
            RepairResult::Failed
        ));
        let fallback = params(&[
            (PARAM_ONE_WAY_CHANCE, "100"),
            (PARAM_DESIRED_LENGTH, "9,9"),
            (PARAM_ALLOW_OUT_OF_INTERVAL, "true"),
            ("attempts_limit", "1"),
        ]);
        assert!(matches!(
            apply(&maze, nodes[0], &fallback).0,
            RepairResult::Fixed { .. }
        ));
        let mut preset = PresetState::empty();
        preset.locked_out.insert(nodes[0]);
        let mut rng = MazeRng::seed_from_u64(3);
        let (result, commands) = DeadEndToTeleportStrategy.apply(
            &InvalidDeadEndIssue::new_from_check("group", vec![nodes[0]]),
            &maze,
            &mut rng,
            &fallback,
            &preset,
            &[],
        );
        assert!(matches!(result, RepairResult::Failed));
        assert!(commands.is_empty());
    }

    #[test]
    fn cross_floor_exit_requires_opt_in() {
        let mut ids = IdGenerator::new();
        let first = Field::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
        let second = Field::new(Arc::default(), square_rect(1, 1), &mut ids).unwrap();
        let mut field = MultiLevelField::new(Arc::default(), [first]);
        let second_level = field.add_level(second);
        let first_level = field.levels_ordered().next().unwrap();
        let source = field
            .node_at(first_level, SquarePoint { x: 0, y: 0 })
            .unwrap();
        let neighbor = field
            .node_at(first_level, SquarePoint { x: 1, y: 0 })
            .unwrap();
        let other_floor = field
            .node_at(second_level, SquarePoint { x: 0, y: 0 })
            .unwrap();
        let mut graph = Graph::new();
        for node in field.all_node_ids() {
            graph.add_node(node);
        }
        graph.add_bidirectional_edge(source, neighbor, EdgeKind::Basic);
        let maze = Maze::new(field, graph);
        let same_floor_only = params(&[
            (PARAM_ONE_WAY_CHANCE, "100"),
            (PARAM_DESIRED_LENGTH, "0,1000"),
        ]);
        assert!(matches!(
            apply(&maze, source, &same_floor_only).0,
            RepairResult::Failed
        ));
        let cross_floor = params(&[
            (PARAM_ONE_WAY_CHANCE, "100"),
            (PARAM_ALLOW_CROSS_FLOOR, "true"),
            (PARAM_DESIRED_LENGTH, "0,1000"),
        ]);
        let (_, commands) = apply(&maze, source, &cross_floor);
        assert!(
            matches!(commands.as_slice(), [MutationCommand::AddDirectedTeleport { to, .. }] if *to == other_floor)
        );
    }
}
