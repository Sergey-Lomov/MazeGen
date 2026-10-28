use super::*;
use crate::ids::EdgeId;
use crate::quality_control::issue::{INVALID_ONE_WAY, INVALID_ONE_WAY_GROUP, IssueKind};
use crate::quality_control::{InvalidGroupIssue, InvalidGroupIssueKind, InvalidOneWayIssue};
use crate::random::MazeRng;
use crate::repair::strategy::{
    NestedDispatchKind, NestedSlot, NestedStrategyConfig, RepairStrategy,
};
use crate::space::{SquareTessellation, square_rect};
use crate::{Graph, IdGenerator};
use rand::SeedableRng;
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

struct TestKind;
impl InvalidGroupIssueKind for TestKind {
    type Element = EdgeId;
    const KIND: IssueKind = INVALID_ONE_WAY_GROUP;
    const NESTED_KIND: IssueKind = INVALID_ONE_WAY;
    const NESTED_SLOT_ID: &'static str = "test_fix_target";
}
type TestIssue = InvalidGroupIssue<TestKind>;

static TEST_SLOT: NestedSlot = NestedSlot {
    slot_id: "test_fix_target",
    kind: INVALID_ONE_WAY,
    min: 1,
    max: Some(1),
    dispatch_kind: NestedDispatchKind::Unordered,
};

fn empty_maze() -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let field =
        crate::space::MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids)
            .unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    Maze::new(field, g)
}

/// Panics if ever called -- for `issue.groups.is_empty()`, `group_select_apply` must return
/// early without making any nested call at all.
struct UnreachableStrategy;
impl<T: Tessellation> RepairStrategy<T, InvalidOneWayIssue> for UnreachableStrategy {
    fn strategy_id(&self) -> &'static str {
        "unreachable_stub"
    }
    fn apply(
        &self,
        _issue: &InvalidOneWayIssue,
        _maze: &Maze<T>,
        _rng: &mut dyn RngCore,
        _params: &StrategyParams,
        _preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        panic!("group_select_apply must not make a nested call for an empty issue.groups");
    }
}
crate::impl_erased_repair_strategy!(UnreachableStrategy, InvalidOneWayIssue);

#[allow(clippy::ptr_arg)]
fn no_order(
    candidates: &mut Vec<EdgeId>,
    _membership: &HashMap<EdgeId, usize>,
    _rng: &mut dyn RngCore,
) {
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
        &issue,
        &maze,
        &mut rng,
        &PresetState::empty(),
        &nested,
        |_| true,
        |check, target, others| {
            Box::new(InvalidOneWayIssue::new_from_check(check, {
                let mut v = vec![*target];
                v.extend_from_slice(others);
                v
            }))
        },
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
        fn strategy_id(&self) -> &'static str {
            "capturing_stub"
        }
        fn apply(
            &self,
            issue: &InvalidOneWayIssue,
            _maze: &Maze<T>,
            _rng: &mut dyn RngCore,
            _params: &StrategyParams,
            _preset_state: &PresetState,
            _nested: &[NestedStrategyConfig<T>],
        ) -> (RepairResult, Vec<MutationCommand>) {
            // issue.invalid[0] is the target, the rest is `others` (see build_nested_issue below).
            self.others_seen
                .borrow_mut()
                .push(issue.invalid[1..].to_vec());
            (
                RepairResult::Fixed { score: None },
                vec![MutationCommand::RemoveEdge {
                    id: issue.invalid[0],
                }],
            )
        }
    }
    crate::impl_erased_repair_strategy!(CapturingStrategy, InvalidOneWayIssue);

    let nested = NestedStrategyConfig {
        slot: &TEST_SLOT,
        strategy: Box::new(CapturingStrategy {
            others_seen: others_seen_clone,
        }),
        param_overrides: HashMap::new(),
        nested: vec![],
    };
    let (result, _commands) = group_select_apply::<SquareTessellation, TestKind>(
        &issue,
        &maze,
        &mut rng,
        &PresetState::empty(),
        &nested,
        |_| true,
        |check, target, others| {
            Box::new(InvalidOneWayIssue::new_from_check(check, {
                let mut v = vec![*target];
                v.extend_from_slice(others);
                v
            }))
        },
        |_, _, _| false,
        no_order,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let calls = others_seen.borrow();
    assert_eq!(
        calls.len(),
        2,
        "two candidates (e0, e2) expected -- e1 must never be picked as its own target since e0 resolves group A first"
    );
    assert!(
        !calls[1].contains(&1),
        "e1's group was already fully resolved by e0 -- it must not appear in a later call's `others`: {:?}",
        calls[1]
    );
}

#[test]
fn order_by_priority_problematic_visits_highest_membership_first() {
    let params = crate::repair::params::build_params(&[], None);
    let order = order_by_priority::<EdgeId>(&params);
    let mut candidates: Vec<EdgeId> = vec![0, 1, 2];
    let membership: HashMap<EdgeId, usize> = [(0, 1), (1, 3), (2, 1)].into_iter().collect();
    let mut rng = MazeRng::seed_from_u64(1);
    order(&mut candidates, &membership, &mut rng);
    assert_eq!(
        candidates[0], 1,
        "highest-membership candidate must be visited first under problematic priority"
    );
}

// ---- multi_target_group_select_apply ----------------------------------------------------

/// Removes `issue.invalid[0]` and reports `Fixed`. Reused across the multi-target tests as a
/// stand-in for any concrete `Remove*` nested strategy.
struct RemoveFirstStrategy;
impl<T: Tessellation> RepairStrategy<T, InvalidOneWayIssue> for RemoveFirstStrategy {
    fn strategy_id(&self) -> &'static str {
        "remove_first_stub"
    }
    fn apply(
        &self,
        issue: &InvalidOneWayIssue,
        _maze: &Maze<T>,
        _rng: &mut dyn RngCore,
        _params: &StrategyParams,
        _preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        (
            RepairResult::Fixed { score: None },
            vec![MutationCommand::RemoveEdge {
                id: issue.invalid[0],
            }],
        )
    }
}
crate::impl_erased_repair_strategy!(RemoveFirstStrategy, InvalidOneWayIssue);

fn remove_first_config() -> NestedStrategyConfig<SquareTessellation> {
    NestedStrategyConfig {
        slot: &TEST_SLOT,
        strategy: Box::new(RemoveFirstStrategy),
        param_overrides: HashMap::new(),
        nested: vec![],
    }
}

fn one_way_issue(check: &str, target: &EdgeId, others: &[EdgeId]) -> Box<dyn Issue> {
    let mut v = vec![*target];
    v.extend_from_slice(others);
    Box::new(InvalidOneWayIssue::new_from_check(check, v))
}

#[test]
fn multi_target_empty_groups_makes_no_nested_call() {
    let maze = empty_maze();
    let mut rng = MazeRng::seed_from_u64(1);
    let cfg = NestedStrategyConfig {
        slot: &TEST_SLOT,
        strategy: Box::new(UnreachableStrategy),
        param_overrides: HashMap::new(),
        nested: vec![],
    };
    let params = crate::repair::params::build_params(&[], None);
    let (result, commands) = multi_target_group_select_apply::<SquareTessellation, TestKind>(
        &[],
        &HashMap::new(),
        &maze,
        &mut rng,
        &PresetState::empty(),
        |_, _| {
            Some((
                &cfg,
                &params,
                Box::new(InvalidOneWayIssue::new_from_check("c", vec![0])),
            ))
        },
        |_, _, _| false,
        no_order,
        false,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(commands.is_empty());
}

#[test]
fn multi_target_wholly_protected_group_fails_when_auto_resolve_is_false() {
    // Single group, `nested_for` rejects every element (Start/Finish analogue). With
    // `wholly_protected_auto_resolve: false` the budget is kept and the call reports Failed.
    let maze = empty_maze();
    let mut rng = MazeRng::seed_from_u64(1);
    let cfg = remove_first_config();
    let params = crate::repair::params::build_params(&[], None);
    let groups = vec![(vec![0_usize, 1_usize], 1_u32)];
    let (result, commands) = multi_target_group_select_apply::<SquareTessellation, TestKind>(
        &groups,
        &HashMap::new(),
        &maze,
        &mut rng,
        &PresetState::empty(),
        |_, _| {
            let _ = (&cfg, &params);
            None
        },
        |_, _, _| false,
        no_order,
        false,
    );
    assert!(matches!(result, RepairResult::Failed));
    assert!(commands.is_empty());
}

#[test]
fn multi_target_wholly_protected_group_auto_resolves_when_flag_is_true() {
    // Same setup but `wholly_protected_auto_resolve: true` — matches `group_select_apply`'s
    // contract: a fully protected group is treated as resolved. Nothing succeeded, so the
    // overall result is still Failed (no *other* group made progress), but no panic and the
    // budget was zeroed.
    let maze = empty_maze();
    let mut rng = MazeRng::seed_from_u64(1);
    let groups = vec![(vec![0_usize, 1_usize], 1_u32)];
    let (result, _commands) = multi_target_group_select_apply::<SquareTessellation, TestKind>(
        &groups,
        &HashMap::new(),
        &maze,
        &mut rng,
        &PresetState::empty(),
        |_, _| None,
        |_, _, _| false,
        no_order,
        true,
    );
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn multi_target_mixed_issue_fixes_the_actionable_group_and_leaves_the_protected_one() {
    // group A = [e0, e1] fully protected; group B = [e2] actionable. Result is Fixed from B,
    // A is untouched.
    let maze = empty_maze();
    let mut rng = MazeRng::seed_from_u64(1);
    let cfg = remove_first_config();
    let params = crate::repair::params::build_params(&[], None);
    let groups = vec![(vec![0_usize, 1_usize], 1_u32), (vec![2_usize], 1_u32)];
    let (result, commands) = multi_target_group_select_apply::<SquareTessellation, TestKind>(
        &groups,
        &HashMap::new(),
        &maze,
        &mut rng,
        &PresetState::empty(),
        |e, others| {
            if *e == 2 {
                Some((&cfg, &params, one_way_issue("b", e, others)))
            } else {
                None
            }
        },
        |_, _, _| false,
        no_order,
        false,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(commands, vec![MutationCommand::RemoveEdge { id: 2 }]);
}

#[test]
fn multi_target_shared_element_across_two_groups_is_fixed_once_and_resolves_both() {
    // group A = [e0, e1], group B = [e0, e2]. e0 is shared. One nested call on e0 must
    // retire the budget of BOTH groups, so e1/e2 are never offered.
    let maze = empty_maze();
    let mut rng = MazeRng::seed_from_u64(1);
    let cfg = remove_first_config();
    let params = crate::repair::params::build_params(&[], None);
    // Count only real fix attempts (non-empty `others`), not the empty-slice index-build probes.
    let fix_targets: Rc<RefCell<Vec<EdgeId>>> = Rc::new(RefCell::new(Vec::new()));
    let fix_targets_seen = fix_targets.clone();
    let groups = vec![
        (vec![0_usize, 1_usize], 1_u32),
        (vec![0_usize, 2_usize], 1_u32),
    ];
    let (result, commands) = multi_target_group_select_apply::<SquareTessellation, TestKind>(
        &groups,
        &HashMap::new(),
        &maze,
        &mut rng,
        &PresetState::empty(),
        |e, others| {
            if !others.is_empty() {
                fix_targets_seen.borrow_mut().push(*e);
            }
            Some((&cfg, &params, one_way_issue("c", e, others)))
        },
        // e0 removed => e1 and e2 (the "others") are NOT auto-invalidated by edge id here;
        // the shared-membership retirement must come from `groups_by_element` bookkeeping,
        // not from `element_invalidated`.
        |_, _, _| false,
        no_order,
        false,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(commands, vec![MutationCommand::RemoveEdge { id: 0 }]);
    assert_eq!(
        *fix_targets.borrow(),
        vec![0],
        "only the shared element e0 is fixed; both groups' budgets retire from that single call"
    );
}

#[test]
fn multi_target_falls_through_to_next_candidate_when_first_nested_call_fails() {
    // group = [e0, e1] to_remove=1. Nested strategy fails for e0, succeeds for e1.
    let maze = empty_maze();
    let mut rng = MazeRng::seed_from_u64(1);
    let params = crate::repair::params::build_params(&[], None);

    struct FailForZero;
    impl<T: Tessellation> RepairStrategy<T, InvalidOneWayIssue> for FailForZero {
        fn strategy_id(&self) -> &'static str {
            "fail_for_zero_stub"
        }
        fn apply(
            &self,
            issue: &InvalidOneWayIssue,
            _maze: &Maze<T>,
            _rng: &mut dyn RngCore,
            _params: &StrategyParams,
            _preset_state: &PresetState,
            _nested: &[NestedStrategyConfig<T>],
        ) -> (RepairResult, Vec<MutationCommand>) {
            if issue.invalid[0] == 0 {
                (RepairResult::Failed, vec![])
            } else {
                (
                    RepairResult::Fixed { score: None },
                    vec![MutationCommand::RemoveEdge {
                        id: issue.invalid[0],
                    }],
                )
            }
        }
    }
    crate::impl_erased_repair_strategy!(FailForZero, InvalidOneWayIssue);
    let cfg = NestedStrategyConfig {
        slot: &TEST_SLOT,
        strategy: Box::new(FailForZero),
        param_overrides: HashMap::new(),
        nested: vec![],
    };
    let groups = vec![(vec![0_usize, 1_usize], 1_u32)];
    let (result, commands) = multi_target_group_select_apply::<SquareTessellation, TestKind>(
        &groups,
        &HashMap::new(),
        &maze,
        &mut rng,
        &PresetState::empty(),
        |e, others| Some((&cfg, &params, one_way_issue("c", e, others))),
        |_, _, _| false,
        no_order,
        false,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(commands, vec![MutationCommand::RemoveEdge { id: 1 }]);
}
