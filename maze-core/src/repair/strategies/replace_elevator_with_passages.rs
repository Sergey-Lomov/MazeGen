use rand::RngCore;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::quality_control::InvalidElevatorIssue;
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use crate::quality_control::checks::elevator_core::{elevator_groups, Elevator};

pub const PARAM_ADJACENT_FLOORS_ONLY: &str = "adjacent_floors_only";

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_ADJACENT_FLOORS_ONLY,
        label: "Adjacent floors only",
        kind: StrategyParamKind::Bool { default: true },
    },
];

/// Handles `INVALID_ELEVATOR` — see GitHub issue #397. Replaces each flagged elevator with
/// sequential two-way `VerticalPassage` edges, then removes the elevator's own fan edges.
///
/// `adjacent_floors_only` (default `true`):
/// - ON: a passage is added only between pairs of the elevator's own stops that are genuinely
///   floor-adjacent (consecutive floor indices, not merely consecutive entries in the sorted stop
///   list) — an elevator whose stops skip a floor (e.g. floors 1 and 5) produces no passage at all
///   for that gap, never a single passage spanning the gap.
/// - OFF: passages are added from the bottommost to the topmost stop, stepping through every floor
///   level in between (`maze.field.levels_ordered()`), including floors the elevator never stopped
///   at. A floor where the point has no node (see `MultiLevelField::node_at`) is simply skipped —
///   both the passage into it and out of it are dropped, the chain does not reconnect around the
///   gap.
pub struct ReplaceElevatorWithPassagesStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidElevatorIssue> for ReplaceElevatorWithPassagesStrategy {
    fn strategy_id(&self) -> &'static str { "replace_elevator_with_passages" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &InvalidElevatorIssue,
        maze: &Maze<T>,
        _rng: &mut dyn RngCore,
        params: &StrategyParams,
        _preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let adjacent_floors_only = !matches!(params.get(PARAM_ADJACENT_FLOORS_ONLY), Some(StrategyParamValue::Bool(false)));

        let current = elevator_groups(maze);
        let mut commands = Vec::new();
        let mut any = false;

        for flagged in &issue.invalid {
            let mut stops = flagged.0.clone();
            stops.sort_unstable();
            let Some(elevator) = current.iter().find(|e| {
                let mut current_stops = e.stops.clone();
                current_stops.sort_unstable();
                current_stops == stops
            }) else {
                continue;
            };

            // A single-stop elevator has no fan edges at all (the fan needs >=2 nodes) — nothing
            // to remove or replace, so it's skipped entirely rather than reported fixed.
            if elevator.edges.is_empty() {
                continue;
            }

            let pairs = if adjacent_floors_only {
                own_stops_adjacent_pairs(maze, elevator)
            } else {
                full_floor_span_pairs(maze, elevator)
            };
            // Remove the elevator's own edges first — `try_add_bidirectional_vertical_passage`'s
            // `edge_between` check isn't kind-gated, so a still-present `Elevator` edge between a
            // chain pair would make it silently skip adding the `VerticalPassage`. The elevator is
            // removed even when `pairs` is empty (e.g. `adjacent_floors_only` with no floor-
            // adjacent stop pair at all) — the elevator must still vanish, never survive with a
            // spanning passage it was never meant to have.
            for &id in &elevator.edges {
                commands.push(MutationCommand::RemoveEdgeWithReverse { id });
            }
            for (a, b) in pairs {
                commands.push(MutationCommand::AddBidirectionalVerticalPassage { a, b });
            }
            any = true;
        }

        if !any {
            return (RepairResult::Failed, vec![]);
        }
        (RepairResult::Fixed { score: None }, commands)
    }
}

/// Pairs of the elevator's own stops that are genuinely floor-adjacent (consecutive floor
/// indices) — used for `adjacent_floors_only = true`. A gap in the elevator's own stop floors
/// (e.g. stops at floors 1 and 5) produces no pair at all for that gap, never a pair spanning it.
fn own_stops_adjacent_pairs<T: Tessellation>(maze: &Maze<T>, elevator: &Elevator) -> Vec<(NodeId, NodeId)> {
    let mut by_floor: Vec<(usize, NodeId)> = elevator.stops.iter()
        .filter_map(|&n| maze.field.level_index_of(n).map(|idx| (idx, n)))
        .collect();
    by_floor.sort_unstable_by_key(|&(idx, _)| idx);
    by_floor.windows(2)
        .filter(|w| w[1].0 == w[0].0 + 1)
        .map(|w| (w[0].1, w[1].1))
        .collect()
}

/// Pairs spanning every floor from the elevator's bottommost to topmost stop, one pair per
/// adjacent floor step — used for `adjacent_floors_only = false`. A floor where the elevator's
/// point has no node (see `MultiLevelField::node_at`) drops both the pair into it and the pair out
/// of it; the chain does not reconnect around the gap.
fn full_floor_span_pairs<T: Tessellation>(maze: &Maze<T>, elevator: &Elevator) -> Vec<(NodeId, NodeId)> {
    let Some(&first) = elevator.stops.first() else { return vec![] };
    let Some(point) = maze.field.point_of(first) else { return vec![] };

    let mut floor_indices: Vec<usize> = elevator.stops.iter()
        .filter_map(|&n| maze.field.level_index_of(n))
        .collect();
    floor_indices.sort_unstable();
    let (Some(&bottom), Some(&top)) = (floor_indices.first(), floor_indices.last()) else { return vec![] };

    let nodes_by_floor: Vec<Option<NodeId>> = maze.field.levels_ordered()
        .enumerate()
        .filter(|&(idx, _)| idx >= bottom && idx <= top)
        .map(|(_, level)| maze.field.node_at(level, point.clone()))
        .collect();
    nodes_by_floor.windows(2)
        .filter_map(|w| match (w[0], w[1]) {
            (Some(a), Some(b)) => Some((a, b)),
            _ => None,
        })
        .collect()
}

crate::impl_erased_repair_strategy!(ReplaceElevatorWithPassagesStrategy, InvalidElevatorIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, MultiLevelField, SquareTessellation, SquarePoint, square_rect};
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;
    use crate::quality_control::issue_kinds::ElevatorNodes;

    fn no_params() -> StrategyParams {
        build_params(<ReplaceElevatorWithPassagesStrategy as RepairStrategy<SquareTessellation, InvalidElevatorIssue>>::params(&ReplaceElevatorWithPassagesStrategy), None)
    }

    fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
        let mut map = HashMap::new();
        for &(k, v) in overrides {
            map.insert(k.to_string(), v.to_string());
        }
        build_params(<ReplaceElevatorWithPassagesStrategy as RepairStrategy<SquareTessellation, InvalidElevatorIssue>>::params(&ReplaceElevatorWithPassagesStrategy), Some(&map))
    }

    fn n_floor_maze(count: usize) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..count)
            .map(|_| mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap()))
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = floors.iter().map(|&l| mf.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap()).collect();
        (Maze::new(mf, g), nodes)
    }

    fn connect_fan(maze: &mut Maze<SquareTessellation>, nodes: &[crate::ids::NodeId]) {
        for i in 0..nodes.len() {
            for j in (i + 1)..nodes.len() {
                maze.graph.add_edge(nodes[i], nodes[j], EdgeKind::Elevator);
                maze.graph.add_edge(nodes[j], nodes[i], EdgeKind::Elevator);
            }
        }
    }

    #[test]
    fn adjacent_floors_only_default_connects_only_the_elevators_own_consecutive_stops() {
        let (mut maze, nodes) = n_floor_maze(4);
        // Elevator stops at floors 0, 1, 3 — 0/1 are floor-adjacent, 1/3 are not.
        let stops = vec![nodes[0], nodes[1], nodes[3]];
        connect_fan(&mut maze, &stops);
        let issue = InvalidElevatorIssue::new_from_check("test", vec![ElevatorNodes::new(stops.clone())]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&ReplaceElevatorWithPassagesStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(!maze.graph.edges().any(|e| e.kind == EdgeKind::Elevator));
        // Only the floor-adjacent pair 0<->1 gets a passage; 1<->3 is not floor-adjacent, so no
        // passage spans that gap at all (never a direct 1<->3 shortcut).
        assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_some());
        assert!(maze.graph.edge_between(nodes[1], nodes[3]).is_none());
        assert!(maze.graph.edge_between(nodes[0], nodes[3]).is_none());
        assert!(!maze.graph.edges().any(|e| e.from == nodes[2] || e.to == nodes[2]));
    }

    #[test]
    fn adjacent_floors_only_with_no_adjacent_pair_at_all_removes_elevator_without_adding_any_passage() {
        // Elevator stops at floors 1 and 5 (0-based) — no floor-adjacent pair exists among its
        // own stops, so the elevator must simply vanish, never get a passage spanning the gap.
        let (mut maze, nodes) = n_floor_maze(6);
        let stops = vec![nodes[1], nodes[5]];
        connect_fan(&mut maze, &stops);
        let issue = InvalidElevatorIssue::new_from_check("test", vec![ElevatorNodes::new(stops.clone())]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&ReplaceElevatorWithPassagesStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(!maze.graph.edges().any(|e| e.kind == EdgeKind::Elevator));
        assert!(maze.graph.edge_between(nodes[1], nodes[5]).is_none());
    }

    #[test]
    fn adjacent_floors_only_false_spans_every_intervening_floor() {
        let (mut maze, nodes) = n_floor_maze(4);
        let stops = vec![nodes[0], nodes[3]];
        connect_fan(&mut maze, &stops);
        let issue = InvalidElevatorIssue::new_from_check("test", vec![ElevatorNodes::new(stops.clone())]);
        let params = params_with(&[(PARAM_ADJACENT_FLOORS_ONLY, "false")]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&ReplaceElevatorWithPassagesStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_some());
        assert!(maze.graph.edge_between(nodes[1], nodes[2]).is_some());
        assert!(maze.graph.edge_between(nodes[2], nodes[3]).is_some());
        assert!(maze.graph.edge_between(nodes[0], nodes[3]).is_none(), "must chain through intervening floors, not jump directly");
    }

    #[test]
    fn adjacent_floors_only_false_skips_both_edges_around_a_missing_intervening_node() {
        // Field: 5 floors, stops at floor 0 and floor 4, but floor 2's field doesn't include the
        // point (0, 0) at all (unlike every other floor) — so `node_at` returns `None` there. The
        // chain must skip both the 1<->2 and 2<->3 edges around the gap, never reconnect 1<->3
        // directly.
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..5)
            .map(|i| {
                let points = if i == 2 { vec![SquarePoint { x: 1, y: 0 }] } else { square_rect(2, 1) };
                mf.add_level(Field::<SquareTessellation>::new(points, &mut ids).unwrap())
            })
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let node_at_floor = |i: usize| mf.node_at(floors[i], SquarePoint { x: 0, y: 0 }).unwrap();
        let n0 = node_at_floor(0);
        let n1 = node_at_floor(1);
        let n3 = node_at_floor(3);
        let n4 = node_at_floor(4);

        let mut maze: Maze<SquareTessellation> = Maze::new(mf, g.clone());
        let stops = vec![n0, n4];
        connect_fan(&mut maze, &stops);
        let issue = InvalidElevatorIssue::new_from_check("test", vec![ElevatorNodes::new(stops.clone())]);
        let params = params_with(&[(PARAM_ADJACENT_FLOORS_ONLY, "false")]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&ReplaceElevatorWithPassagesStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edge_between(n0, n1).is_some());
        assert!(maze.graph.edge_between(n3, n4).is_some());
        assert!(maze.graph.edge_between(n1, n3).is_none(), "must not jump across the missing floor 2 node");
        assert!(maze.graph.edge_between(n0, n4).is_none());
        let _ = g;
    }

    #[test]
    fn apply_fails_when_no_flagged_elevator_still_exists() {
        let (mut maze, _nodes) = n_floor_maze(3);
        let issue = InvalidElevatorIssue::new_from_check("test", vec![]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&ReplaceElevatorWithPassagesStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn single_stop_elevator_produces_no_passages_but_still_removed() {
        // Degenerate case: an elevator with a single surviving stop (e.g. already partially
        // repaired) has no pair to connect -- must be skipped without panicking, not fail overall
        // if other flagged elevators do produce commands. Here it's the only one, so overall fails.
        let (mut maze, nodes) = n_floor_maze(3);
        let stops = vec![nodes[0]];
        let issue = InvalidElevatorIssue::new_from_check("test", vec![ElevatorNodes::new(stops)]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&ReplaceElevatorWithPassagesStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed));
    }
}
