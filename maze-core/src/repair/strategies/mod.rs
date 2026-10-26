pub mod add_elevator;
pub mod add_elevator_height_stop;
pub mod add_elevator_stop;
pub mod add_elevator_stop_count;
pub mod add_elevator_stop_for_gap;
pub mod add_split;
pub mod add_vertical_passage;
pub mod cross_element_group_select;
mod cycle_cut_set;
pub mod dead_end_priority;
pub mod dead_end_to_passage;
pub mod elevator_group_select;
pub mod elevator_region_merge;
pub mod elevator_stop_group_select;
pub mod elevator_utils;
pub mod expand_region_passage;
pub mod farthest_endpoints;
pub(crate) mod farthest_reachable;
pub mod group_select;
pub mod invalid_loop_group_select;
pub mod invalid_loop_random;
pub mod invalid_loop_scored;
pub mod missing_loops_random;
pub mod missing_loops_split;
pub mod missing_loops_teleport;
pub mod missing_loops_vertical;
pub mod missing_one_ways_from_passage;
pub mod missing_one_ways_from_wall;
mod missing_one_ways_shared;
pub mod missing_regions;
pub mod missing_teleports;
pub mod one_way_group_select;
pub mod one_way_to_passage;
pub mod one_way_to_wall;
pub mod pool;
pub mod priority_missing_loops;
pub mod priority_region_merge;
pub mod random_endpoints;
pub mod reduce_scc_count;
mod region_merge_core;
pub mod region_shrink_split;
mod remaining_deficits;
pub mod remove_elevator;
pub mod remove_elevator_stop;
pub mod remove_split;
pub mod remove_split_node;
pub mod remove_split_node_connection;
pub mod remove_teleport;
pub mod remove_vertical_passage;
pub mod replace_elevator_with_passages;
pub mod scored_endpoints;
pub(crate) mod split_core;
pub mod split_group_select;
pub mod split_node_connection_group_select;
pub mod split_node_group_select;
pub mod split_route_cut;
pub mod standard_add_params;
pub mod teleport_group_select;
pub mod teleport_region_merge;
pub mod vertical_passage_group_select;
pub mod vertical_passage_region_merge;
pub mod vertical_target;
pub mod weighted_region_merge;

pub use add_elevator::AddElevatorStrategy;
pub use add_elevator_height_stop::{
    AddElevatorHeightStopStrategy,
    PARAM_ALLOW_INCOMPLETE as ADD_ELEVATOR_HEIGHT_STOP_PARAM_ALLOW_INCOMPLETE,
    PARAM_BALANCED_GROWTH as ADD_ELEVATOR_HEIGHT_STOP_PARAM_BALANCED_GROWTH,
    PARAM_MAX_COMPACTNESS as ADD_ELEVATOR_HEIGHT_STOP_PARAM_MAX_COMPACTNESS,
};
pub use add_elevator_stop::{
    AddElevatorStopStrategy,
    PARAM_ALLOW_SPAN_EXTENSION as ADD_ELEVATOR_STOP_PARAM_ALLOW_SPAN_EXTENSION,
    PARAM_EXISTING_REUSE_BALANCE as ADD_ELEVATOR_STOP_PARAM_EXISTING_REUSE_BALANCE,
    SLOT_ADD_ELEVATOR_STRATEGY as ADD_ELEVATOR_STOP_SLOT_ADD_ELEVATOR_STRATEGY,
};
pub use add_elevator_stop_count::{
    AddElevatorStopCountStrategy,
    PARAM_EXPAND_ELEVATOR as ADD_ELEVATOR_STOP_COUNT_PARAM_EXPAND_ELEVATOR,
};
pub use add_elevator_stop_for_gap::AddElevatorStopForGapStrategy;
pub use add_split::{
    AddSplitStrategy, PARAM_ALLOW_ADD_CONNECTIONS as ADD_SPLIT_PARAM_ALLOW_ADD_CONNECTIONS,
    PARAM_ALLOW_LOSE_CONNECTIONS as ADD_SPLIT_PARAM_ALLOW_LOSE_CONNECTIONS,
};
pub use add_vertical_passage::{
    AddVerticalPassageStrategy, PARAM_ONE_WAY_BALANCE as ADD_VERTICAL_PASSAGE_PARAM_ONE_WAY_BALANCE,
};
pub use cross_element_group_select::{
    CrossElementGroupSelectStrategy,
    SLOT_ELEVATOR_STOP_FIX as CROSS_ELEMENT_GROUP_SELECT_SLOT_ELEVATOR_STOP_FIX,
    SLOT_ONE_WAY_FIX as CROSS_ELEMENT_GROUP_SELECT_SLOT_ONE_WAY_FIX,
    SLOT_SPLIT_FIX as CROSS_ELEMENT_GROUP_SELECT_SLOT_SPLIT_FIX,
    SLOT_TELEPORT_FIX as CROSS_ELEMENT_GROUP_SELECT_SLOT_TELEPORT_FIX,
    SLOT_VERTICAL_PASSAGE_FIX as CROSS_ELEMENT_GROUP_SELECT_SLOT_VERTICAL_PASSAGE_FIX,
};
pub use dead_end_priority::{
    PARAM_SRC_MODE, SRC_MODE_DEAD_END_PRIORITY, SRC_MODE_OPTIONS, SRC_MODE_PARAM, SRC_MODE_RANDOM,
};
pub use dead_end_to_passage::{
    DeadEndToPassageStrategy, PARAM_ONE_WAY_CHANCE as DEAD_END_TO_PASSAGE_PARAM_ONE_WAY_CHANCE,
};
pub use elevator_group_select::{
    ElevatorGroupSelectStrategy, SLOT_FIX_TARGET as ELEVATOR_GROUP_SELECT_SLOT_FIX_TARGET,
};
pub use elevator_region_merge::{
    ElevatorRegionMergeStrategy,
    PARAM_USE_EXISTING_ELEVATORS as ELEVATOR_REGION_MERGE_PARAM_USE_EXISTING_ELEVATORS,
};
pub use elevator_stop_group_select::{
    ElevatorStopGroupSelectStrategy, SLOT_FIX_TARGET as ELEVATOR_STOP_GROUP_SELECT_SLOT_FIX_TARGET,
};
pub use expand_region_passage::ExpandRegionPassageStrategy;
pub use farthest_endpoints::FarthestEndpointsStrategy;
pub use group_select::group_select_apply;
pub use group_select::{PARAM_PRIORITY, PRIORITY_PROBLEMATIC, PRIORITY_RANDOM};
pub use group_select::{
    PARAM_PRIORITY as ONE_WAY_GROUP_SELECT_PARAM_PRIORITY,
    PRIORITY_PROBLEMATIC as ONE_WAY_GROUP_SELECT_PRIORITY_PROBLEMATIC,
    PRIORITY_RANDOM as ONE_WAY_GROUP_SELECT_PRIORITY_RANDOM,
};
pub use invalid_loop_group_select::{
    InvalidLoopGroupSelectStrategy, PARAM_SELECTION_MODE, SELECTION_LONGEST, SELECTION_RANDOM,
    SELECTION_SHORTEST, SLOT_CUT_TARGET as INVALID_LOOP_GROUP_SELECT_SLOT_CUT_TARGET,
};
pub use invalid_loop_random::InvalidLoopRandomStrategy;
pub use invalid_loop_scored::InvalidLoopScoredStrategy;
pub use missing_loops_random::MissingLoopsRandomStrategy;
pub use missing_loops_split::{
    MissingLoopsSplitStrategy, PARAM_PROTECT_ROUTE as MISSING_LOOPS_SPLIT_PARAM_PROTECT_ROUTE,
};
pub use missing_loops_teleport::{
    MissingLoopsTeleportStrategy,
    PARAM_ONE_WAY_CHANCE as MISSING_LOOPS_TELEPORT_PARAM_ONE_WAY_CHANCE,
};
pub use missing_loops_vertical::{
    MissingLoopsVerticalStrategy,
    PARAM_DIRECTION_BALANCE as MISSING_LOOPS_VERTICAL_PARAM_DIRECTION_BALANCE,
    PARAM_ONE_WAY_CHANCE as MISSING_LOOPS_VERTICAL_PARAM_ONE_WAY_CHANCE,
};
pub use missing_one_ways_from_passage::MissingOneWaysFromPassageStrategy;
pub use missing_one_ways_from_wall::MissingOneWaysFromWallStrategy;
pub use missing_regions::MissingRegionsStrategy;
pub use missing_teleports::{
    ENTRY_FARTHEST_FROM_RANDOM as MISSING_TELEPORTS_ENTRY_FARTHEST_FROM_RANDOM,
    ENTRY_RANDOM as MISSING_TELEPORTS_ENTRY_RANDOM, MissingTeleportsStrategy,
    PARAM_DESIRED_LENGTH as MISSING_TELEPORTS_PARAM_DESIRED_LENGTH,
    PARAM_ENTRY_PICK as MISSING_TELEPORTS_PARAM_ENTRY_PICK,
};
pub use one_way_group_select::{
    OneWayGroupSelectStrategy, SLOT_FIX_TARGET as ONE_WAY_GROUP_SELECT_SLOT_FIX_TARGET,
};
pub use one_way_to_passage::OneWayToPassageStrategy;
pub use one_way_to_wall::OneWayToWallStrategy;
pub use priority_missing_loops::{
    PriorityMissingLoopsStrategy,
    SLOT_LOOP_SEED_TARGET as PRIORITY_MISSING_LOOPS_SLOT_LOOP_SEED_TARGET,
};
pub use priority_region_merge::{
    PriorityRegionMergeStrategy, SLOT_MERGE_TARGET as PRIORITY_REGION_MERGE_SLOT_MERGE_TARGET,
};
pub use random_endpoints::RandomEndpointsStrategy;
pub use reduce_scc_count::ReduceSccCountStrategy;
pub use region_shrink_split::RegionShrinkSplitStrategy;
pub use remove_elevator::RemoveElevatorStrategy;
pub use remove_elevator_stop::RemoveElevatorStopStrategy;
pub use remove_split::{
    PARAM_SELECTION as REMOVE_SPLIT_PARAM_SELECTION, RemoveSplitStrategy,
    SELECTION_LEAST_CONNECTED as REMOVE_SPLIT_SELECTION_LEAST_CONNECTED,
    SELECTION_MERGE as REMOVE_SPLIT_SELECTION_MERGE,
    SELECTION_MOST_CONNECTED as REMOVE_SPLIT_SELECTION_MOST_CONNECTED,
    SELECTION_OPTIONS as REMOVE_SPLIT_SELECTION_OPTIONS,
    SELECTION_RANDOM as REMOVE_SPLIT_SELECTION_RANDOM,
};
pub use remove_split_node::{
    PARAM_REDISTRIBUTE as REMOVE_SPLIT_NODE_PARAM_REDISTRIBUTE, RemoveSplitNodeStrategy,
};
pub use remove_split_node_connection::RemoveSplitNodeConnectionStrategy;
pub use remove_teleport::RemoveTeleportStrategy;
pub use remove_vertical_passage::RemoveVerticalPassageStrategy;
pub use replace_elevator_with_passages::{
    PARAM_ADJACENT_FLOORS_ONLY as REPLACE_ELEVATOR_WITH_PASSAGES_PARAM_ADJACENT_FLOORS_ONLY,
    ReplaceElevatorWithPassagesStrategy,
};
pub use scored_endpoints::{ScoreWeights, ScoredEndpointsStrategy, score_for_route};
pub use split_group_select::{
    PRIORITY_LEAST_CONNECTED, PRIORITY_LEAST_VOLUMINOUS, PRIORITY_MOST_CONNECTED,
    PRIORITY_MOST_VOLUMINOUS, SLOT_FIX_TARGET as SPLIT_GROUP_SELECT_SLOT_FIX_TARGET,
    SPLIT_PRIORITY_OPTIONS, SplitGroupSelectStrategy,
};
pub use split_node_connection_group_select::{
    PARAM_PROTECT_ORIGINAL as SPLIT_NODE_CONNECTION_PARAM_PROTECT_ORIGINAL,
    PARAM_PROTECT_ROUTE as SPLIT_NODE_CONNECTION_PARAM_PROTECT_ROUTE,
    PARAM_SELECTION as SPLIT_NODE_CONNECTION_PARAM_SELECTION,
    SELECTION_LEAST_CONNECTED as SPLIT_NODE_CONNECTION_SELECTION_LEAST_CONNECTED,
    SELECTION_MOST_CONNECTED as SPLIT_NODE_CONNECTION_SELECTION_MOST_CONNECTED,
    SELECTION_OPTIONS as SPLIT_NODE_CONNECTION_SELECTION_OPTIONS,
    SELECTION_RANDOM as SPLIT_NODE_CONNECTION_SELECTION_RANDOM,
    SLOT_FIX_TARGET as SPLIT_NODE_CONNECTION_GROUP_SELECT_SLOT_FIX_TARGET,
    SplitNodeConnectionGroupSelectStrategy,
};
pub use split_node_group_select::{
    PARAM_SELECTION as SPLIT_NODE_GROUP_PARAM_SELECTION,
    SELECTION_LEAST_CONNECTED as SPLIT_NODE_GROUP_SELECTION_LEAST_CONNECTED,
    SELECTION_MOST_CONNECTED as SPLIT_NODE_GROUP_SELECTION_MOST_CONNECTED,
    SELECTION_OPTIONS as SPLIT_NODE_GROUP_SELECTION_OPTIONS,
    SELECTION_RANDOM as SPLIT_NODE_GROUP_SELECTION_RANDOM,
    SLOT_FIX_TARGET as SPLIT_NODE_GROUP_SELECT_SLOT_FIX_TARGET, SplitNodeGroupSelectStrategy,
};
pub use split_route_cut::{
    EDGE_SCOPE_ANY as SPLIT_ROUTE_CUT_EDGE_SCOPE_ANY,
    EDGE_SCOPE_OTHER_ONLY as SPLIT_ROUTE_CUT_EDGE_SCOPE_OTHER_ONLY,
    EDGE_SCOPE_SPLIT_ONLY as SPLIT_ROUTE_CUT_EDGE_SCOPE_SPLIT_ONLY,
    PARAM_EDGE_SCOPE as SPLIT_ROUTE_CUT_PARAM_EDGE_SCOPE, SplitRouteCutStrategy,
};
pub use standard_add_params::{
    ATTEMPTS_LIMIT_PARAM, NESTED_SUPPRESSED_ADD_PARAMS, PARAM_ATTEMPTS_LIMIT,
    PARAM_RESERVE_PERCENT, RESERVE_PERCENT_PARAM,
};
pub use teleport_group_select::{
    SLOT_FIX_TARGET as TELEPORT_GROUP_SELECT_SLOT_FIX_TARGET, TeleportGroupSelectStrategy,
};
pub use teleport_region_merge::TeleportRegionMergeStrategy;
pub use vertical_passage_group_select::{
    SLOT_FIX_TARGET as VERTICAL_PASSAGE_GROUP_SELECT_SLOT_FIX_TARGET,
    VerticalPassageGroupSelectStrategy,
};
pub use vertical_passage_region_merge::{
    PARAM_CONNECTION_MODE as VERTICAL_PASSAGE_REGION_MERGE_PARAM_CONNECTION_MODE,
    PARAM_DIRECTION_BALANCE as VERTICAL_PASSAGE_REGION_MERGE_PARAM_DIRECTION_BALANCE,
    VerticalPassageRegionMergeStrategy,
};
pub use weighted_region_merge::{
    SLOT_MERGE_TARGET as WEIGHTED_REGION_MERGE_SLOT_MERGE_TARGET, WeightedRegionMergeStrategy,
};

#[cfg(test)]
pub(crate) mod test_utils {
    use crate::Maze;
    use crate::generation::PresetState;
    use crate::quality_control::apply_commands::apply_commands;
    use crate::quality_control::issue::IssueRequirement;
    use crate::repair::params::StrategyParams;
    use crate::repair::result::RepairResult;
    use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
    use crate::space::Tessellation;
    use rand::RngCore;

    /// Calls `strategy.apply` then immediately applies the returned commands to `maze` — mirrors
    /// `Rule::check_and_repair_typed`'s own apply-then-commit sequencing (GitHub issue #118), so
    /// test assertions on `maze` after the call see the fully-committed result.
    pub fn apply_and_commit<T: Tessellation, I: IssueRequirement>(
        strategy: &impl RepairStrategy<T, I>,
        issue: &I,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> RepairResult {
        let (result, commands) = strategy.apply(issue, maze, rng, params, preset_state, nested);
        apply_commands(maze, preset_state, commands, None, None);
        result
    }

    /// Convenience wrapper for strategies whose tests never need param overrides or nested
    /// strategies — same commit sequencing as `apply_and_commit`, with `StrategyParams::new()`
    /// and an empty `nested` slice filled in.
    pub fn apply_and_commit_default<T: Tessellation, I: IssueRequirement>(
        strategy: &impl RepairStrategy<T, I>,
        issue: &I,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
    ) -> RepairResult {
        apply_and_commit(
            strategy,
            issue,
            maze,
            rng,
            &StrategyParams::new(),
            preset_state,
            &[],
        )
    }
}
