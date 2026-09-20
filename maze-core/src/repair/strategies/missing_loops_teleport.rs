use super::dead_end_priority::is_dead_end;
use super::remaining_deficits::RemainingDeficits;
use super::standard_add_params::{self, attempts_limit, reserve_target};
use crate::Maze;
use crate::generation::PresetState;
use crate::generation::{cmd_add_bidirectional_teleport, cmd_add_directed_teleport};
use crate::ids::NodeId;
use crate::quality_control::{MissingLoopsIssue, RepairArea};
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::{Rng, RngCore};
use std::collections::{HashMap, HashSet, VecDeque, hash_map::Entry};

pub const PARAM_ENTRY_PICK: &str = "entry_pick";
pub const PARAM_EXIT_PICK: &str = "exit_pick";
pub const PARAM_DESIRED_LENGTH: &str = "desired_length";
pub const PARAM_ALLOW_OUT_OF_INTERVAL: &str = "allow_out_of_interval";
pub const PARAM_ONE_WAY_CHANCE: &str = "teleport_loop_one_way_chance";

pub const ENTRY_RANDOM: &str = "random";
pub const ENTRY_DEAD_END_PRIORITY: &str = "dead_end_priority";
pub const EXIT_RANDOM: &str = "random";
pub const EXIT_DEAD_END_PRIORITY: &str = "dead_end_priority";

static ENTRY_OPTIONS: &[&str] = &[ENTRY_RANDOM, ENTRY_DEAD_END_PRIORITY];
static EXIT_OPTIONS: &[&str] = &[EXIT_RANDOM, EXIT_DEAD_END_PRIORITY];

const ENTRY_PICK_PARAM: StrategyParam = StrategyParam {
    id: PARAM_ENTRY_PICK,
    label: "Entry pick",
    kind: StrategyParamKind::Enum {
        options: ENTRY_OPTIONS,
        default: ENTRY_DEAD_END_PRIORITY,
    },
};
const EXIT_PICK_PARAM: StrategyParam = StrategyParam {
    id: PARAM_EXIT_PICK,
    label: "Exit pick",
    kind: StrategyParamKind::Enum {
        options: EXIT_OPTIONS,
        default: EXIT_DEAD_END_PRIORITY,
    },
};
const DESIRED_LENGTH_PARAM: StrategyParam = StrategyParam {
    id: PARAM_DESIRED_LENGTH,
    label: "Desired graph length",
    kind: StrategyParamKind::Interval {
        default_min: 0.0,
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
const ONE_WAY_CHANCE_PARAM: StrategyParam = StrategyParam {
    id: PARAM_ONE_WAY_CHANCE,
    label: "One-way teleport chance",
    kind: StrategyParamKind::Float {
        default: 50.0,
        min: 0.0,
        max: 100.0,
    },
};

// Entry selection replaces the shared `src_mode`; the rest of the standard add block remains
// shared with the other loop-seeding strategies.
static PARAMS: [StrategyParam; 7] = crate::add_strategy_params!(no_src_mode:
    ENTRY_PICK_PARAM,
    EXIT_PICK_PARAM,
    DESIRED_LENGTH_PARAM,
    ALLOW_OUT_OF_INTERVAL_PARAM,
    ONE_WAY_CHANCE_PARAM,
);

/// Handles `MISSING_LOOPS` by seeding a candidate closing connection as a teleport. The entry is
/// selected from the reported repair area. The exit is selected only from nodes forward-reachable
/// from that entry, optionally constrained by tile-hop distance. As with the other missing-loop
/// strategies, no cycle verification is performed here; the next QC pass judges the seed.
pub struct MissingLoopsTeleportStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingLoopsIssue> for MissingLoopsTeleportStrategy {
    fn strategy_id(&self) -> &'static str {
        "missing_loops_teleport"
    }
    fn params(&self) -> &'static [StrategyParam] {
        &PARAMS
    }
    fn nested_suppressed_params(&self) -> &'static [&'static str] {
        standard_add_params::NESTED_SUPPRESSED_ADD_PARAMS
    }

    fn apply(
        &self,
        issue: &MissingLoopsIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.missing.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }
        let entry_pick = enum_param(params, PARAM_ENTRY_PICK, ENTRY_DEAD_END_PRIORITY);
        let exit_pick = enum_param(params, PARAM_EXIT_PICK, EXIT_DEAD_END_PRIORITY);
        let (min_length, max_length) = params
            .get(PARAM_DESIRED_LENGTH)
            .and_then(|v| v.as_interval())
            .unwrap_or((0.0, 1000.0));
        let min_length = min_length.max(0.0) as usize;
        let max_length = max_length.max(0.0) as usize;
        let allow_out_of_interval = matches!(
            params.get(PARAM_ALLOW_OUT_OF_INTERVAL),
            Some(StrategyParamValue::Bool(true))
        );
        let one_way_chance = params
            .get(PARAM_ONE_WAY_CHANCE)
            .and_then(|v| v.as_float())
            .unwrap_or(50.0)
            / 100.0;
        let max_failed_attempts = attempts_limit(params);
        let all_nodes: Vec<NodeId> = maze.field.all_node_ids().collect();
        let dead_ends: HashSet<NodeId> =
            if entry_pick == ENTRY_DEAD_END_PRIORITY || exit_pick == EXIT_DEAD_END_PRIORITY {
                all_nodes
                    .iter()
                    .copied()
                    .filter(|&n| is_dead_end(maze, n))
                    .collect()
            } else {
                HashSet::new()
            };
        let mut proposed_pairs = HashSet::new();
        let mut commands = Vec::new();
        let mut total_added = 0;
        let mut deficits = RemainingDeficits::new(&issue.missing);
        let areas: Vec<RepairArea> = deficits.areas().collect();

        for area in areas {
            let missing = deficits.live(area);
            if missing == 0 {
                continue;
            }
            let target = reserve_target(params, missing);
            let mut pool: Vec<NodeId> = all_nodes
                .iter()
                .copied()
                .filter(|&n| match area {
                    RepairArea::WholeMaze => true,
                    RepairArea::Level(level) => maze.field.level_of(n) == Some(level),
                })
                .collect();
            let mut added = 0;
            let mut failed_attempts = 0;
            while added < target && !pool.is_empty() && failed_attempts < max_failed_attempts {
                let source = take_entry(&mut pool, entry_pick, &dead_ends, rng);
                let distances = bfs_distances(maze, source);
                let Some(destination) = pick_exit(
                    maze,
                    source,
                    &distances,
                    min_length,
                    max_length,
                    allow_out_of_interval,
                    exit_pick,
                    &dead_ends,
                    &proposed_pairs,
                    &all_nodes,
                    rng,
                ) else {
                    failed_attempts += 1;
                    continue;
                };
                // One-way chance is a percentage and, like MissingTeleportsStrategy, keeps the
                // selected entry -> exit orientation instead of randomly reversing it.
                let cmds = if rng.random::<f64>() < one_way_chance {
                    cmd_add_directed_teleport(source, destination, preset_state)
                } else {
                    cmd_add_bidirectional_teleport(source, destination, preset_state)
                };
                if cmds.is_empty() {
                    failed_attempts += 1;
                    continue;
                }
                commands.extend(cmds);
                proposed_pairs.insert((source, destination));
                added += 1;
                deficits.consume(&[area, RepairArea::WholeMaze]);
            }
            total_added += added;
        }
        if total_added == 0 {
            return (RepairResult::Failed, vec![]);
        }
        (RepairResult::Fixed { score: None }, commands)
    }
}

fn enum_param<'a>(params: &'a StrategyParams, id: &str, default: &'a str) -> &'a str {
    match params.get(id) {
        Some(StrategyParamValue::Enum(value)) => value.as_str(),
        _ => default,
    }
}

fn take_entry(
    pool: &mut Vec<NodeId>,
    mode: &str,
    dead_ends: &HashSet<NodeId>,
    rng: &mut dyn RngCore,
) -> NodeId {
    if mode == ENTRY_DEAD_END_PRIORITY {
        let choices: Vec<usize> = pool
            .iter()
            .enumerate()
            .filter(|&(_, &node)| dead_ends.contains(&node))
            .map(|(i, _)| i)
            .collect();
        if !choices.is_empty() {
            return pool.swap_remove(choices[rng.random_range(0..choices.len())]);
        }
    }
    pool.swap_remove(rng.random_range(0..pool.len()))
}

fn bfs_distances<T: Tessellation>(maze: &Maze<T>, source: NodeId) -> HashMap<NodeId, usize> {
    let mut distances = HashMap::from([(source, 0)]);
    let mut queue = VecDeque::from([(source, 0)]);
    while let Some((node, distance)) = queue.pop_front() {
        for next in maze.graph.outgoing_neighbors(node) {
            if let Entry::Vacant(entry) = distances.entry(next) {
                entry.insert(distance + 1);
                queue.push_back((next, distance + 1));
            }
        }
    }
    distances
}

#[allow(clippy::too_many_arguments)]
fn pick_exit<T: Tessellation>(
    maze: &Maze<T>,
    source: NodeId,
    distances: &HashMap<NodeId, usize>,
    min_length: usize,
    max_length: usize,
    allow_out_of_interval: bool,
    mode: &str,
    dead_ends: &HashSet<NodeId>,
    proposed_pairs: &HashSet<(NodeId, NodeId)>,
    all_nodes: &[NodeId],
    rng: &mut dyn RngCore,
) -> Option<NodeId> {
    let feasible = |&destination: &NodeId| {
        destination != source
            && distances.contains_key(&destination)
            && maze.graph.edge_between(source, destination).is_none()
            && maze.graph.edge_between(destination, source).is_none()
            && !proposed_pairs.contains(&(source, destination))
            && !proposed_pairs.contains(&(destination, source))
    };
    let in_interval: Vec<NodeId> = all_nodes
        .iter()
        .filter(|destination| feasible(destination))
        .filter(|&&n| (min_length..=max_length).contains(&distances[&n]))
        .copied()
        .collect();
    if let Some(destination) = pick_from_set(&in_interval, mode, dead_ends, rng) {
        return Some(destination);
    }
    if !allow_out_of_interval {
        return None;
    }
    let out_of_interval: Vec<NodeId> = all_nodes
        .iter()
        .filter(|destination| feasible(destination))
        .filter(|&&n| !(min_length..=max_length).contains(&distances[&n]))
        .copied()
        .collect();
    pick_from_set(&out_of_interval, mode, dead_ends, rng)
}

fn pick_from_set(
    set: &[NodeId],
    mode: &str,
    dead_ends: &HashSet<NodeId>,
    rng: &mut dyn RngCore,
) -> Option<NodeId> {
    if set.is_empty() {
        return None;
    }
    if mode == EXIT_DEAD_END_PRIORITY {
        let choices: Vec<NodeId> = set
            .iter()
            .copied()
            .filter(|n| dead_ends.contains(n))
            .collect();
        if !choices.is_empty() {
            return Some(choices[rng.random_range(0..choices.len())]);
        }
    }
    Some(set[rng.random_range(0..set.len())])
}

crate::impl_erased_repair_strategy!(MissingLoopsTeleportStrategy, MissingLoopsIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::{EdgeKind, Graph};
    use crate::random::MazeRng;
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};
    use rand::SeedableRng;

    fn maze_grid(side: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(side, side), &mut ids).unwrap();
        let nodes: Vec<_> = field.all_node_ids().collect();
        let mut graph = Graph::new();
        for &node in &nodes {
            graph.add_node(node);
        }
        for pair in nodes.windows(2) {
            graph.add_bidirectional_edge(pair[0], pair[1], EdgeKind::Basic);
        }
        Maze::new(field, graph)
    }

    fn strategy_params(overrides: &[(&str, &str)]) -> StrategyParams {
        let overrides = overrides
            .iter()
            .map(|&(k, v)| (k.to_string(), v.to_string()))
            .collect();
        build_params(
            <MissingLoopsTeleportStrategy as RepairStrategy<
                SquareTessellation,
                MissingLoopsIssue,
            >>::params(&MissingLoopsTeleportStrategy),
            Some(&overrides),
        )
    }

    fn apply_with(
        maze: &mut Maze<SquareTessellation>,
        overrides: &[(&str, &str)],
        seed: u64,
    ) -> RepairResult {
        let mut rng = MazeRng::seed_from_u64(seed);
        apply_and_commit(
            &MissingLoopsTeleportStrategy,
            &MissingLoopsIssue::new_from_check("min_loops_count", vec![(RepairArea::WholeMaze, 1)]),
            maze,
            &mut rng,
            &strategy_params(overrides),
            &PresetState::empty(),
            &[],
        )
    }

    #[test]
    fn default_entry_and_exit_selection_can_seed_a_bidirectional_teleport() {
        let mut maze = maze_grid(3);
        assert!(matches!(
            apply_with(&mut maze, &[(PARAM_ONE_WAY_CHANCE, "0")], 7),
            RepairResult::Fixed { .. }
        ));
        assert_eq!(
            maze.graph
                .edges()
                .filter(|e| e.kind == EdgeKind::Teleport)
                .count(),
            2
        );
    }

    #[test]
    fn one_way_chance_is_percent_and_keeps_entry_to_exit_direction() {
        let mut maze = maze_grid(3);
        assert!(matches!(
            apply_with(&mut maze, &[(PARAM_ONE_WAY_CHANCE, "100")], 8),
            RepairResult::Fixed { .. }
        ));
        assert_eq!(
            maze.graph
                .edges()
                .filter(|e| e.kind == EdgeKind::Teleport)
                .count(),
            1
        );
    }

    #[test]
    fn unreachable_nodes_are_not_eligible_exits() {
        let mut maze = maze_grid(3);
        let nodes: Vec<_> = maze.field.all_node_ids().collect();
        let unreachable = *nodes.last().unwrap();
        let incoming = maze
            .graph
            .incoming_neighbors(unreachable)
            .collect::<Vec<_>>();
        for node in incoming {
            let id = maze.graph.edge_between(node, unreachable).unwrap();
            maze.graph.remove_edge(id);
        }
        assert!(matches!(
            apply_with(
                &mut maze,
                &[
                    (PARAM_ENTRY_PICK, ENTRY_RANDOM),
                    (PARAM_EXIT_PICK, EXIT_RANDOM)
                ],
                9
            ),
            RepairResult::Fixed { .. }
        ));
        assert!(
            maze.graph
                .edges()
                .filter(|e| e.kind == EdgeKind::Teleport)
                .all(|e| e.to != unreachable)
        );
    }

    #[test]
    fn out_of_interval_can_be_disabled() {
        let mut maze = maze_grid(3);
        assert!(matches!(
            apply_with(
                &mut maze,
                &[
                    (PARAM_ENTRY_PICK, ENTRY_RANDOM),
                    (PARAM_EXIT_PICK, EXIT_RANDOM),
                    (PARAM_DESIRED_LENGTH, "99,99"),
                    (PARAM_ALLOW_OUT_OF_INTERVAL, "false")
                ],
                10
            ),
            RepairResult::Failed
        ));
        assert!(!maze.graph.edges().any(|e| e.kind == EdgeKind::Teleport));
    }
}
