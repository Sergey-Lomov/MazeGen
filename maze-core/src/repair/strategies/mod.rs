pub mod random_endpoints;
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
pub mod missing_regions;
pub mod reduce_scc_count;
pub mod remove_teleport;
pub mod teleport_group_proximity;
pub mod weighted_region_merge;

pub use random_endpoints::RandomEndpointsStrategy;
pub use farthest_endpoints::FarthestEndpointsStrategy;
pub use scored_endpoints::ScoredEndpointsStrategy;
pub use invalid_loop_random::InvalidLoopRandomStrategy;
pub use invalid_loop_scored::InvalidLoopScoredStrategy;
pub use invalid_loop_group_select::{InvalidLoopGroupSelectStrategy, PARAM_SELECTION_MODE, SELECTION_RANDOM, SELECTION_SHORTEST, SELECTION_LONGEST, SLOT_CUT_TARGET as INVALID_LOOP_GROUP_SELECT_SLOT_CUT_TARGET};
pub use missing_loops_random::MissingLoopsRandomStrategy;
pub use expand_region_passage::ExpandRegionPassageStrategy;
pub use teleport_region_merge::TeleportRegionMergeStrategy;
pub use missing_regions::MissingRegionsStrategy;
pub use reduce_scc_count::ReduceSccCountStrategy;
pub use remove_teleport::RemoveTeleportStrategy;
pub use teleport_group_proximity::{TeleportGroupProximityStrategy, PARAM_PRIORITY, PRIORITY_RANDOM, PRIORITY_PROBLEMATIC};
pub use weighted_region_merge::{WeightedRegionMergeStrategy, SLOT_MERGE_TARGET as WEIGHTED_REGION_MERGE_SLOT_MERGE_TARGET};

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
        apply_commands(maze, preset_state, commands, None);
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
