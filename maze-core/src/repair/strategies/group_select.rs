use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::{Issue, InvalidGroupIssue, InvalidGroupIssueKind};
use crate::generation::PresetState;
use crate::repair::params::{StrategyParams, StrategyParamValue};
use crate::repair::result::RepairResult;
use crate::repair::strategy::NestedStrategyConfig;
use crate::repair::command::MutationCommand;

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
            candidates.sort_by_key(|id| std::cmp::Reverse(membership.get(id).copied().unwrap_or(0)));
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
    if issue.groups.is_empty() {
        return (RepairResult::Fixed { score: None }, vec![]);
    }

    // Membership counts computed once up front, over the original (unresolved) group set — a
    // static snapshot, same rationale as `TeleportGroupSelectStrategy`'s own. Handed to
    // `order_candidates`; not every caller uses it.
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
        let mut any_allowed = false;
        for id in group {
            if !element_allowed(id) {
                continue;
            }
            any_allowed = true;
            groups_by_element.entry(id.clone()).or_default().push(i);
        }
        // A group with no allowed candidate at all (e.g. every side route-protected) can never
        // be resolved through the normal candidate pass -- it isn't a real problem to fix, since
        // every one of its elements is individually protected from removal, so it's treated as
        // already-resolved instead of carrying `to_remove > 0` forever and re-flagging on every
        // future QC iteration.
        if !any_allowed {
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
        let still_needed = groups_by_element.get(&target).is_some_and(|gs| gs.iter().any(|&gi| remaining[gi] > 0));
        if !still_needed {
            continue;
        }

        // Only elements still actually needed by some group (`remaining[gi] > 0`) count as "other
        // still-live candidates" -- an element whose every group already hit its budget stays a
        // `groups_by_element` key until it's itself picked or invalidated, but it's not a live
        // candidate anymore and must not leak stale context into `build_nested_issue`.
        let mut others: Vec<K::Element> = groups_by_element.iter()
            .filter(|(id, gs)| **id != target && gs.iter().any(|&gi| remaining[gi] > 0))
            .map(|(id, _)| id.clone())
            .collect();
        others.sort_unstable();
        let synthetic = build_nested_issue("group_select", &target, &others);
        let (nested_result, nested_commands) = nested.strategy.apply(
            synthetic.as_ref(), maze, rng, &nested_params, preset_state, &nested.nested,
        );

        if matches!(nested_result, RepairResult::Fixed { .. }) {
            any_succeeded = true;
            // The target itself always counts as invalidated, even when the nested strategy
            // converted rather than removed it (e.g. `OneWayToPassageStrategy`) -- plus every
            // other still-live candidate `element_invalidated` flags from this fix's own commands.
            // A shared/overlapping candidate can retire budget in several groups from a single fix.
            let mut invalidated: Vec<K::Element> = vec![target.clone()];
            invalidated.extend(others.into_iter().filter(|id| element_invalidated(id, &nested_commands, maze)));
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
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::ids::EdgeId;
    use crate::{Graph, IdGenerator};
    use crate::space::{SquareTessellation, square_rect};
    use crate::quality_control::issue::{IssueKind, INVALID_ONE_WAY, INVALID_ONE_WAY_GROUP};
    use crate::quality_control::{InvalidOneWayIssue, InvalidGroupIssue, InvalidGroupIssueKind};
    use crate::repair::strategy::{RepairStrategy, NestedSlot, NestedStrategyConfig, NestedDispatchKind};

    struct TestKind;
    impl InvalidGroupIssueKind for TestKind {
        type Element = EdgeId;
        const KIND: IssueKind = INVALID_ONE_WAY_GROUP;
        const NESTED_KIND: IssueKind = INVALID_ONE_WAY;
        const NESTED_SLOT_ID: &'static str = "test_fix_target";
    }
    type TestIssue = InvalidGroupIssue<TestKind>;

    static TEST_SLOT: NestedSlot = NestedSlot { slot_id: "test_fix_target", kind: INVALID_ONE_WAY, min: 1, max: Some(1), dispatch_kind: NestedDispatchKind::Unordered };

    fn empty_maze() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = crate::space::Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    /// Panics if ever called -- for `issue.groups.is_empty()`, `group_select_apply` must return
    /// early without making any nested call at all.
    struct UnreachableStrategy;
    impl<T: Tessellation> RepairStrategy<T, InvalidOneWayIssue> for UnreachableStrategy {
        fn strategy_id(&self) -> &'static str { "unreachable_stub" }
        fn apply(
            &self, _issue: &InvalidOneWayIssue, _maze: &Maze<T>, _rng: &mut dyn RngCore,
            _params: &StrategyParams, _preset_state: &PresetState, _nested: &[NestedStrategyConfig<T>],
        ) -> (RepairResult, Vec<MutationCommand>) {
            panic!("group_select_apply must not make a nested call for an empty issue.groups");
        }
    }
    crate::impl_erased_repair_strategy!(UnreachableStrategy, InvalidOneWayIssue);

    fn no_order(candidates: &mut Vec<EdgeId>, _membership: &HashMap<EdgeId, usize>, _rng: &mut dyn RngCore) {
        candidates.sort_unstable();
    }

    #[test]
    fn apply_succeeds_on_empty_groups() {
        let maze = empty_maze();
        let issue = TestIssue::new_from_check("test_check", vec![]);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = NestedStrategyConfig {
            slot: &TEST_SLOT,
            strategy: Box::new(UnreachableStrategy),
            param_overrides: HashMap::new(),
            nested: vec![],
        };
        let (result, commands) = group_select_apply::<SquareTessellation, TestKind>(
            &issue, &maze, &mut rng, &PresetState::empty(), &nested,
            |_| true,
            |check, target, others| Box::new(InvalidOneWayIssue::new_from_check(check, {
                let mut v = vec![*target]; v.extend_from_slice(others); v
            })),
            |_, _, _| false,
            no_order,
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(commands.is_empty());
    }

    #[test]
    fn others_passed_to_build_nested_issue_excludes_already_resolved_elements() {
        // group A = [e0, e1] to_remove=1, group B = [e2] to_remove=1. Fixing e0 resolves group A
        // outright (to_remove hits zero) but e1 stays a `groups_by_element` key (it's never picked
        // or invalidated). The very next candidate's `others` list must not still contain e1 --
        // it's no longer needed by any group with remaining > 0.
        let maze = empty_maze();
        let issue = TestIssue::new_from_check("test_check", vec![(vec![0, 1], 1), (vec![2], 1)]);
        let mut rng = MazeRng::seed_from_u64(1);
        let others_seen: Rc<RefCell<Vec<Vec<EdgeId>>>> = Rc::new(RefCell::new(Vec::new()));
        let others_seen_clone = others_seen.clone();

        struct CapturingStrategy {
            others_seen: Rc<RefCell<Vec<Vec<EdgeId>>>>,
        }
        impl<T: Tessellation> RepairStrategy<T, InvalidOneWayIssue> for CapturingStrategy {
            fn strategy_id(&self) -> &'static str { "capturing_stub" }
            fn apply(
                &self, issue: &InvalidOneWayIssue, _maze: &Maze<T>, _rng: &mut dyn RngCore,
                _params: &StrategyParams, _preset_state: &PresetState, _nested: &[NestedStrategyConfig<T>],
            ) -> (RepairResult, Vec<MutationCommand>) {
                // issue.invalid[0] is the target, the rest is `others` (see build_nested_issue below).
                self.others_seen.borrow_mut().push(issue.invalid[1..].to_vec());
                (RepairResult::Fixed { score: None }, vec![MutationCommand::RemoveEdge { id: issue.invalid[0] }])
            }
        }
        crate::impl_erased_repair_strategy!(CapturingStrategy, InvalidOneWayIssue);

        let nested = NestedStrategyConfig {
            slot: &TEST_SLOT,
            strategy: Box::new(CapturingStrategy { others_seen: others_seen_clone }),
            param_overrides: HashMap::new(),
            nested: vec![],
        };
        let (result, _commands) = group_select_apply::<SquareTessellation, TestKind>(
            &issue, &maze, &mut rng, &PresetState::empty(), &nested,
            |_| true,
            |check, target, others| Box::new(InvalidOneWayIssue::new_from_check(check, {
                let mut v = vec![*target]; v.extend_from_slice(others); v
            })),
            |_, _, _| false,
            no_order,
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        let calls = others_seen.borrow();
        assert_eq!(calls.len(), 2, "two candidates (e0, e2) expected -- e1 must never be picked as its own target since e0 resolves group A first");
        assert!(!calls[1].contains(&1), "e1's group was already fully resolved by e0 -- it must not appear in a later call's `others`: {:?}", calls[1]);
    }

    #[test]
    fn order_by_priority_problematic_visits_highest_membership_first() {
        let params = crate::repair::params::build_params(&[], None);
        let order = order_by_priority::<EdgeId>(&params);
        let mut candidates: Vec<EdgeId> = vec![0, 1, 2];
        let membership: HashMap<EdgeId, usize> = [(0, 1), (1, 3), (2, 1)].into_iter().collect();
        let mut rng = MazeRng::seed_from_u64(1);
        order(&mut candidates, &membership, &mut rng);
        assert_eq!(candidates[0], 1, "highest-membership candidate must be visited first under problematic priority");
    }
}
