use crate::Maze;
use crate::generation::PresetState;
use crate::ids::EdgeId;
use crate::quality_control::{
    INVALID_LOOP, InvalidGroupIssue, InvalidLoopGroupIssue, InvalidLoopGroupRequirement,
    InvalidLoopIssue, Issue, LoopGroupKind,
};
use crate::repair::command::{MutationCommand, removed_edge_ids};
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategies::group_select::group_select_apply;
use crate::repair::strategy::{
    NestedDispatchKind, NestedSlot, NestedStrategyConfig, RepairStrategy,
};
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::{HashMap, HashSet};

pub const PARAM_SELECTION_MODE: &str = "selection_mode";

pub const SELECTION_RANDOM: &str = "random";
pub const SELECTION_SHORTEST: &str = "shortest";
pub const SELECTION_LONGEST: &str = "longest";

static SELECTION_MODE_OPTIONS: &[&str] = &[SELECTION_RANDOM, SELECTION_SHORTEST, SELECTION_LONGEST];

static PARAMS: &[StrategyParam] = &[StrategyParam {
    id: PARAM_SELECTION_MODE,
    label: "Target cycle selection",
    kind: StrategyParamKind::Enum {
        options: SELECTION_MODE_OPTIONS,
        default: SELECTION_RANDOM,
    },
}];

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

/// Handles `INVALID_LOOP_GROUP` (see GitHub issue #183) with one shared group candidate pass over
/// the complete live set of flagged cycles, delegating each selected cycle to a nested strategy
/// (typically `InvalidLoopRandomStrategy`/`InvalidLoopScoredStrategy`) filling the `cut_target`
/// slot. `selection_mode` (random/shortest/longest) is the global candidate order.
///
/// Each nested `InvalidLoopIssue` is built from the selected cycle (its only `invalid` entry), the
/// other still-live flagged cycles, and the original `issue.valid` cycles as context. After a
/// successful nested repair, every still-live candidate containing a removed edge is invalidated
/// (it is broken by the same cut) and never offered again; a failed candidate is never retried
/// within the same call. Returns `Fixed` only if at least one nested repair succeeded.
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

        // One group holding every distinct flagged cycle; each invalidated candidate retires one
        // unit, so the group is resolved exactly when no live candidate remains.
        let distinct: HashSet<&Vec<EdgeId>> = issue.invalid.iter().collect();
        let group_issue = InvalidGroupIssue::<LoopGroupKind>::new_from_check(
            "invalid_loop_group_select",
            vec![(issue.invalid.clone(), distinct.len() as u32)],
        );

        let build_nested_issue =
            |source_check: &str, target: &Vec<EdgeId>, others: &[Vec<EdgeId>]| -> Box<dyn Issue> {
                let mut all: Vec<Vec<EdgeId>> =
                    Vec::with_capacity(1 + others.len() + issue.valid.len());
                all.push(target.clone());
                all.extend(others.iter().cloned());
                all.extend(issue.valid.iter().cloned());
                Box::new(InvalidLoopIssue::new_from_check(
                    source_check,
                    all,
                    vec![0],
                    Default::default(),
                ))
            };
        let element_invalidated =
            |cycle: &Vec<EdgeId>, commands: &[MutationCommand], maze: &Maze<T>| {
                cycle_broken_by(cycle, commands, maze)
            };
        let order_candidates = |candidates: &mut Vec<Vec<EdgeId>>,
                                _membership: &HashMap<Vec<EdgeId>, usize>,
                                rng: &mut dyn RngCore| {
            order_by_selection_mode(candidates, selection_mode, rng)
        };

        group_select_apply::<T, LoopGroupKind>(
            &group_issue,
            maze,
            rng,
            preset_state,
            cut_target,
            |_| true,
            build_nested_issue,
            element_invalidated,
            order_candidates,
        )
    }
}

crate::impl_erased_repair_strategy!(InvalidLoopGroupSelectStrategy, InvalidLoopGroupIssue);

/// Whether `commands` remove any edge of `cycle`. A `*WithReverse` removal also drops the
/// opposite-direction leg, which `removed_edge_ids` never surfaces (it reports the primary id
/// only), so the reverse is resolved against the pre-mutation `maze` here: a cycle traversing the
/// same corridor in the opposite direction is broken by that cut too and must not be offered to
/// the nested strategy again.
fn cycle_broken_by<T: Tessellation>(
    cycle: &[EdgeId],
    commands: &[MutationCommand],
    maze: &Maze<T>,
) -> bool {
    let mut removed: HashSet<EdgeId> = removed_edge_ids(commands).into_iter().collect();
    for command in commands {
        let reverse = match command {
            MutationCommand::RemoveEdgeWithReverse { id } => {
                maze.graph.edge(*id).and_then(|edge| {
                    maze.graph
                        .edge_between(edge.to, edge.from)
                        .filter(|reverse| reverse != id)
                })
            }
            MutationCommand::RemoveTeleportWithReverse { id } => maze.graph.teleport_reverse(*id),
            MutationCommand::RemoveVerticalPassageWithReverse { id } => {
                maze.graph.vertical_passage_reverse(*id)
            }
            _ => None,
        };
        removed.extend(reverse);
    }
    cycle.iter().any(|e| removed.contains(e))
}

/// Reorders `candidates` in place by `mode` — `shortest`/`longest` by edge count (stable, so ties
/// keep the pass's deterministic baseline order), `random`/unrecognized via a shuffle through
/// `rng` (seed-reproducible).
fn order_by_selection_mode(candidates: &mut [Vec<EdgeId>], mode: &str, rng: &mut dyn RngCore) {
    use rand::seq::SliceRandom;
    match mode {
        SELECTION_SHORTEST => candidates.sort_by_key(|c| c.len()),
        SELECTION_LONGEST => candidates.sort_by_key(|c| std::cmp::Reverse(c.len())),
        _ => candidates.shuffle(rng),
    }
}

#[cfg(test)]
#[path = "invalid_loop_group_select_tests.rs"]
mod tests;
