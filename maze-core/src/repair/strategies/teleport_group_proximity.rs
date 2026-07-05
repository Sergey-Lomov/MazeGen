use std::collections::HashMap;
use rand::{Rng, RngCore};
use crate::Maze;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::quality_control::{Issue, IssueData, TELEPORT_GROUP_PROXIMITY, IssueKind};
use crate::generation::{PresetState, try_remove_edge_by_id};
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::snapshot::SnapshotStack;

pub const PARAM_PRIORITY: &str = "priority";

pub const PRIORITY_RANDOM: &str = "random";
pub const PRIORITY_PROBLEMATIC: &str = "problematic";

static PRIORITY_OPTIONS: &[&str] = &[PRIORITY_RANDOM, PRIORITY_PROBLEMATIC];

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_PRIORITY,
        label: "Removal priority",
        kind: StrategyParamKind::Enum { options: PRIORITY_OPTIONS, default: PRIORITY_PROBLEMATIC },
    },
];

/// Handles `TELEPORT_GROUP_PROXIMITY` — see GitHub issue #75. For each problematic pair flagged by
/// `TeleportGroupProximityCheck`, removes one of the two teleport edges: removing a teleport
/// immediately drops every problematic pair that references it, so a pair already resolved by an
/// earlier removal in the same `apply()` call is skipped rather than acted on twice.
///
/// **`issue.data` is mandatory for this kind**: `IssueData::TeleportProximityPairs { pairs }` is
/// the producing check's result — there is no other channel to learn which edges are paired.
pub struct TeleportGroupProximityStrategy;

impl<T: Tessellation> RepairStrategy<T> for TeleportGroupProximityStrategy {
    fn strategy_id(&self) -> &'static str { "teleport_group_proximity" }
    fn handles(&self) -> IssueKind { TELEPORT_GROUP_PROXIMITY }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &Issue,
        maze: &mut Maze<T>,
        _snapshots: &mut SnapshotStack,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> RepairResult {
        debug_assert_eq!(issue.kind, <Self as RepairStrategy<T>>::handles(self));
        let Some(IssueData::TeleportProximityPairs { pairs }) = &issue.data else {
            return RepairResult::Failed;
        };
        if pairs.is_empty() {
            return RepairResult::Fixed { score: None };
        }

        let priority = match params.get(PARAM_PRIORITY) {
            Some(StrategyParamValue::Enum(v)) => v.as_str(),
            _ => PRIORITY_PROBLEMATIC,
        };

        // Membership counts computed once up front, over the original (unresolved) pair set —
        // "belongs to more other problematic pairs" is a snapshot of the check's findings, not a
        // running count that would otherwise favor whichever edge happens to be processed first.
        let mut membership: HashMap<EdgeId, usize> = HashMap::new();
        for &(a, b) in pairs {
            *membership.entry(a).or_insert(0) += 1;
            *membership.entry(b).or_insert(0) += 1;
        }

        let mut removed: std::collections::HashSet<EdgeId> = std::collections::HashSet::new();
        for &(a, b) in pairs {
            // Removing a teleport drops every pair referencing it — if either side of this pair
            // was already removed while resolving an earlier pair, this one is already resolved.
            if removed.contains(&a) || removed.contains(&b) {
                continue;
            }
            let to_remove = match priority {
                PRIORITY_PROBLEMATIC => {
                    let count_a = membership.get(&a).copied().unwrap_or(0);
                    let count_b = membership.get(&b).copied().unwrap_or(0);
                    if count_a > count_b { a }
                    else if count_b > count_a { b }
                    else if rng.random_bool(0.5) { a } else { b }
                }
                _ => if rng.random_bool(0.5) { a } else { b },
            };
            try_remove_edge_by_id(&mut maze.graph, to_remove, preset_state);
            removed.insert(to_remove);
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

    fn params_with_priority(priority: &str) -> StrategyParams {
        let mut overrides = HashMap::new();
        overrides.insert(PARAM_PRIORITY.to_string(), priority.to_string());
        crate::repair::params::build_params(
            <TeleportGroupProximityStrategy as RepairStrategy<SquareTessellation>>::params(&TeleportGroupProximityStrategy),
            Some(&overrides),
        )
    }

    fn maze_with_two_teleports() -> (Maze<SquareTessellation>, EdgeId, EdgeId) {
        let mut ids = IdGenerator::new();
        let field = crate::space::Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
        let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
        (Maze::new(field, g), id_a, id_b)
    }

    #[test]
    fn apply_fails_when_data_is_missing() {
        let (mut maze, _, _) = maze_with_two_teleports();
        let issue = Issue::new(TELEPORT_GROUP_PROXIMITY);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = TeleportGroupProximityStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &params_with_priority(PRIORITY_RANDOM), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_succeeds_on_empty_pairs() {
        let (mut maze, _, _) = maze_with_two_teleports();
        let issue = Issue::with_data(TELEPORT_GROUP_PROXIMITY, IssueData::TeleportProximityPairs { pairs: vec![] });
        let mut rng = MazeRng::seed_from_u64(1);
        let result = TeleportGroupProximityStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &params_with_priority(PRIORITY_RANDOM), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    #[test]
    fn random_priority_removes_exactly_one_of_the_pair() {
        let (mut maze, id_a, id_b) = maze_with_two_teleports();
        let issue = Issue::with_data(TELEPORT_GROUP_PROXIMITY, IssueData::TeleportProximityPairs { pairs: vec![(id_a, id_b)] });
        let mut rng = MazeRng::seed_from_u64(1);
        let result = TeleportGroupProximityStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &params_with_priority(PRIORITY_RANDOM), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let remaining = maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).count();
        assert_eq!(remaining, 1, "exactly one teleport of the pair must survive");
    }

    #[test]
    fn problematic_priority_removes_the_teleport_in_more_pairs() {
        // a is in 2 pairs (with b and with c), b and c are each in 1 pair -- "problematic" must
        // remove a, since removing it resolves both pairs at once.
        let mut ids = IdGenerator::new();
        let field = crate::space::Field::new(square_rect(6, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
        let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
        let id_c = g.add_edge(nodes[4], nodes[5], EdgeKind::Teleport);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = Issue::with_data(TELEPORT_GROUP_PROXIMITY, IssueData::TeleportProximityPairs { pairs: vec![(id_a, id_b), (id_a, id_c)] });
        let mut rng = MazeRng::seed_from_u64(1);
        let result = TeleportGroupProximityStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &params_with_priority(PRIORITY_PROBLEMATIC), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.graph.edge(id_a).is_none(), "a (member of 2 pairs) must be removed");
        assert!(maze.graph.edge(id_b).is_some(), "b (member of 1 pair) must survive");
        assert!(maze.graph.edge(id_c).is_some(), "c (member of 1 pair) must survive");
    }

    #[test]
    fn problematic_priority_removes_exactly_one_on_a_tie() {
        // a and b are each in exactly 1 pair -- membership is tied, so "problematic" falls back
        // to a random pick between them, but must still remove exactly one, never both/neither.
        let (mut maze, id_a, id_b) = maze_with_two_teleports();
        let issue = Issue::with_data(TELEPORT_GROUP_PROXIMITY, IssueData::TeleportProximityPairs { pairs: vec![(id_a, id_b)] });
        let mut rng = MazeRng::seed_from_u64(1);
        let result = TeleportGroupProximityStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &params_with_priority(PRIORITY_PROBLEMATIC), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let remaining = maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).count();
        assert_eq!(remaining, 1, "a tie must still resolve to removing exactly one of the pair");
    }

    #[test]
    fn missing_priority_override_falls_back_to_problematic_default() {
        // a is in 2 pairs, b and c are each in 1 -- the default (no override) must behave like
        // PRIORITY_PROBLEMATIC and remove a, not pick randomly.
        let mut ids = IdGenerator::new();
        let field = crate::space::Field::new(square_rect(6, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
        let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
        let id_c = g.add_edge(nodes[4], nodes[5], EdgeKind::Teleport);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = Issue::with_data(TELEPORT_GROUP_PROXIMITY, IssueData::TeleportProximityPairs { pairs: vec![(id_a, id_b), (id_a, id_c)] });
        let mut rng = MazeRng::seed_from_u64(1);
        let no_override_params = crate::repair::params::build_params(
            <TeleportGroupProximityStrategy as RepairStrategy<SquareTessellation>>::params(&TeleportGroupProximityStrategy),
            None,
        );
        let result = TeleportGroupProximityStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_override_params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.graph.edge(id_a).is_none(), "default priority must behave like 'problematic' and remove a (member of 2 pairs)");
        assert!(maze.graph.edge(id_b).is_some());
        assert!(maze.graph.edge(id_c).is_some());
    }

    #[test]
    fn strategy_id_and_handles_match_registration() {
        assert_eq!(<TeleportGroupProximityStrategy as RepairStrategy<SquareTessellation>>::strategy_id(&TeleportGroupProximityStrategy), "teleport_group_proximity");
        assert_eq!(<TeleportGroupProximityStrategy as RepairStrategy<SquareTessellation>>::handles(&TeleportGroupProximityStrategy), TELEPORT_GROUP_PROXIMITY);
    }

    #[test]
    fn already_resolved_pair_via_the_other_side_is_skipped() {
        // Mirror of already_resolved_pair_is_skipped, but the shared teleport (a) sits in the
        // *second* position of the first pair and the *first* position of the second pair --
        // exercises that the skip check looks at both tuple sides, not just the first.
        let mut ids = IdGenerator::new();
        let field = crate::space::Field::new(square_rect(6, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
        let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
        let id_c = g.add_edge(nodes[4], nodes[5], EdgeKind::Teleport);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        // (b, a) then (a, c): a is in the second slot of pair 1, first slot of pair 2.
        let issue = Issue::with_data(TELEPORT_GROUP_PROXIMITY, IssueData::TeleportProximityPairs { pairs: vec![(id_b, id_a), (id_a, id_c)] });
        let mut rng = MazeRng::seed_from_u64(1);
        let result = TeleportGroupProximityStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &params_with_priority(PRIORITY_PROBLEMATIC), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.graph.edge(id_a).is_none(), "a (member of 2 pairs) must be removed");
        assert!(maze.graph.edge(id_b).is_some());
        assert!(maze.graph.edge(id_c).is_some());
    }

    #[test]
    fn already_resolved_pair_is_skipped() {
        // Both pairs share teleport a -- once a is removed resolving the first pair, the second
        // pair (also referencing a) must not attempt a second removal.
        let mut ids = IdGenerator::new();
        let field = crate::space::Field::new(square_rect(6, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
        let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
        let id_c = g.add_edge(nodes[4], nodes[5], EdgeKind::Teleport);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = Issue::with_data(TELEPORT_GROUP_PROXIMITY, IssueData::TeleportProximityPairs { pairs: vec![(id_a, id_b), (id_a, id_c)] });
        let mut rng = MazeRng::seed_from_u64(1);
        // "problematic" priority deterministically picks `a` (member of both pairs) both times
        // it's evaluated -- the second pair's evaluation must detect `a` is already removed and
        // skip acting on it again, rather than then removing `c` too.
        let result = TeleportGroupProximityStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &params_with_priority(PRIORITY_PROBLEMATIC), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        let remaining = maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).count();
        assert_eq!(remaining, 2, "removing a resolves both pairs -- b and c both survive, only a is removed");
    }
}
