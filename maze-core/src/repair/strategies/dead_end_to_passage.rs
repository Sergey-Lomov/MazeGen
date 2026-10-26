use crate::Maze;
use crate::generation::PresetState;
use crate::generation::{cmd_add_bidirectional_edge, cmd_add_directed_edge};
use crate::ids::NodeId;
use crate::quality_control::InvalidDeadEndGroupIssue;
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::seq::SliceRandom;
use rand::{Rng, RngCore};
use std::collections::{HashMap, HashSet};

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

/// Handles `INVALID_DEAD_END_GROUP` by extending selected dead ends with one new geometric
/// `Basic` passage each. The issue's `to_remove` value determines how many candidates to process
/// from every group; a later QC pass evaluates the resulting topology again.
///
/// `dead_end_one_way_chance` is the percentage chance that a new passage is one-way. A one-way
/// passage always points from the dead end to its new neighbor: the reverse direction would leave
/// the source with its original single outgoing edge and therefore fail to remove the dead end.
/// The default, `0.0`, adds bidirectional passages.
///
/// Candidate destinations exclude every node flagged by this issue. This prevents a new passage
/// from incidentally changing another selected dead end, so every successful source receives
/// exactly one added passage. A source repeated by overlapping groups is also processed only once.
/// Sources that appear in more groups are tried first, so one passage can retire the quota of
/// every group it belongs to before a group-specific source is considered.
pub struct DeadEndToPassageStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidDeadEndGroupIssue> for DeadEndToPassageStrategy {
    fn strategy_id(&self) -> &'static str {
        "dead_end_to_passage"
    }

    fn params(&self) -> &'static [StrategyParam] {
        &PARAMS
    }

    fn apply(
        &self,
        issue: &InvalidDeadEndGroupIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let one_way_chance = params
            .get(PARAM_ONE_WAY_CHANCE)
            .and_then(|value| value.as_float())
            .unwrap_or(0.0)
            / 100.0;
        let mut memberships = HashMap::new();
        for (nodes, _) in &issue.groups {
            for &node in nodes {
                *memberships.entry(node).or_insert(0usize) += 1;
            }
        }
        let dead_ends: HashSet<NodeId> = memberships.keys().copied().collect();
        let mut remaining: Vec<u32> = issue
            .groups
            .iter()
            .map(|(_, to_remove)| *to_remove)
            .collect();
        let mut processed_dead_ends = HashSet::new();
        let mut commands = Vec::new();

        for (group_index, (nodes, _)) in issue.groups.iter().enumerate() {
            let mut candidates = nodes.clone();
            candidates.shuffle(rng);
            candidates.sort_by_key(|src| memberships.get(src).copied().unwrap_or_default());

            while remaining[group_index] > 0 {
                let Some(src) = candidates.pop() else {
                    break;
                };
                if processed_dead_ends.contains(&src) {
                    continue;
                }
                let mut neighbors = maze.field.neighbors(src);
                neighbors.shuffle(rng);

                for dst in neighbors {
                    if dead_ends.contains(&dst)
                        || maze.graph.edge_between(src, dst).is_some()
                        || maze.graph.edge_between(dst, src).is_some()
                    {
                        continue;
                    }

                    let added = if rng.random::<f64>() < one_way_chance {
                        cmd_add_directed_edge(src, dst, preset_state)
                    } else {
                        cmd_add_bidirectional_edge(src, dst, preset_state)
                    };
                    if added.is_empty() {
                        continue;
                    }
                    commands.extend(added);
                    processed_dead_ends.insert(src);
                    for (remaining, (group_nodes, _)) in remaining.iter_mut().zip(&issue.groups) {
                        if group_nodes.contains(&src) {
                            *remaining = remaining.saturating_sub(1);
                        }
                    }
                    break;
                }
            }
        }

        if commands.is_empty() {
            (RepairResult::Failed, commands)
        } else {
            (RepairResult::Fixed { score: None }, commands)
        }
    }
}

crate::impl_erased_repair_strategy!(DeadEndToPassageStrategy, InvalidDeadEndGroupIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::{EdgeKind, Graph};
    use crate::random::MazeRng;
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use rand::SeedableRng;
    use std::collections::HashMap;
    use std::sync::Arc;

    fn maze() -> (Maze<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 2), &mut ids).unwrap();
        let level = field.single_level_id();
        let mut nodes = Vec::new();
        for y in 0..2 {
            for x in 0..3 {
                nodes.push(field.node_at(level, SquarePoint { x, y }).unwrap());
            }
        }
        let mut graph = Graph::new();
        for &node in &nodes {
            graph.add_node(node);
        }
        (Maze::new(field, graph), nodes)
    }

    fn issue(nodes: Vec<NodeId>, to_remove: u32) -> InvalidDeadEndGroupIssue {
        InvalidDeadEndGroupIssue::new_from_check("max_dead_end_count", vec![(nodes, to_remove)])
    }

    fn params(overrides: Option<&HashMap<String, String>>) -> StrategyParams {
        build_params(
            <DeadEndToPassageStrategy as RepairStrategy<
                SquareTessellation,
                InvalidDeadEndGroupIssue,
            >>::params(&DeadEndToPassageStrategy),
            overrides,
        )
    }

    fn add_passage(maze: &mut Maze<SquareTessellation>, a: NodeId, b: NodeId) {
        maze.graph.add_edge(a, b, EdgeKind::Basic);
        maze.graph.add_edge(b, a, EdgeKind::Basic);
    }

    #[test]
    fn adds_one_bidirectional_passage_per_processed_dead_end_by_default() {
        let (mut maze, nodes) = maze();
        add_passage(&mut maze, nodes[0], nodes[1]);
        add_passage(&mut maze, nodes[1], nodes[2]);
        let original_edges = maze.graph.edges().count();
        let mut rng = MazeRng::seed_from_u64(4);

        let result = apply_and_commit(
            &DeadEndToPassageStrategy,
            &issue(vec![nodes[0], nodes[2]], 2),
            &mut maze,
            &mut rng,
            &params(None),
            &PresetState::empty(),
            &[],
        );

        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), original_edges + 4);
        for &node in &[nodes[0], nodes[2]] {
            assert_eq!(maze.graph.outgoing_edges(node).count(), 2);
        }
    }

    #[test]
    fn one_way_passages_always_point_outward_from_the_dead_end() {
        let (mut maze, nodes) = maze();
        add_passage(&mut maze, nodes[0], nodes[1]);
        let mut overrides = HashMap::new();
        overrides.insert(PARAM_ONE_WAY_CHANCE.to_string(), "100".to_string());
        let mut rng = MazeRng::seed_from_u64(7);

        let result = apply_and_commit(
            &DeadEndToPassageStrategy,
            &issue(vec![nodes[0]], 1),
            &mut maze,
            &mut rng,
            &params(Some(&overrides)),
            &PresetState::empty(),
            &[],
        );

        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.outgoing_edges(nodes[0]).count(), 2);
        let new_edge = maze
            .graph
            .outgoing_edges(nodes[0])
            .find(|edge| edge.to != nodes[1])
            .expect("the added passage must leave the processed dead end");
        assert!(maze.graph.edge_between(new_edge.to, nodes[0]).is_none());
    }

    #[test]
    fn never_uses_another_flagged_dead_end_as_a_destination() {
        let (mut maze, nodes) = maze();
        // Nodes 1 and 4 are geometric neighbors as well as dead ends. Each has a separate free
        // neighbor, so the repair can succeed without joining the two flagged sources together.
        add_passage(&mut maze, nodes[0], nodes[1]);
        add_passage(&mut maze, nodes[3], nodes[4]);
        let mut rng = MazeRng::seed_from_u64(11);

        let result = apply_and_commit(
            &DeadEndToPassageStrategy,
            &issue(vec![nodes[1], nodes[4]], 2),
            &mut maze,
            &mut rng,
            &params(None),
            &PresetState::empty(),
            &[],
        );

        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edge_between(nodes[1], nodes[4]).is_none());
        assert!(maze.graph.edge_between(nodes[4], nodes[1]).is_none());
    }

    #[test]
    fn never_processes_a_dead_end_twice_when_groups_overlap() {
        let (mut maze, nodes) = maze();
        add_passage(&mut maze, nodes[0], nodes[1]);
        let issue = InvalidDeadEndGroupIssue::new_from_check(
            "max_dead_end_count",
            vec![(vec![nodes[0]], 1), (vec![nodes[0]], 1)],
        );
        let original_edges = maze.graph.edges().count();
        let mut rng = MazeRng::seed_from_u64(1);

        let result = apply_and_commit(
            &DeadEndToPassageStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params(None),
            &PresetState::empty(),
            &[],
        );

        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), original_edges + 2);
    }

    #[test]
    fn a_shared_dead_end_reduces_every_group_it_belongs_to() {
        let (mut maze, nodes) = maze();
        add_passage(&mut maze, nodes[0], nodes[1]);
        add_passage(&mut maze, nodes[2], nodes[5]);
        let issue = InvalidDeadEndGroupIssue::new_from_check(
            "max_dead_end_count",
            vec![(vec![nodes[0], nodes[2]], 1), (vec![nodes[0]], 1)],
        );
        let original_edges = maze.graph.edges().count();
        let mut rng = MazeRng::seed_from_u64(3);

        let result = apply_and_commit(
            &DeadEndToPassageStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params(None),
            &PresetState::empty(),
            &[],
        );

        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), original_edges + 2);
        assert_eq!(maze.graph.outgoing_edges(nodes[2]).count(), 1);
    }

    #[test]
    fn fails_when_every_new_passage_is_preset_blocked() {
        let (mut maze, nodes) = maze();
        add_passage(&mut maze, nodes[0], nodes[1]);
        let mut preset = PresetState::empty();
        preset.blocked.insert((nodes[0], nodes[3]));
        preset.blocked.insert((nodes[3], nodes[0]));
        let mut rng = MazeRng::seed_from_u64(2);

        let result = apply_and_commit(
            &DeadEndToPassageStrategy,
            &issue(vec![nodes[0]], 1),
            &mut maze,
            &mut rng,
            &params(None),
            &preset,
            &[],
        );

        assert!(matches!(result, RepairResult::Failed));
    }
}
