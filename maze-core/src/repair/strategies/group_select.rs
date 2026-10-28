use crate::Maze;
use crate::generation::PresetState;
use crate::quality_control::{InvalidGroupIssue, InvalidGroupIssueKind, Issue};
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::NestedStrategyConfig;
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::HashMap;

pub const PARAM_PRIORITY: &str = "priority";

pub const PRIORITY_RANDOM: &str = "random";
pub const PRIORITY_PROBLEMATIC: &str = "problematic";

pub static PRIORITY_OPTIONS: &[&str] = &[PRIORITY_RANDOM, PRIORITY_PROBLEMATIC];

/// Shared `order_candidates` hook for `OneWayGroupSelectStrategy`/`TeleportGroupSelectStrategy` —
/// both order candidates by `PARAM_PRIORITY` exactly the same way (membership-based), so this is
/// the one place that behavior lives rather than being copy-pasted per strategy. `problematic`:
/// every candidate shuffled first (so same-membership ties resolve randomly, not by incidental
/// `HashMap` iteration order), then stably sorted by membership count descending — the element
/// present in the most groups is tried first, globally across every group. `random`/anything else:
/// the same shuffle, used directly as the visiting order.
pub fn order_by_priority<E: Clone + Eq + std::hash::Hash>(
    params: &StrategyParams,
) -> impl Fn(&mut Vec<E>, &HashMap<E, usize>, &mut dyn RngCore) + '_ {
    move |candidates: &mut Vec<E>, membership: &HashMap<E, usize>, rng: &mut dyn RngCore| {
        let priority = match params.get(PARAM_PRIORITY) {
            Some(StrategyParamValue::Enum(v)) => v.as_str(),
            _ => PRIORITY_PROBLEMATIC,
        };
        {
            use rand::seq::SliceRandom;
            // Shuffle first regardless of priority -- HashMap key iteration order is not itself
            // seeded by `rng` and must not leak into tie-break order. `problematic`'s stable sort
            // on top of an already-shuffled vector then makes same-membership ties resolve
            // randomly, and `random` keeps the shuffle as its own final order.
            candidates.shuffle(rng);
        }
        if priority == PRIORITY_PROBLEMATIC {
            candidates
                .sort_by_key(|id| std::cmp::Reverse(membership.get(id).copied().unwrap_or(0)));
        }
    }
}

/// Shared `apply()` mechanics for `InvalidGroupIssue<K>` — see GitHub issue #208. Extracted from
/// `OneWayGroupSelectStrategy`, the canonical instance of this shape (see that module for the full
/// walkthrough this doc comment summarizes). A plain generic function, not a `RepairStrategy`
/// impl: every concrete group-select strategy (`OneWayGroupSelectStrategy`,
/// `TeleportGroupSelectStrategy` — see GitHub issue #209 — today) stays an ordinary unit struct
/// with its own `strategy_id`/`params`/`expected_nested`/`RepairStrategy` impl, calling this
/// function from inside its own `apply()` — the same shape every other strategy in this crate
/// already has, just with the per-candidate-pass mechanics factored out instead of copy-pasted
/// per instantiation.
///
/// **Per-group `to_remove` budget**: a group is only dropped once its own `to_remove` budget
/// reaches zero, and each call works through every group's budget, not just one element total —
/// this is what lets a single large-excess group actually converge within a bounded number of
/// `apply()` calls instead of needing one repair iteration per excess element.
///
/// **Single global candidate pass, not one scan per group**: candidates are deduplicated into one
/// global list up front (`groups_by_element: element -> [group indices]`, elements `element_allowed`
/// rejects never enter it at all) and visited once, in whatever order `order_candidates` puts them
/// in — GitHub issue #210: a hook rather than a fixed random/problematic-by-membership scheme,
/// since what "prioritized" means is strategy-specific. `OneWayGroupSelectStrategy`/
/// `TeleportGroupSelectStrategy` share `order_by_priority` (above). `membership` (every element's
/// count across the original, unresolved group set — a snapshot computed once up front) is handed
/// to `order_candidates` for callers that want it, but a caller is free to ignore it entirely.
///
/// For each candidate still needed by at least one group with `to_remove > 0`, `build_nested_issue`
/// (given the candidate and every other still-live candidate as context) builds the synthetic
/// `Issue` delegated to `nested` — GitHub issue #210: this is the calling strategy's own call, not
/// `K`'s, since only the strategy knows what its nested slot actually needs.
/// - On success, every other still-live candidate is offered to `element_invalidated` (given the
///   candidate, the nested call's own commands, and the pre-mutation `maze` snapshot) — GitHub
///   issue #210: a hook rather than a fixed `resolved_elements` list, since what counts as "this
///   candidate is now moot" is strategy-specific (`OneWayGroupSelectStrategy`: the candidate
///   equals a removed edge id; `TeleportGroupSelectStrategy`: the candidate equals a removed edge
///   id or is that removal's opposite-direction `Teleport` counterpart, read from `maze` via
///   `Graph::teleport_reverse` since `removed_edge_ids` never surfaces a
///   `RemoveTeleportWithReverse` command's reverse id — GitHub issue #171's known gap). The target
///   itself always counts as invalidated too, whether or not `element_invalidated` says so (mirrors
///   the old `resolved_elements` contract of always including `target`), since a nested strategy
///   converting rather than removing it (e.g. `OneWayToPassageStrategy`) must still retire its own
///   budget. Every group that still needed an invalidated candidate retires one unit of budget — a
///   single shared/overlapping candidate can retire budget in several groups from one fix.
/// - On failure, the candidate is dropped from the reverse index too — the maze doesn't change
///   within one call, so a failed candidate would fail identically on a second try.
///
/// A group is resolved once its `to_remove` reaches zero; if the whole candidate pass runs out
/// (every remaining candidate filtered out, or already tried and failed) some groups may still
/// have `to_remove > 0` left — they simply carry over to the next repair iteration's fresh issue.
///
/// **Wholly-protected groups auto-resolve, but only count toward the overall result if some
/// *other* group actually got fixed.** A group none of whose elements pass `element_allowed`
/// (e.g. every side of a proximity pair is route-critical) never enters `groups_by_element` at
/// all, so the normal candidate pass could never touch it — its own `to_remove` is zeroed out up
/// front instead of being left to carry over forever, since it isn't a real problem to fix: every
/// element implicated in it is individually protected from removal, so there is nothing left to
/// act on. This alone does **not** make the overall call `Fixed` — the result is still governed
/// entirely by `any_succeeded` below (at least one nested call actually returned `Fixed`). If
/// *every* group in the issue is wholly-protected, the call returns `Failed`, same as before this
/// auto-resolve existed — mirroring `TeleportGroupSelectStrategy`'s pre-#209 "both sides
/// route-protected — leave the pair untouched" case, which likewise reported nothing to do. A
/// mixed issue (one wholly-protected group, one resolvable group) still returns `Fixed`, from the
/// resolvable group's own genuine progress — the wholly-protected group just doesn't drag the
/// call down or get offered candidates that can never succeed.
///
/// `element_allowed` mirrors what `OneWayGroupSelectStrategy`'s own `PARAM_PROTECT_ROUTE` filter
/// did before this extraction — the caller decides what "allowed" means for its own `K`
/// (`OneWayGroupSelectStrategy` excludes route-protected edges when its own param is set), this
/// function only ever calls it, never interprets it.
#[allow(clippy::too_many_arguments)]
pub fn group_select_apply<T: Tessellation, K: InvalidGroupIssueKind>(
    issue: &InvalidGroupIssue<K>,
    maze: &Maze<T>,
    rng: &mut dyn RngCore,
    preset_state: &PresetState,
    nested: &NestedStrategyConfig<T>,
    element_allowed: impl Fn(&K::Element) -> bool,
    build_nested_issue: impl Fn(&str, &K::Element, &[K::Element]) -> Box<dyn Issue>,
    element_invalidated: impl Fn(&K::Element, &[MutationCommand], &Maze<T>) -> bool,
    order_candidates: impl Fn(&mut Vec<K::Element>, &HashMap<K::Element, usize>, &mut dyn RngCore),
) -> (RepairResult, Vec<MutationCommand>) {
    let nested_params = crate::repair::params::build_params(
        nested.strategy.params(),
        Some(&nested.param_overrides),
    );
    // Single-slot special case of `multi_target_group_select_apply`: `nested_for` ignores the
    // element itself and always hands back the one configured slot (with the same synthetic
    // issue `build_nested_issue` produced), or `None` when `element_allowed` rejects it — which
    // the engine, with `wholly_protected_auto_resolve: true`, treats exactly as the old
    // `element_allowed` reject path did (zero the group's budget up front, auto-resolve a
    // wholly-protected group).
    run_group_candidate_pass::<T, K>(
        &issue.groups,
        &issue.invalid_sources,
        maze,
        rng,
        preset_state,
        |element, others| {
            if !element_allowed(element) {
                return None;
            }
            Some((
                nested,
                &nested_params,
                build_nested_issue("group_select", element, others),
            ))
        },
        element_invalidated,
        order_candidates,
        true,
    )
}

/// Multi-slot generalization of [`group_select_apply`] — the base engine behind
/// `CrossElementGroupSelectStrategy` (GitHub issue #376). Same candidate-pass / per-group
/// `to_remove` budget / reverse-index-by-`K::Element`-identity mechanics, but the "which nested
/// strategy fixes this element and what issue does it get" decision is a single `nested_for`
/// hook the caller owns end to end — a cross-element group's elements are heterogeneous
/// (teleport, elevator, split, ...), each fixed by a different nested slot, so there is no one
/// `NestedStrategyConfig` / one `build_nested_issue` to hand in.
///
/// `nested_for(element, others) -> Option<(&NestedStrategyConfig<T>, &StrategyParams, Box<dyn Issue>)>`:
/// - `None` means this element cannot be acted on (Start/Finish, a route-protected edge under
///   `protect_route`, an unmapped type) — it is never offered as a candidate, same as
///   `element_allowed` returning `false` in the single-slot case.
/// - `Some((cfg, params, issue))` binds one nested slot, its pre-built params, and the synthetic
///   issue to run against it. The caller re-resolves the entity from `maze` when building the
///   issue (never a value cached in the `CrossElement`), since an earlier fix in the same pass
///   may have changed it.
///
/// `wholly_protected_auto_resolve`:
/// - `true` (the `group_select_apply` contract): a group none of whose elements `nested_for`
///   accepts has its `to_remove` zeroed up front — "user protected every side, nothing to fix".
/// - `false` (cross-element): such a group keeps `to_remove > 0` and drags the call to `Failed`
///   if nothing else succeeds — `[Start, Finish]` is a real unmet constraint the user should
///   see re-flagged, not silently resolved.
///
/// Result: `Fixed` iff at least one nested call returned `Fixed`; `Failed` otherwise. A
/// wholly-protected group never counts as a success on its own.
#[allow(clippy::too_many_arguments)]
pub fn multi_target_group_select_apply<'a, T: Tessellation + 'a, K: InvalidGroupIssueKind>(
    groups: &[(Vec<K::Element>, u32)],
    invalid_sources: &HashMap<Vec<K::Element>, Vec<String>>,
    maze: &Maze<T>,
    rng: &mut dyn RngCore,
    preset_state: &PresetState,
    nested_for: impl Fn(
        &K::Element,
        &[K::Element],
    ) -> Option<(
        &'a NestedStrategyConfig<T>,
        &'a StrategyParams,
        Box<dyn Issue>,
    )>,
    element_invalidated: impl Fn(&K::Element, &[MutationCommand], &Maze<T>) -> bool,
    order_candidates: impl Fn(&mut Vec<K::Element>, &HashMap<K::Element, usize>, &mut dyn RngCore),
    wholly_protected_auto_resolve: bool,
) -> (RepairResult, Vec<MutationCommand>) {
    run_group_candidate_pass::<T, K>(
        groups,
        invalid_sources,
        maze,
        rng,
        preset_state,
        nested_for,
        element_invalidated,
        order_candidates,
        wholly_protected_auto_resolve,
    )
}

/// Shared candidate-pass core for [`group_select_apply`] and [`multi_target_group_select_apply`].
/// See their doc comments for the behavior contract; this function is the one place the
/// membership snapshot, per-group `to_remove` budget, reverse index, global single-pass
/// candidate visit, and wholly-protected handling actually live.
///
/// `invalid_sources` is currently unused by the pass itself (kept in the signature so a future
/// per-group attribution hook has it without another plumbing change) — the `to_remove` budget
/// and membership come entirely from `groups`.
#[allow(clippy::too_many_arguments)]
fn run_group_candidate_pass<'a, T: Tessellation + 'a, K: InvalidGroupIssueKind>(
    groups: &[(Vec<K::Element>, u32)],
    _invalid_sources: &HashMap<Vec<K::Element>, Vec<String>>,
    maze: &Maze<T>,
    rng: &mut dyn RngCore,
    preset_state: &PresetState,
    nested_for: impl Fn(
        &K::Element,
        &[K::Element],
    ) -> Option<(
        &'a NestedStrategyConfig<T>,
        &'a StrategyParams,
        Box<dyn Issue>,
    )>,
    element_invalidated: impl Fn(&K::Element, &[MutationCommand], &Maze<T>) -> bool,
    order_candidates: impl Fn(&mut Vec<K::Element>, &HashMap<K::Element, usize>, &mut dyn RngCore),
    wholly_protected_auto_resolve: bool,
) -> (RepairResult, Vec<MutationCommand>) {
    if groups.is_empty() {
        return (RepairResult::Fixed { score: None }, vec![]);
    }

    // Membership counts computed once up front, over the original (unresolved) group set — a
    // static snapshot, same rationale as `TeleportGroupSelectStrategy`'s own. Handed to
    // `order_candidates`; not every caller uses it.
    let mut membership: HashMap<K::Element, usize> = HashMap::new();
    for (group, _) in groups {
        for id in group {
            *membership.entry(id.clone()).or_insert(0) += 1;
        }
    }

    // Remaining-to-remove budget per group, indexed the same as `groups` — the only per-group
    // state left; candidate iteration itself is global (see below), not per-group, to keep one
    // call linear in the total candidate count instead of quadratic.
    let mut remaining: Vec<u32> = groups.iter().map(|(_, to_remove)| *to_remove).collect();

    // Reverse index: element -> every group (by index into `groups`/`remaining`) that still
    // lists it as a candidate. Built once; an element is removed from every entry the moment
    // it's fixed (or immediately if `nested_for` rejects it), so later lookups never revisit a
    // resolved element.
    let mut groups_by_element: HashMap<K::Element, Vec<usize>> = HashMap::new();
    for (i, (group, _)) in groups.iter().enumerate() {
        let mut any_allowed = false;
        for id in group {
            // `nested_for`'s `others` arg only matters once a candidate is actually being fixed;
            // for the up-front allowed/not-allowed probe an empty slice is enough (no caller's
            // `None`/`Some` decision depends on the context list).
            if nested_for(id, &[]).is_none() {
                continue;
            }
            any_allowed = true;
            groups_by_element.entry(id.clone()).or_default().push(i);
        }
        // A group with no actionable candidate at all (e.g. every side route-protected, or a
        // `[Start, Finish]` pair). Under `wholly_protected_auto_resolve` it is treated as
        // already-resolved (its budget zeroed) rather than carrying `to_remove > 0` forever;
        // otherwise it keeps its budget and will pull the overall result to `Failed`.
        if !any_allowed && wholly_protected_auto_resolve {
            remaining[i] = 0;
        }
    }

    // One global candidate order instead of a per-group scan -- each candidate is tried at most
    // once per call, in whatever order `order_candidates` puts them in. `HashMap::keys()`'s own
    // iteration order is seeded per-instance (not per-process), so two `groups_by_element`
    // instances built from identical input can still iterate in different orders within the same
    // process -- sorted here first so `order_candidates`'s shuffle/sort always starts from the
    // same baseline order for the same input, keeping the whole call reproducible for a fixed
    // `rng` seed (`K::Element: Ord` is already required for `canonical_group_key`).
    let mut candidates: Vec<K::Element> = groups_by_element.keys().cloned().collect();
    candidates.sort_unstable();
    order_candidates(&mut candidates, &membership, rng);

    let mut commands = Vec::new();
    let mut any_succeeded = false;

    for target in candidates {
        let still_needed = groups_by_element
            .get(&target)
            .is_some_and(|gs| gs.iter().any(|&gi| remaining[gi] > 0));
        if !still_needed {
            continue;
        }

        // Only elements still actually needed by some group (`remaining[gi] > 0`) count as "other
        // still-live candidates" -- an element whose every group already hit its budget stays a
        // `groups_by_element` key until it's itself picked or invalidated, but it's not a live
        // candidate anymore and must not leak stale context into `nested_for`.
        let mut others: Vec<K::Element> = groups_by_element
            .iter()
            .filter(|(id, gs)| **id != target && gs.iter().any(|&gi| remaining[gi] > 0))
            .map(|(id, _)| id.clone())
            .collect();
        others.sort_unstable();

        let Some((cfg, params, synthetic)) = nested_for(&target, &others) else {
            // `nested_for` went from `Some` (during index build) to `None` now — an earlier fix
            // in this same pass changed the maze out from under this element. Drop it; it can't
            // be acted on anymore.
            groups_by_element.remove(&target);
            continue;
        };
        let (nested_result, nested_commands) = cfg.strategy.apply(
            synthetic.as_ref(),
            maze,
            rng,
            params,
            preset_state,
            &cfg.nested,
        );

        if matches!(nested_result, RepairResult::Fixed { .. }) {
            any_succeeded = true;
            // The target itself always counts as invalidated, even when the nested strategy
            // converted rather than removed it (e.g. `OneWayToPassageStrategy`) -- plus every
            // other still-live candidate `element_invalidated` flags from this fix's own commands.
            // A shared/overlapping candidate can retire budget in several groups from a single fix.
            let mut invalidated: Vec<K::Element> = vec![target.clone()];
            invalidated.extend(
                others
                    .into_iter()
                    .filter(|id| element_invalidated(id, &nested_commands, maze)),
            );
            for id in &invalidated {
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

#[cfg(test)]
#[path = "group_select_tests.rs"]
mod tests;
