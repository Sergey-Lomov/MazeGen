use crate::Maze;
use crate::generation::PresetState;
use crate::quality_control::{
    ExcessiveSccCountIssue, REGION_NEEDS_EXPANSION, RegionNeedsExpansionIssue,
};
use crate::repair::command::MutationCommand;
use crate::repair::nested_dispatch::slot_candidates;
use crate::repair::params::{
    StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams, build_params,
};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{
    NestedDispatchKind, NestedSlot, NestedStrategyConfig, RepairStrategy,
};
use crate::space::Tessellation;
use rand::{Rng, RngCore};

pub const PARAM_MERGE_PRIORITY: &str = "merge_priority";

pub const PRIORITY_SMALLEST: &str = "smallest";
pub const PRIORITY_LARGEST: &str = "largest";
pub const PRIORITY_RANDOM: &str = "random";

static PRIORITY_OPTIONS: &[&str] = &[PRIORITY_SMALLEST, PRIORITY_LARGEST, PRIORITY_RANDOM];

static PARAMS: &[StrategyParam] = &[StrategyParam {
    id: PARAM_MERGE_PRIORITY,
    label: "Merge priority",
    kind: StrategyParamKind::Enum {
        options: PRIORITY_OPTIONS,
        default: PRIORITY_SMALLEST,
    },
}];

/// Slot id for the nested strategy this strategy delegates the actual merge to — see
/// `Specs/repair.md`'s nested-strategy pattern. Public: part of this strategy's configuration
/// API (`StrategyConfig.slot_id` in `maze-runner`), not an internal detail.
pub const SLOT_MERGE_TARGET: &str = "merge_target";

static NESTED_SLOTS: &[NestedSlot] = &[NestedSlot {
    slot_id: SLOT_MERGE_TARGET,
    kind: REGION_NEEDS_EXPANSION,
    min: 1,
    max: Some(1),
    dispatch_kind: NestedDispatchKind::Unordered,
}];

/// Picks which of `sizes.len()` components to merge away, by `mode` (`smallest`/`largest`/
/// `random`), returning exactly `to_merge` component indices (or all of them, if `to_merge >=
/// sizes.len()`). Pure — takes only component sizes (not `ConnectedComponents`/`Maze`), so it's
/// unit-testable directly against synthetic size arrays without any graph/field/tessellation
/// setup, unlike `ReduceSccCountStrategy::apply` itself which needs a full `Maze` to compute
/// `sizes` from in the first place.
///
/// Sorts by size then index for determinism — component indices come from a `HashMap`-backed
/// build order that isn't itself randomized per-process, but sizes can tie, and `random` mode's
/// own pick must still be seed-reproducible (see `ExpandRegionPassageStrategy`'s identical
/// rationale for sorting before any rng-involving selection).
fn select_merge_candidates(
    sizes: &[usize],
    mode: &str,
    to_merge: usize,
    rng: &mut dyn RngCore,
) -> Vec<usize> {
    let mut candidates: Vec<usize> = (0..sizes.len()).collect();
    match mode {
        PRIORITY_SMALLEST => candidates.sort_by_key(|&i| (sizes[i], i)),
        PRIORITY_LARGEST => candidates.sort_by_key(|&i| (std::cmp::Reverse(sizes[i]), i)),
        _ => {
            // `random`: shuffle deterministically via `rng` (Fisher-Yates), rather than leaving
            // `candidates`' initial (ascending index) order in place — a fixed order would make
            // "random" mode pick the same regions every time regardless of seed.
            for i in (1..candidates.len()).rev() {
                let j = rng.random_range(0..=i);
                candidates.swap(i, j);
            }
        }
    }
    candidates.into_iter().take(to_merge).collect()
}

/// Handles `EXCESSIVE_SCC_COUNT` — see GitHub issue #68. The graph has more strongly-connected
/// components than a check's configured limit allows, but `SccCountCheck`'s issue carries no
/// specific regions to merge (unlike `REGION_NEEDS_EXPANSION`'s `RegionsNeedingExpansion`).
/// Instead of duplicating `ExpandRegionPassageStrategy`'s merge logic, this strategy picks which
/// regions to merge (by `merge_priority`: smallest/largest/random, however many are needed to
/// reach `max_scc_count`), synthesizes a `RegionsNeedingExpansion` issue naming them, and
/// delegates the actual merge to a nested strategy (typically `ExpandRegionPassageStrategy`)
/// filling the `merge_target` slot. The synthetic issue is never published to the shared issue
/// pool — only the original `EXCESSIVE_SCC_COUNT` issue is ever visible to the user.
///
/// **`issue.data` is mandatory for this kind**: `max_scc_count` is the producing check's
/// configured threshold — there is no other channel to learn it.
pub struct ReduceSccCountStrategy;

impl<T: Tessellation> RepairStrategy<T, ExcessiveSccCountIssue> for ReduceSccCountStrategy {
    fn strategy_id(&self) -> &'static str {
        "reduce_scc_count"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    fn apply(
        &self,
        issue: &ExcessiveSccCountIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let max_scc_count = issue.max_scc_count;

        // Idempotency check comes before the nested-strategy lookup — an already-resolved issue
        // must return Fixed regardless of whether a nested strategy is configured, per the
        // idempotency contract (Specs/repair.md): "if the relevant meta field is already set,
        // return Fixed immediately... without consuming rng". Checking `nested` first would
        // return Failed for an already-fixed issue whenever `nested` happened to be empty.
        let scc = maze.analysis.scc(&maze.graph);
        let count = scc.components.len() as u32;
        if count <= max_scc_count {
            return (RepairResult::Fixed { score: None }, vec![]);
        }
        let to_merge = (count - max_scc_count) as usize;

        // `build_nested` (maze-runner) already enforces exactly one nested strategy for this
        // slot via `expected_nested()`'s `max: Some(1)` — this is a defensive re-check, not the
        // primary guard, same posture other strategies take toward their own mandatory inputs
        // (e.g. `ExpandRegionPassageStrategy` on missing `issue.data`).
        let matching = slot_candidates(nested, SLOT_MERGE_TARGET);
        debug_assert!(
            matching.len() <= 1,
            "ReduceSccCountStrategy: expected_nested()'s max: Some(1) for slot \"{SLOT_MERGE_TARGET}\" should prevent more than one nested strategy filling it"
        );
        let Some(&merge_target) = matching.first() else {
            return (RepairResult::Failed, vec![]);
        };

        let mode = match params.get(PARAM_MERGE_PRIORITY) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => PRIORITY_SMALLEST,
        };

        let sizes: Vec<usize> = scc.components.iter().map(|c| c.len()).collect();
        let chosen = select_merge_candidates(&sizes, mode, to_merge, rng);
        if chosen.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let synthetic = RegionNeedsExpansionIssue::synthetic(chosen);

        let nested_params = build_params(
            merge_target.strategy.params(),
            Some(&merge_target.param_overrides),
        );
        // Parent has accumulated no commands of its own before delegating — nested_commands are
        // the entire returned batch, already in "parent, then nested" order (Specs/repair.md).
        merge_target.strategy.apply(
            &synthetic as &dyn crate::quality_control::Issue,
            maze,
            rng,
            &nested_params,
            preset_state,
            &merge_target.nested,
        )
    }
}

crate::impl_erased_repair_strategy!(ReduceSccCountStrategy, ExcessiveSccCountIssue);

#[cfg(test)]
#[path = "reduce_scc_count_tests.rs"]
mod tests;
