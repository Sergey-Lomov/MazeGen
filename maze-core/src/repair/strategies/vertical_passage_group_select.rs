use crate::Maze;
use crate::generation::PresetState;
use crate::ids::EdgeId;
use crate::quality_control::{
    INVALID_VERTICAL_PASSAGE, InvalidVerticalPassageGroupIssue, InvalidVerticalPassageIssue,
    VerticalPassageGroupKind,
};
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategies::group_select::{
    PARAM_PRIORITY, PRIORITY_OPTIONS, PRIORITY_PROBLEMATIC, group_select_apply,
};
use crate::repair::strategy::{
    NestedDispatchKind, NestedSlot, NestedStrategyConfig, RepairStrategy,
};
use crate::space::Tessellation;
use rand::RngCore;

static PARAMS: &[StrategyParam] = &[StrategyParam {
    id: PARAM_PRIORITY,
    label: "Fix priority",
    kind: StrategyParamKind::Enum {
        options: PRIORITY_OPTIONS,
        default: PRIORITY_PROBLEMATIC,
    },
}];

/// Slot id for the nested strategy this strategy delegates the actual per-edge removal to
/// (`RemoveVerticalPassageStrategy`) — mirrors `OneWayGroupSelectStrategy::SLOT_FIX_TARGET`.
pub const SLOT_FIX_TARGET: &str = "fix_target";

static NESTED_SLOTS: &[NestedSlot] = &[NestedSlot {
    slot_id: SLOT_FIX_TARGET,
    kind: INVALID_VERTICAL_PASSAGE,
    min: 1,
    max: Some(1),
    dispatch_kind: NestedDispatchKind::Unordered,
}];

/// Handles `INVALID_VERTICAL_PASSAGE_GROUP` — see GitHub issue #343. Produced by
/// `MaxVerticalPassageCountCheck`/`MaxVerticalPassageRatioCheck` (maze-wide/per-floor excess).
/// Mirrors `OneWayGroupSelectStrategy` exactly: candidate-pass/budget/nested-delegation mechanics
/// live in the shared `group_select::group_select_apply`, the same `PARAM_PRIORITY`
/// (`random`/`problematic`) selection every other group-select strategy in this crate uses. No
/// route protection here — unlike one-ways, a vertical passage group excess isn't gated by a
/// `protect_route` param in this issue's scope.
pub struct VerticalPassageGroupSelectStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidVerticalPassageGroupIssue>
    for VerticalPassageGroupSelectStrategy
{
    fn strategy_id(&self) -> &'static str {
        "vertical_passage_group_select"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    fn apply(
        &self,
        issue: &InvalidVerticalPassageGroupIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let matching: Vec<&NestedStrategyConfig<T>> = nested
            .iter()
            .filter(|n| n.slot.slot_id == SLOT_FIX_TARGET)
            .collect();
        debug_assert!(
            matching.len() <= 1,
            "VerticalPassageGroupSelectStrategy: expected_nested()'s max: Some(1) for slot \"{SLOT_FIX_TARGET}\" should prevent more than one nested strategy filling it"
        );
        let Some(&fix_target) = matching.first() else {
            if issue.groups.is_empty() {
                return (RepairResult::Fixed { score: None }, vec![]);
            }
            return (RepairResult::Failed, vec![]);
        };

        let element_allowed = |_edge: &EdgeId| true;
        let build_nested_issue = |source_check: &str,
                                  target: &EdgeId,
                                  _others: &[EdgeId]|
         -> Box<dyn crate::quality_control::Issue> {
            Box::new(InvalidVerticalPassageIssue::new_from_check(
                source_check,
                vec![*target],
            ))
        };
        let element_invalidated =
            |edge: &EdgeId, nested_commands: &[MutationCommand], _maze: &Maze<T>| {
                crate::repair::removed_edge_ids(nested_commands).contains(edge)
            };

        group_select_apply::<T, VerticalPassageGroupKind>(
            issue,
            maze,
            rng,
            preset_state,
            fix_target,
            element_allowed,
            build_nested_issue,
            element_invalidated,
            crate::repair::strategies::group_select::order_by_priority(params),
        )
    }
}

crate::impl_erased_repair_strategy!(
    VerticalPassageGroupSelectStrategy,
    InvalidVerticalPassageGroupIssue
);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::random::MazeRng;
    use crate::repair::params::build_params;
    use crate::repair::strategies::remove_vertical_passage::RemoveVerticalPassageStrategy;
    use crate::repair::strategies::test_utils::apply_and_commit;
    use crate::repair::strategy::NestedSlot as NestedSlotType;
    use crate::space::{SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::collections::HashMap;
    use std::sync::Arc;

    fn maze_with_two_vertical_passages() -> (Maze<SquareTessellation>, EdgeId, EdgeId) {
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
            .all_points()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        let a = g.add_edge(nodes[0], nodes[1], EdgeKind::VerticalPassage);
        let b = g.add_edge(nodes[1], nodes[2], EdgeKind::VerticalPassage);
        (Maze::new(field, g), a, b)
    }

    fn nested_config(strategy_params: &StrategyParams) -> NestedStrategyConfig<SquareTessellation> {
        let _ = strategy_params;
        NestedStrategyConfig {
            slot: &NestedSlotType {
                slot_id: SLOT_FIX_TARGET,
                kind: INVALID_VERTICAL_PASSAGE,
                min: 1,
                max: Some(1),
                dispatch_kind: NestedDispatchKind::Unordered,
            },
            strategy: Box::new(RemoveVerticalPassageStrategy),
            param_overrides: HashMap::new(),
            nested: vec![],
        }
    }

    fn no_params() -> StrategyParams {
        build_params(
            <VerticalPassageGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                InvalidVerticalPassageGroupIssue,
            >>::params(&VerticalPassageGroupSelectStrategy),
            None,
        )
    }

    #[test]
    fn apply_removes_one_edge_from_the_flagged_group() {
        let (mut maze, a, b) = maze_with_two_vertical_passages();
        let issue = InvalidVerticalPassageGroupIssue::new_from_check(
            "max_vertical_passage_count",
            vec![(vec![a, b], 1)],
        );
        let params = no_params();
        let nested = nested_config(&params);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &VerticalPassageGroupSelectStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            std::slice::from_ref(&nested),
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(
            maze.graph
                .edges()
                .filter(|e| e.kind == EdgeKind::VerticalPassage)
                .count(),
            1,
            "exactly one edge from the group of 2 must be removed"
        );
    }

    #[test]
    fn apply_succeeds_on_empty_groups_without_a_nested_strategy() {
        let (mut maze, _a, _b) = maze_with_two_vertical_passages();
        let issue =
            InvalidVerticalPassageGroupIssue::new_from_check("max_vertical_passage_count", vec![]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &VerticalPassageGroupSelectStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }
}
