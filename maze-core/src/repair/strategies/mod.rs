pub mod random_endpoints;
pub(crate) mod farthest_reachable;
pub mod farthest_endpoints;
pub mod scored_endpoints;
mod cycle_cut_set;
mod region_merge_core;
pub mod invalid_loop_random;
pub mod invalid_loop_scored;
pub mod invalid_loop_group_select;
pub mod missing_loops_random;
pub mod expand_region_passage;
pub mod teleport_region_merge;
pub mod region_shrink_split;
pub mod missing_regions;
pub mod reduce_scc_count;
pub mod remove_teleport;
pub mod teleport_group_select;
pub mod weighted_region_merge;
pub mod one_way_to_passage;
pub mod one_way_to_wall;
pub mod group_select;
pub mod one_way_group_select;
mod missing_one_ways_shared;
pub mod missing_one_ways_from_passage;
pub mod missing_one_ways_from_wall;
pub mod missing_teleports;
pub mod remove_split;
pub mod split_group_select;
pub mod add_split;

pub use random_endpoints::RandomEndpointsStrategy;
pub use farthest_endpoints::FarthestEndpointsStrategy;
pub use scored_endpoints::ScoredEndpointsStrategy;
pub use invalid_loop_random::InvalidLoopRandomStrategy;
pub use invalid_loop_scored::InvalidLoopScoredStrategy;
pub use invalid_loop_group_select::{InvalidLoopGroupSelectStrategy, PARAM_SELECTION_MODE, SELECTION_RANDOM, SELECTION_SHORTEST, SELECTION_LONGEST, SLOT_CUT_TARGET as INVALID_LOOP_GROUP_SELECT_SLOT_CUT_TARGET};
pub use missing_loops_random::MissingLoopsRandomStrategy;
pub use expand_region_passage::ExpandRegionPassageStrategy;
pub use teleport_region_merge::TeleportRegionMergeStrategy;
pub use region_shrink_split::RegionShrinkSplitStrategy;
pub use missing_regions::MissingRegionsStrategy;
pub use reduce_scc_count::ReduceSccCountStrategy;
pub use remove_teleport::RemoveTeleportStrategy;
pub use teleport_group_select::{TeleportGroupSelectStrategy, PARAM_PROTECT_ROUTE as TELEPORT_GROUP_SELECT_PARAM_PROTECT_ROUTE, SLOT_FIX_TARGET as TELEPORT_GROUP_SELECT_SLOT_FIX_TARGET};
pub use group_select::{PARAM_PRIORITY, PRIORITY_RANDOM, PRIORITY_PROBLEMATIC};
pub use weighted_region_merge::{WeightedRegionMergeStrategy, SLOT_MERGE_TARGET as WEIGHTED_REGION_MERGE_SLOT_MERGE_TARGET};
pub use one_way_to_passage::OneWayToPassageStrategy;
pub use one_way_to_wall::OneWayToWallStrategy;
pub use group_select::group_select_apply;
pub use one_way_group_select::{OneWayGroupSelectStrategy, PARAM_PROTECT_ROUTE as ONE_WAY_GROUP_SELECT_PARAM_PROTECT_ROUTE, SLOT_FIX_TARGET as ONE_WAY_GROUP_SELECT_SLOT_FIX_TARGET};
pub use group_select::{PARAM_PRIORITY as ONE_WAY_GROUP_SELECT_PARAM_PRIORITY, PRIORITY_RANDOM as ONE_WAY_GROUP_SELECT_PRIORITY_RANDOM, PRIORITY_PROBLEMATIC as ONE_WAY_GROUP_SELECT_PRIORITY_PROBLEMATIC};
pub use missing_one_ways_from_passage::MissingOneWaysFromPassageStrategy;
pub use missing_one_ways_from_wall::MissingOneWaysFromWallStrategy;
pub use missing_teleports::{MissingTeleportsStrategy, PARAM_ENTRY_PICK as MISSING_TELEPORTS_PARAM_ENTRY_PICK, PARAM_DESIRED_LENGTH as MISSING_TELEPORTS_PARAM_DESIRED_LENGTH, ENTRY_RANDOM as MISSING_TELEPORTS_ENTRY_RANDOM, ENTRY_FARTHEST_FROM_RANDOM as MISSING_TELEPORTS_ENTRY_FARTHEST_FROM_RANDOM};
pub use remove_split::{RemoveSplitStrategy, PARAM_REDISTRIBUTE as REMOVE_SPLIT_PARAM_REDISTRIBUTE};
pub use split_group_select::{SplitGroupSelectStrategy, SLOT_FIX_TARGET as SPLIT_GROUP_SELECT_SLOT_FIX_TARGET, SPLIT_PRIORITY_OPTIONS, PRIORITY_MOST_VOLUMINOUS, PRIORITY_LEAST_VOLUMINOUS, PRIORITY_MOST_CONNECTED, PRIORITY_LEAST_CONNECTED};
pub use add_split::{AddSplitStrategy, PARAM_ALLOW_LOSE_CONNECTIONS as ADD_SPLIT_PARAM_ALLOW_LOSE_CONNECTIONS, PARAM_ALLOW_ADD_CONNECTIONS as ADD_SPLIT_PARAM_ALLOW_ADD_CONNECTIONS, PARAM_MAX_ATTEMPTS as ADD_SPLIT_PARAM_MAX_ATTEMPTS, MAX_ATTEMPTS_DEFAULT as ADD_SPLIT_MAX_ATTEMPTS_DEFAULT};

#[cfg(test)]
pub(crate) mod test_utils {
    use rand::RngCore;
    use crate::Maze;
    use crate::space::Tessellation;
    use crate::generation::PresetState;
    use crate::repair::params::StrategyParams;
    use crate::repair::result::RepairResult;
    use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
    use crate::quality_control::rule::apply_commands;
    use crate::quality_control::issue::IssueRequirement;

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
        apply_and_commit(strategy, issue, maze, rng, &StrategyParams::new(), preset_state, &[])
    }
}
