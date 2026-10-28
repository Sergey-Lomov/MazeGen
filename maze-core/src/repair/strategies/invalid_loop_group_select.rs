use crate::Maze;
use crate::generation::PresetState;
use crate::ids::EdgeId;
use crate::quality_control::{
    INVALID_LOOP, InvalidLoopGroupIssue, InvalidLoopGroupRequirement, InvalidLoopIssue,
};
use crate::repair::command::{MutationCommand, removed_edge_ids};
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{
    NestedDispatchKind, NestedSlot, NestedStrategyConfig, RepairStrategy,
};
use crate::space::Tessellation;
use rand::{Rng, RngCore};
use std::collections::{HashSet, VecDeque};

pub const PARAM_SELECTION_MODE: &str = "selection_mode";
pub const PARAM_SAMPLE_MODE: &str = "sample_mode";
pub const PARAM_SAMPLE_SIZE: &str = "sample_size";

pub const SELECTION_RANDOM: &str = "random";
pub const SELECTION_SHORTEST: &str = "shortest";
pub const SELECTION_LONGEST: &str = "longest";

pub const SAMPLE_MODE_COUNT: &str = "count";
pub const SAMPLE_MODE_PERCENT: &str = "percent";

static SELECTION_MODE_OPTIONS: &[&str] = &[SELECTION_RANDOM, SELECTION_SHORTEST, SELECTION_LONGEST];
static SAMPLE_MODE_OPTIONS: &[&str] = &[SAMPLE_MODE_COUNT, SAMPLE_MODE_PERCENT];

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_SELECTION_MODE,
        label: "Target cycle selection",
        kind: StrategyParamKind::Enum {
            options: SELECTION_MODE_OPTIONS,
            default: SELECTION_RANDOM,
        },
    },
    StrategyParam {
        id: PARAM_SAMPLE_MODE,
        label: "Sample size mode",
        kind: StrategyParamKind::Enum {
            options: SAMPLE_MODE_OPTIONS,
            default: SAMPLE_MODE_COUNT,
        },
    },
    StrategyParam {
        id: PARAM_SAMPLE_SIZE,
        label: "Sample size",
        kind: StrategyParamKind::Float {
            default: 1.0,
            min: 0.0,
            max: 100_000.0,
        },
    },
];

/// Slot id for the nested strategy this strategy delegates the actual cut to — see
/// `Specs/repair.md`'s nested-strategy pattern.
pub const SLOT_CUT_TARGET: &str = "cut_target";

static NESTED_SLOTS: &[NestedSlot] = &[NestedSlot {
    slot_id: SLOT_CUT_TARGET,
    kind: INVALID_LOOP,
    min: 1,
    max: Some(1),
    dispatch_kind: NestedDispatchKind::Unordered,
}];

/// Handles `INVALID_LOOP_GROUP` (see GitHub issue #183) by picking a *sample* of the flagged
/// cycles (sized by `sample_mode`/`sample_size`, ordered by `selection_mode`) and resolving them
/// one at a time against a nested strategy (typically `InvalidLoopRandomStrategy`/
/// `InvalidLoopScoredStrategy`) filling the `cut_target` slot.
///
/// `sample_mode`/`sample_size` control how many of `issue.invalid` enter the sample: `count` takes
/// `sample_size` cycles literally (rounded up), `percent` takes `ceil(sample_size / 100 *
/// issue.invalid.len())` — either way, at least 1 (there is always something to do when
/// `issue.invalid` is non-empty at all). `selection_mode` (random/shortest/longest) both orders
/// the sample and is reused as the tie-break/pick criterion within it, exactly as before this
/// sampling was added.
///
/// The sample is treated as a queue: each iteration pops the front cycle as the nested strategy's
/// target, synthesizes an `InvalidLoopIssue` where every *other* still-pending sample cycle is
/// `invalid` context and every non-sampled cycle (both the rest of `issue.invalid` and all of
/// `issue.valid`) is `valid` context, and delegates to the nested strategy. After each nested
/// call, any edge it reports removing (`removed_edge_ids`) is used to drop every remaining queued
/// cycle that shares that edge — those cycles are already broken by the same cut and are neither
/// re-offered nor carried forward as context, distinct from a cycle that simply wasn't sampled
/// this round. The loop ends when the queue empties; `apply()` concatenates every nested call's
/// commands, in order (`Specs/repair.md`'s nested-strategy contract).
///
/// Returns `Fixed` if at least one nested call in the batch succeeded (its commands are kept,
/// even if a later cycle in the same batch failed), `Failed` only if every nested call in the
/// batch failed (nothing was actually fixed, so no commands are returned) — a mix of successes
/// and failures within one sample is not itself surfaced beyond "at least one worked."
pub struct InvalidLoopGroupSelectStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidLoopGroupIssue> for InvalidLoopGroupSelectStrategy {
    fn strategy_id(&self) -> &'static str {
        "invalid_loop_group_select"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    /// Cannot translate the nested strategy's own `requirement()` here — `Rule::new` resolves
    /// `requirement()` from `&self, params` alone (see `rule.rs`), before `nested` is known to
    /// this strategy at all, so there is no nested `RepairStrategy` to consult yet. Always
    /// requests `all()` ("compute everything"), same as every other unmigrated strategy's
    /// default — safe (never wrong, just potentially wasted computation), and correct regardless
    /// of what the eventually-configured nested strategy turns out to need.
    fn requirement(&self, _params: &StrategyParams) -> InvalidLoopGroupRequirement {
        InvalidLoopGroupRequirement::all()
    }

    fn apply(
        &self,
        issue: &InvalidLoopGroupIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.invalid.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        // `build_nested` (maze-runner) already enforces exactly one nested strategy for this
        // slot via `expected_nested()`'s `max: Some(1)` — this is a defensive re-check, not the
        // primary guard, same posture `ReduceSccCountStrategy` takes toward its own nested slot.
        let matching: Vec<&NestedStrategyConfig<T>> = nested
            .iter()
            .filter(|n| n.slot.slot_id == SLOT_CUT_TARGET)
            .collect();
        debug_assert!(
            matching.len() <= 1,
            "InvalidLoopGroupSelectStrategy: expected_nested()'s max: Some(1) for slot \"{SLOT_CUT_TARGET}\" should prevent more than one nested strategy filling it"
        );
        let Some(&cut_target) = matching.first() else {
            return (RepairResult::Failed, vec![]);
        };

        let selection_mode = match params.get(PARAM_SELECTION_MODE) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => SELECTION_RANDOM,
        };
        let sample_mode = match params.get(PARAM_SAMPLE_MODE) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => SAMPLE_MODE_COUNT,
        };
        let sample_size = params
            .get(PARAM_SAMPLE_SIZE)
            .and_then(|v| v.as_float())
            .unwrap_or(1.0);

        let mut ordered_indices: Vec<usize> = (0..issue.invalid.len()).collect();
        sort_by_selection_mode(&mut ordered_indices, &issue.invalid, selection_mode, rng);

        let sample_count = resolve_sample_count(issue.invalid.len(), sample_mode, sample_size);
        let (sample_indices, rest_indices) = ordered_indices.split_at(sample_count);

        let mut pending: VecDeque<Vec<EdgeId>> = sample_indices
            .iter()
            .map(|&idx| issue.invalid[idx].clone())
            .collect();
        let mut local_valid: Vec<Vec<EdgeId>> = rest_indices
            .iter()
            .map(|&idx| issue.invalid[idx].clone())
            .chain(issue.valid.iter().cloned())
            .collect();

        let nested_params = crate::repair::params::build_params(
            cut_target.strategy.params(),
            Some(&cut_target.param_overrides),
        );
        let mut commands = Vec::new();
        let mut any_succeeded = false;

        while let Some(target) = pending.pop_front() {
            let mut synthetic_all: Vec<Vec<EdgeId>> =
                Vec::with_capacity(1 + pending.len() + local_valid.len());
            synthetic_all.push(target);
            synthetic_all.extend(pending.iter().cloned());
            synthetic_all.extend(local_valid.iter().cloned());
            let synthetic = InvalidLoopIssue::new_from_check(
                "invalid_loop_group_select",
                synthetic_all,
                vec![0],
                Default::default(),
            );

            let (nested_result, nested_commands) = cut_target.strategy.apply(
                &synthetic as &dyn crate::quality_control::Issue,
                maze,
                rng,
                &nested_params,
                preset_state,
                &cut_target.nested,
            );
            any_succeeded |= matches!(nested_result, RepairResult::Fixed { .. });

            let removed: HashSet<EdgeId> = removed_edge_ids(&nested_commands).into_iter().collect();
            if !removed.is_empty() {
                pending.retain(|cycle| !cycle.iter().any(|e| removed.contains(e)));
                local_valid.retain(|cycle| !cycle.iter().any(|e| removed.contains(e)));
            }

            commands.extend(nested_commands);
        }

        if any_succeeded {
            (RepairResult::Fixed { score: None }, commands)
        } else {
            (RepairResult::Failed, vec![])
        }
    }
}

crate::impl_erased_repair_strategy!(InvalidLoopGroupSelectStrategy, InvalidLoopGroupIssue);

/// Reorders `indices` (into `invalid`) in place by `mode` — `shortest`/`longest` by edge count
/// (ties broken by ascending original index for determinism), `random`/unrecognized via a
/// Fisher-Yates shuffle through `rng` (seed-reproducible, unlike leaving ascending index order in
/// place under a "random" label).
fn sort_by_selection_mode(
    indices: &mut [usize],
    invalid: &[Vec<EdgeId>],
    mode: &str,
    rng: &mut dyn RngCore,
) {
    match mode {
        SELECTION_SHORTEST => indices.sort_by_key(|&i| (invalid[i].len(), i)),
        SELECTION_LONGEST => indices.sort_by_key(|&i| (std::cmp::Reverse(invalid[i].len()), i)),
        _ => {
            for i in (1..indices.len()).rev() {
                let j = rng.random_range(0..=i);
                indices.swap(i, j);
            }
        }
    }
}

/// How many of `invalid_count` flagged cycles enter the sample — `count` mode takes `sample_size`
/// literally (rounded up), `percent` mode takes `ceil(sample_size / 100 * invalid_count)`. Either
/// way, clamped to `[1, invalid_count]`: at least 1 (there is always something to do when
/// `invalid_count > 0`, the only case this is called for — see `apply`'s early return), never more
/// than what's actually available.
fn resolve_sample_count(invalid_count: usize, sample_mode: &str, sample_size: f64) -> usize {
    let raw = match sample_mode {
        SAMPLE_MODE_PERCENT => (sample_size / 100.0 * invalid_count as f64).ceil(),
        _ => sample_size.ceil(),
    };
    (raw as usize).clamp(1, invalid_count)
}

#[cfg(test)]
#[path = "invalid_loop_group_select_tests.rs"]
mod tests;
