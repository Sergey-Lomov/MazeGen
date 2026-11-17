use super::elevator_utils::find_elevator_by_stop;
use crate::Maze;
use crate::generation::PresetState;
use crate::generation::edge_ops::bidirectional_edge_feasible;
use crate::ids::NodeId;
use crate::quality_control::ExcessiveElevatorStopGapIssue;
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::RngCore;
use rand::seq::SliceRandom;

static PARAMS: &[StrategyParam] = &[];

/// Handles `EXCESSIVE_ELEVATOR_STOP_GAP` -- see GitHub issue #402, part of epic #344. For each
/// `missing` entry (one existing elevator and one over-large gap's bottom/top floor), picks a
/// random floor strictly between them and adds it as a stop, wired to every one of the elevator's
/// *current* stops (existing ones and any already added earlier in the same `apply` call) --
/// mirrors `AddElevatorStopCountStrategy`'s fan-wiring.
///
/// The elevator named by an entry is re-resolved against the live `maze` via
/// `elevator_utils::find_elevator_by_stop` rather than trusted from the issue's stale
/// `ElevatorNodes` snapshot. An entry whose elevator no longer exists, or whose `lo`/`hi` floor no
/// longer resolves to a node on the elevator's point, is skipped. **Partial success counts as
/// success** -- one entry failing to place a stop doesn't fail the whole strategy, only a complete
/// failure across every entry does.
pub struct AddElevatorStopForGapStrategy;

impl<T: Tessellation> RepairStrategy<T, ExcessiveElevatorStopGapIssue>
    for AddElevatorStopForGapStrategy
{
    fn strategy_id(&self) -> &'static str {
        "add_elevator_stop_for_gap"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &ExcessiveElevatorStopGapIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        _params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let mut commands = Vec::new();
        let mut total_added: u32 = 0;

        for (elevator_key, lo, hi) in &issue.missing {
            let Some(&any_stop) = elevator_key.0.first() else {
                continue;
            };
            let Some(elevator) = find_elevator_by_stop(maze, any_stop) else {
                continue;
            };
            let Some(point) = elevator.stops.first().and_then(|&n| maze.field.cell_of(n)) else {
                continue;
            };
            let Some(lo_idx) = maze
                .field
                .node_at(*lo, point)
                .and_then(|n| maze.field.level_index_of(n))
            else {
                continue;
            };
            let Some(hi_idx) = maze
                .field
                .node_at(*hi, point)
                .and_then(|n| maze.field.level_index_of(n))
            else {
                continue;
            };

            let current_stops: Vec<NodeId> = elevator.stops.clone();
            let mut candidates: Vec<_> = maze
                .field
                .levels_ordered()
                .filter_map(|level| {
                    let node = maze.field.node_at(level, point)?;
                    if current_stops.contains(&node) {
                        return None;
                    }
                    let idx = maze.field.level_index_of(node)?;
                    (idx > lo_idx && idx < hi_idx).then_some(node)
                })
                .collect();
            candidates.shuffle(rng);

            let Some(&node) = candidates
                .iter()
                .find(|&&n| stop_feasible(maze, n, &current_stops, preset_state))
            else {
                continue;
            };
            for &other in &current_stops {
                commands.push(MutationCommand::AddBidirectionalElevator { a: node, b: other });
            }
            total_added += 1;
        }

        if total_added == 0 {
            return (RepairResult::Failed, vec![]);
        }
        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(AddElevatorStopForGapStrategy, ExcessiveElevatorStopGapIssue);

fn stop_feasible<T: Tessellation>(
    maze: &Maze<T>,
    candidate: NodeId,
    current_stops: &[NodeId],
    preset_state: &PresetState,
) -> bool {
    current_stops.iter().all(|&other| {
        maze.graph.edge_between(candidate, other).is_none()
            && maze.graph.edge_between(other, candidate).is_none()
            && bidirectional_edge_feasible(preset_state, candidate, other)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::{EdgeKind, Graph};
    use crate::quality_control::checks::elevator_core::elevator_groups;
    use crate::quality_control::issue_kinds::ElevatorNodes;
    use crate::random::MazeRng;
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;
    use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use rand::SeedableRng;
    use std::sync::Arc;

    fn no_params() -> StrategyParams {
        build_params(
            <AddElevatorStopForGapStrategy as RepairStrategy<
                SquareTessellation,
                ExcessiveElevatorStopGapIssue,
            >>::params(&AddElevatorStopForGapStrategy),
            None,
        )
    }

    fn maze_with_elevator(
        floor_count: usize,
        stop_floor_indices: &[usize],
    ) -> (
        Maze<SquareTessellation>,
        Vec<NodeId>,
        Vec<crate::space::LevelId>,
    ) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let floors: Vec<_> = (0..floor_count)
            .map(|_| {
                mf.add_level(
                    Field::<SquareTessellation>::new(Arc::default(), square_rect(1, 1), &mut ids)
                        .unwrap(),
                )
            })
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = stop_floor_indices
            .iter()
            .map(|&i| mf.node_at(floors[i], SquarePoint { x: 0, y: 0 }).unwrap())
            .collect();
        for i in 0..nodes.len() {
            for j in (i + 1)..nodes.len() {
                g.add_edge(nodes[i], nodes[j], EdgeKind::Elevator);
                g.add_edge(nodes[j], nodes[i], EdgeKind::Elevator);
            }
        }
        (Maze::new(mf, g), nodes, floors)
    }

    #[test]
    fn apply_adds_a_stop_strictly_between_lo_and_hi() {
        let (mut maze, nodes, floors) = maze_with_elevator(6, &[0, 5]);
        let issue = ExcessiveElevatorStopGapIssue::new_from_check(
            "max_elevator_stop_gap",
            vec![(ElevatorNodes::new(nodes.clone()), floors[0], floors[5])],
        );
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &AddElevatorStopForGapStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let groups = elevator_groups(&maze);
        assert_eq!(groups[0].stops.len(), 3);
        let new_stop = groups[0]
            .stops
            .iter()
            .find(|&&n| n != nodes[0] && n != nodes[1])
            .unwrap();
        let idx = maze.field.level_index_of(*new_stop).unwrap();
        assert!(idx > 0 && idx < 5);
    }

    #[test]
    fn apply_fails_when_no_floor_between_lo_and_hi_is_feasible() {
        let (mut maze, nodes, floors) = maze_with_elevator(3, &[0, 2]);
        let blocked = maze
            .field
            .node_at(floors[1], SquarePoint { x: 0, y: 0 })
            .unwrap();
        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(blocked);

        let issue = ExcessiveElevatorStopGapIssue::new_from_check(
            "max_elevator_stop_gap",
            vec![(ElevatorNodes::new(nodes), floors[0], floors[2])],
        );
        let mut rng = MazeRng::seed_from_u64(2);
        let result = apply_and_commit(
            &AddElevatorStopForGapStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &preset_state,
            &[],
        );
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_skips_an_entry_whose_elevator_no_longer_exists() {
        let (mut maze, nodes, floors) = maze_with_elevator(6, &[0, 5]);
        maze.graph
            .remove_edge(maze.graph.edge_between(nodes[0], nodes[1]).unwrap());
        maze.graph
            .remove_edge(maze.graph.edge_between(nodes[1], nodes[0]).unwrap());

        let issue = ExcessiveElevatorStopGapIssue::new_from_check(
            "max_elevator_stop_gap",
            vec![(ElevatorNodes::new(nodes), floors[0], floors[5])],
        );
        let mut rng = MazeRng::seed_from_u64(3);
        let result = apply_and_commit(
            &AddElevatorStopForGapStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Failed));
    }
}
