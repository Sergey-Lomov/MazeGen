use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::{InvalidGroupIssue, InvalidGroupIssueKind};
use crate::generation::PresetState;
use crate::repair::params::{StrategyParams, StrategyParamValue};
use crate::repair::result::RepairResult;
use crate::repair::strategy::NestedStrategyConfig;
use crate::repair::command::MutationCommand;

pub const PARAM_PRIORITY: &str = "priority";

pub const PRIORITY_RANDOM: &str = "random";
pub const PRIORITY_PROBLEMATIC: &str = "problematic";

pub static PRIORITY_OPTIONS: &[&str] = &[PRIORITY_RANDOM, PRIORITY_PROBLEMATIC];

/// Shared `apply()` mechanics for `InvalidGroupIssue<K>` — see GitHub issue #208. Extracted from
/// `OneWayGroupSelectStrategy`, the canonical instance of this shape (see that module for the full
/// walkthrough this doc comment summarizes). A plain generic function, not a `RepairStrategy`
/// impl: every concrete group-select strategy (`OneWayGroupSelectStrategy` today, a future
/// teleport/loop-group counterpart) stays an ordinary unit struct with its own `strategy_id`/
/// `params`/`expected_nested`/`RepairStrategy` impl, calling this function from inside its own
/// `apply()` — the same shape every other strategy in this crate already has, just with the
/// per-candidate-pass mechanics factored out instead of copy-pasted per instantiation.
///
/// **Per-group `to_remove` budget**: a group is only dropped once its own `to_remove` budget
/// reaches zero, and each call works through every group's budget, not just one element total —
/// this is what lets a single large-excess group actually converge within a bounded number of
/// `apply()` calls instead of needing one repair iteration per excess element.
///
/// **Single global candidate pass, not one scan per group**: candidates are deduplicated into one
/// global list up front (`groups_by_element: element -> [group indices]`, elements `element_allowed`
/// rejects never enter it at all) and visited once, in priority order:
/// - `problematic`: every candidate shuffled first (so same-membership ties resolve randomly, not
///   by incidental `HashMap` iteration order), then stably sorted by membership count descending —
///   the element present in the most groups (membership counts computed once up front over the
///   original unresolved group set, a snapshot) is tried first, globally across every group.
/// - `random`/anything else: the same shuffle, used directly as the visiting order.
///
/// For each candidate still needed by at least one group with `to_remove > 0`, delegates the
/// actual fix to `nested` (already resolved by the caller against `K::NESTED_SLOT_ID`/
/// `K::NESTED_KIND` — this function doesn't look either up, just uses the config it's handed):
/// - On success, `K::resolved_elements` reads back every element the nested call actually resolved
///   (which may be more than just the offered candidate — e.g. a nested strategy's own commands
///   removing something beyond the single edge it was asked to fix) and retires one unit of budget
///   from every group that still needed one of those elements — a single shared element can retire
///   budget in several groups from one fix.
/// - On failure, the candidate is dropped from the reverse index too — the maze doesn't change
///   within one call, so a failed candidate would fail identically on a second try.
///
/// A group is resolved once its `to_remove` reaches zero; if the whole candidate pass runs out
/// (every remaining candidate filtered out, or already tried and failed) some groups may still
/// have `to_remove > 0` left — they simply carry over to the next repair iteration's fresh issue.
///
/// `element_allowed` mirrors what `OneWayGroupSelectStrategy`'s own `PARAM_PROTECT_ROUTE` filter
/// did before this extraction — the caller decides what "allowed" means for its own `K`
/// (`OneWayGroupSelectStrategy` excludes route-protected edges when its own param is set), this
/// function only ever calls it, never interprets it.
pub fn group_select_apply<T: Tessellation, K: InvalidGroupIssueKind>(
    issue: &InvalidGroupIssue<K>,
    maze: &Maze<T>,
    rng: &mut dyn RngCore,
    params: &StrategyParams,
    preset_state: &PresetState,
    nested: &NestedStrategyConfig<T>,
    element_allowed: impl Fn(&K::Element) -> bool,
) -> (RepairResult, Vec<MutationCommand>) {
    if issue.groups.is_empty() {
        return (RepairResult::Fixed { score: None }, vec![]);
    }

    let priority = match params.get(PARAM_PRIORITY) {
        Some(StrategyParamValue::Enum(v)) => v.as_str(),
        _ => PRIORITY_PROBLEMATIC,
    };

    // Membership counts computed once up front, over the original (unresolved) group set — a
    // static snapshot, same rationale as `TeleportGroupProximityStrategy`'s own.
    let mut membership: HashMap<K::Element, usize> = HashMap::new();
    for (group, _) in &issue.groups {
        for id in group {
            *membership.entry(id.clone()).or_insert(0) += 1;
        }
    }

    let nested_params = crate::repair::params::build_params(nested.strategy.params(), Some(&nested.param_overrides));

    // Remaining-to-remove budget per group, indexed the same as `issue.groups` — the only
    // per-group state left; candidate iteration itself is global (see below), not per-group, to
    // keep one call linear in the total candidate count instead of quadratic.
    let mut remaining: Vec<u32> = issue.groups.iter().map(|(_, to_remove)| *to_remove).collect();

    // Reverse index: element -> every group (by index into `issue.groups`/`remaining`) that still
    // lists it as a candidate. Built once; an element is removed from every entry the moment it's
    // fixed (or immediately if `element_allowed` rejects it), so later lookups never revisit a
    // resolved element.
    let mut groups_by_element: HashMap<K::Element, Vec<usize>> = HashMap::new();
    for (i, (group, _)) in issue.groups.iter().enumerate() {
        for id in group {
            if !element_allowed(id) {
                continue;
            }
            groups_by_element.entry(id.clone()).or_default().push(i);
        }
    }

    // One global candidate order instead of a per-group scan: `problematic` visits the
    // highest-membership elements first regardless of which group they belong to, `random` visits
    // in a single shuffled order. Either way each candidate is tried at most once per call.
    let mut candidates: Vec<K::Element> = groups_by_element.keys().cloned().collect();
    {
        use rand::seq::SliceRandom;
        // Shuffle first regardless of priority -- HashMap key iteration order is not itself seeded
        // by `rng` and must not leak into tie-break order. `problematic`'s stable sort on top of
        // an already-shuffled vector then makes same-membership ties resolve randomly, and
        // `random` keeps the shuffle as its own final order.
        candidates.shuffle(rng);
    }
    if priority == PRIORITY_PROBLEMATIC {
        candidates.sort_by_key(|id| std::cmp::Reverse(membership.get(id).copied().unwrap_or(0)));
    }

    let mut commands = Vec::new();
    let mut any_succeeded = false;

    for target in candidates {
        let still_needed = groups_by_element.get(&target).is_some_and(|gs| gs.iter().any(|&gi| remaining[gi] > 0));
        if !still_needed {
            continue;
        }

        let synthetic = K::nested_issue("group_select", target.clone());
        let (nested_result, nested_commands) = nested.strategy.apply(
            synthetic.as_ref(), maze, rng, &nested_params, preset_state, &nested.nested,
        );

        if matches!(nested_result, RepairResult::Fixed { .. }) {
            any_succeeded = true;
            let resolved = K::resolved_elements(&target, &nested_commands);
            // Every group that still needed one of the resolved elements retires one unit of
            // budget -- a shared element can retire budget in several groups from a single fix.
            for id in &resolved {
                if let Some(group_ids) = groups_by_element.remove(id) {
                    for gi in group_ids {
                        if remaining[gi] > 0 {
                            remaining[gi] -= 1;
                        }
                    }
                }
            }
            commands.extend(nested_commands);
        } else {
            // Failed -- this element never succeeds again within the same call (the maze it's
            // evaluated against doesn't change), so drop it everywhere rather than leaving it to
            // be retried from another group.
            groups_by_element.remove(&target);
        }
    }

    if any_succeeded {
        (RepairResult::Fixed { score: None }, commands)
    } else {
        (RepairResult::Failed, vec![])
    }
}
